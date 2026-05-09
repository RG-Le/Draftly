import { google, gmail_v1 } from 'googleapis';
import { EncryptionService } from '../../infrastructure/encryption/index.js';
import { ConnectionRepository } from './connection.repository.js';
import { EmailRepository } from './email.repository.js';
import { logger } from '../../shared/logger.js';

/**
 * Gmail Adapter — translates Gmail API responses into our domain entities.
 *
 * Responsibilities:
 * 1. Refresh access tokens when expired (using encrypted refresh token)
 * 2. Fetch threads/messages from Gmail API
 * 3. Parse Gmail message payloads into EmailMessage entities
 * 4. Send emails via Gmail API
 */
export class GmailAdapter {
  private gmail: gmail_v1.Gmail;

  constructor(
    private readonly connectionId: string,
    _userId: string,
    private readonly encryption: EncryptionService,
    private readonly connectionRepo: ConnectionRepository,
    private readonly emailRepo: EmailRepository,
    accessToken: string,
    refreshToken: string,
    clientId: string,
    clientSecret: string,
  ) {
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    // Auto-refresh handler: when token refreshes, persist the new encrypted token
    oauth2Client.on('tokens', async (tokens) => {
      if (tokens.access_token) {
        const encryptedAccess = this.encryption.encrypt(tokens.access_token);
        const expiresAt = new Date(tokens.expiry_date || Date.now() + 3600 * 1000);
        const encryptedRefresh = tokens.refresh_token
          ? this.encryption.encrypt(tokens.refresh_token)
          : undefined;

        await this.connectionRepo.updateTokens(
          this.connectionId,
          encryptedAccess,
          expiresAt,
          encryptedRefresh,
        );
        logger.info({ connectionId: this.connectionId }, 'Gmail tokens auto-refreshed and persisted');
      }
    });

    this.gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  }

  /**
   * Fetch recent threads (up to maxResults) and store them.
   * Returns the number of new/updated threads.
   */
  async syncRecentThreads(maxResults = 20): Promise<{ synced: number; messages: number }> {
    let synced = 0;
    let totalMessages = 0;

    const listRes = await this.gmail.users.threads.list({
      userId: 'me',
      maxResults,
      q: 'in:inbox',
    });

    const threads = listRes.data.threads || [];

    for (const threadStub of threads) {
      if (!threadStub.id) continue;

      try {
        const threadRes = await this.gmail.users.threads.get({
          userId: 'me',
          id: threadStub.id,
          format: 'full',
        });

        const threadData = threadRes.data;
        const messages = threadData.messages || [];
        const firstMessage = messages[0];
        const lastMessage = messages[messages.length - 1];

        // Extract subject & participants
        const subject = this.getHeader(firstMessage, 'Subject');
        const participants = this.extractParticipants(messages);
        const lastMessageAt = lastMessage?.internalDate
          ? new Date(parseInt(lastMessage.internalDate, 10))
          : null;

        // Upsert thread
        const dbThread = await this.emailRepo.upsertThread({
          connectionId: this.connectionId,
          externalThreadId: threadStub.id,
          subject,
          participants,
          messageCount: messages.length,
          lastMessageAt,
          syncStatus: 'synced',
        });
        synced++;

        // Upsert individual messages
        for (const msg of messages) {
          if (!msg.id) continue;

          const fromHeader = this.getHeader(msg, 'From') || '';
          const toHeader = this.getHeader(msg, 'To') || '';
          const ccHeader = this.getHeader(msg, 'Cc');
          const msgSubject = this.getHeader(msg, 'Subject');
          const receivedAt = msg.internalDate ? new Date(parseInt(msg.internalDate, 10)) : new Date();

          // Determine if sent by user (check SENT label)
          const labels = msg.labelIds || [];
          const isSentByUser = labels.includes('SENT');

          const { bodyText, bodyHtml } = this.extractBody(msg.payload);

          await this.emailRepo.createMessage({
            threadId: dbThread.id,
            externalMessageId: msg.id,
            fromAddress: fromHeader,
            toAddresses: this.parseAddressList(toHeader),
            ccAddresses: ccHeader ? this.parseAddressList(ccHeader) : null,
            subject: msgSubject,
            bodyText,
            bodyHtml,
            rawHeaders: null, // Don't store raw headers to save space
            receivedAt,
            isSentByUser,
          });
          totalMessages++;
        }
      } catch (err: any) {
        logger.warn(
          { threadId: threadStub.id, error: err.message },
          'Failed to sync thread, skipping',
        );
      }
    }

    return { synced, messages: totalMessages };
  }

  /**
   * Send an email reply on a thread.
   */
  async sendReply(params: {
    threadId: string;
    to: string[];
    cc?: string[];
    subject: string;
    body: string;
    inReplyTo?: string;
    references?: string;
  }): Promise<string> {
    const encodedMessage = this.buildRawMessage(params);

    const res = await this.gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        threadId: params.threadId,
        raw: encodedMessage,
      },
    });

    return res.data.id || '';
  }

  /**
   * Create a draft in the user's Gmail account.
   * Returns the Gmail-side draft ID.
   */
  async createGmailDraft(params: {
    threadId: string;
    to: string[];
    cc?: string[];
    subject: string;
    body: string;
    inReplyTo?: string;
    references?: string;
  }): Promise<string> {
    const raw = this.buildRawMessage(params);

    const res = await this.gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          threadId: params.threadId,
          raw,
        },
      },
    });

    return res.data.id || '';
  }

  /**
   * Update an existing Gmail draft with new content.
   */
  async updateGmailDraft(externalDraftId: string, params: {
    threadId: string;
    to: string[];
    cc?: string[];
    subject: string;
    body: string;
    inReplyTo?: string;
    references?: string;
  }): Promise<string> {
    const raw = this.buildRawMessage(params);

    const res = await this.gmail.users.drafts.update({
      userId: 'me',
      id: externalDraftId,
      requestBody: {
        message: {
          threadId: params.threadId,
          raw,
        },
      },
    });

    return res.data.id || '';
  }

  /**
   * Delete a Gmail draft (e.g. when user rejects it in our UI).
   */
  async deleteGmailDraft(externalDraftId: string): Promise<void> {
    try {
      await this.gmail.users.drafts.delete({
        userId: 'me',
        id: externalDraftId,
      });
    } catch (err: any) {
      // If the draft was already deleted or not found, that's OK
      if (err?.code === 404) {
        logger.warn({ externalDraftId }, 'Gmail draft already deleted or not found');
        return;
      }
      throw err;
    }
  }

  /**
   * Send an existing Gmail draft. This is the cleanest way to send
   * because Gmail preserves all internal metadata and threading.
   * Returns the sent message ID.
   */
  async sendGmailDraft(externalDraftId: string): Promise<string> {
    const res = await this.gmail.users.drafts.send({
      userId: 'me',
      requestBody: {
        id: externalDraftId,
      },
    });

    return res.data.id || '';
  }

  // ===== Helpers =====

  /**
   * Build a base64url-encoded RFC 2822 message for Gmail API.
   */
  private buildRawMessage(params: {
    to: string[];
    cc?: string[];
    subject: string;
    body: string;
    inReplyTo?: string;
    references?: string;
  }): string {
    const headers = [
      `To: ${params.to.join(', ')}`,
      params.cc?.length ? `Cc: ${params.cc.join(', ')}` : null,
      `Subject: ${params.subject}`,
      `Content-Type: text/plain; charset=UTF-8`,
      params.inReplyTo ? `In-Reply-To: ${params.inReplyTo}` : null,
      params.references ? `References: ${params.references}` : null,
    ]
      .filter(Boolean)
      .join('\r\n');

    const rawMessage = `${headers}\r\n\r\n${params.body}`;
    return Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  private getHeader(message: gmail_v1.Schema$Message | undefined, name: string): string | null {
    if (!message?.payload?.headers) return null;
    const header = message.payload.headers.find(
      (h) => h.name?.toLowerCase() === name.toLowerCase(),
    );
    return header?.value || null;
  }

  private extractParticipants(messages: gmail_v1.Schema$Message[]): Array<{ email: string; name?: string }> {
    const seen = new Map<string, string>();
    for (const msg of messages) {
      for (const headerName of ['From', 'To', 'Cc']) {
        const val = this.getHeader(msg, headerName);
        if (val) {
          for (const addr of this.parseAddressList(val)) {
            if (!seen.has(addr)) {
              seen.set(addr, addr);
            }
          }
        }
      }
    }
    return Array.from(seen.keys()).map((email) => ({ email }));
  }

  private parseAddressList(header: string): string[] {
    return header
      .split(',')
      .map((addr) => {
        const match = addr.match(/<(.+?)>/);
        return (match ? match[1] : addr).trim().toLowerCase();
      })
      .filter(Boolean);
  }

  private extractBody(payload: gmail_v1.Schema$MessagePart | undefined): {
    bodyText: string | null;
    bodyHtml: string | null;
  } {
    let bodyText: string | null = null;
    let bodyHtml: string | null = null;

    if (!payload) return { bodyText, bodyHtml };

    const decodeBase64 = (data: string) =>
      Buffer.from(data, 'base64').toString('utf-8');

    // Simple single-part message
    if (payload.body?.data) {
      if (payload.mimeType === 'text/plain') {
        bodyText = decodeBase64(payload.body.data);
      } else if (payload.mimeType === 'text/html') {
        bodyHtml = decodeBase64(payload.body.data);
      }
    }

    // Multipart message — recurse into parts
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data && !bodyText) {
          bodyText = decodeBase64(part.body.data);
        } else if (part.mimeType === 'text/html' && part.body?.data && !bodyHtml) {
          bodyHtml = decodeBase64(part.body.data);
        } else if (part.parts) {
          // Nested multipart (e.g. multipart/alternative inside multipart/mixed)
          const nested = this.extractBody(part);
          if (!bodyText && nested.bodyText) bodyText = nested.bodyText;
          if (!bodyHtml && nested.bodyHtml) bodyHtml = nested.bodyHtml;
        }
      }
    }

    return { bodyText, bodyHtml };
  }
}
