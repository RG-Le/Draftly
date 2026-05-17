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
   * Fetch recent threads page-by-page and store them.
   *
   * @param maxResults     Total threads to sync (caps the loop).
   * @param daysBack       Only fetch threads from the last N days (1–15). 0 = no date filter.
   * @param onPageSynced   Called after each page is saved to DB with the DB UUIDs of saved threads.
   *                       Use this to dispatch triage per-page so classifications start while Gmail
   *                       is still being fetched (rather than waiting for all threads to finish).
   *
   * Within each page, thread detail calls are made IN PARALLEL (capped at 20 per page) which
   * reduces fetch time from O(n × serial_latency) to O(pages × max_latency_per_page).
   */
  async syncRecentThreads(
    maxResults = 20,
    daysBack = 1,
    onPageSynced?: (dbThreadIds: string[]) => Promise<void>,
  ): Promise<{ synced: number; messages: number }> {
    let synced = 0;
    let totalMessages = 0;

    const queryParts = ['in:inbox'];
    if (daysBack > 0) {
      const afterEpochSeconds = Math.floor((Date.now() - daysBack * 86_400_000) / 1000);
      queryParts.push(`after:${afterEpochSeconds}`);
    }
    const q = queryParts.join(' ');

    let pageToken: string | undefined;
    const processedGmailIds = new Set<string>();

    do {
      // Fetch at most 20 stubs per page — we parallelise detail calls within each page,
      // and Gmail's default quota is 250 units/s; threads.get costs 5 units so 20 parallel
      // calls = 100 units, well within quota.
      // maxResults=0 means no limit (fetch all threads in the time window)
      const pageSize = maxResults > 0 ? Math.min(maxResults - synced, 20) : 20;
      if (pageSize <= 0) break;

      const listRes = await this.gmail.users.threads.list({
        userId: 'me',
        maxResults: pageSize,
        q,
        ...(pageToken ? { pageToken } : {}),
      });

      const stubs = (listRes.data.threads || []).filter(
        (s) => s.id && !processedGmailIds.has(s.id),
      );
      if (stubs.length === 0) break;
      stubs.forEach((s) => processedGmailIds.add(s.id!));

      // Fetch thread METADATA only for this page IN PARALLEL (10-50x faster than 'full')
      // Body content is fetched on-demand later when needed (thread view, draft generation)
      const detailResults = await Promise.allSettled(
        stubs.map((stub) =>
          this.gmail.users.threads.get({ userId: 'me', id: stub.id!, format: 'metadata' }),
        ),
      );

      const pageDbThreadIds: string[] = [];

      for (let i = 0; i < detailResults.length; i++) {
        const result = detailResults[i];
        if (result.status === 'rejected') {
          logger.warn({ threadId: stubs[i].id, error: result.reason?.message }, 'Failed to fetch thread detail, skipping');
          continue;
        }

        const threadData = result.value.data;
        const messages = threadData.messages || [];
        const firstMessage = messages[0];
        const lastMessage = messages[messages.length - 1];

        const subject = this.getHeader(firstMessage, 'Subject');
        const participants = this.extractParticipants(messages);
        const lastMessageAt = lastMessage?.internalDate
          ? new Date(parseInt(lastMessage.internalDate, 10))
          : null;

        try {
          const dbThread = await this.emailRepo.upsertThread({
            connectionId: this.connectionId,
            externalThreadId: stubs[i].id!,
            subject,
            participants,
            messageCount: messages.length,
            lastMessageAt,
            syncStatus: 'synced',
          });
          synced++;
          pageDbThreadIds.push(dbThread.id);

          for (const msg of messages) {
            if (!msg.id) continue;

            const fromHeader = this.getHeader(msg, 'From') || '';
            const toHeader = this.getHeader(msg, 'To') || '';
            const ccHeader = this.getHeader(msg, 'Cc');
            const msgSubject = this.getHeader(msg, 'Subject');
            const receivedAt = msg.internalDate ? new Date(parseInt(msg.internalDate, 10)) : new Date();
            const labels = msg.labelIds || [];
            const isSentByUser = labels.includes('SENT');
            const isDraft = labels.includes('DRAFT');

            // Metadata-first: body is NOT available in metadata format.
            // It will be fetched on-demand via fetchThreadFull() when needed
            // (thread detail view or draft generation).
            await this.emailRepo.createMessage({
              threadId: dbThread.id,
              externalMessageId: msg.id,
              fromAddress: fromHeader,
              toAddresses: this.parseAddressList(toHeader),
              ccAddresses: ccHeader ? this.parseAddressList(ccHeader) : null,
              subject: msgSubject,
              bodyText: null,
              bodyHtml: null,
              rawHeaders: null,
              receivedAt,
              isSentByUser,
              isDraft,
            });
            totalMessages++;
          }
        } catch (err: any) {
          logger.warn({ threadId: stubs[i].id, error: err.message }, 'Failed to save thread, skipping');
        }
      }

      // Fire per-page triage dispatch so Celery can start classifying immediately
      // rather than waiting for ALL pages to finish
      if (onPageSynced && pageDbThreadIds.length > 0) {
        await onPageSynced(pageDbThreadIds);
      }

      pageToken = listRes.data.nextPageToken ?? undefined;
    } while (pageToken && (maxResults === 0 || synced < maxResults));

    return { synced, messages: totalMessages };
  }

  /**
   * Fetch the full thread body from Gmail and update existing messages in DB.
   *
   * This is the on-demand body fetch used by the metadata-first sync architecture.
   * Called when a user views a thread detail or before draft generation.
   * Idempotent — safe to call multiple times (will overwrite body content).
   *
   * @param externalThreadId  The Gmail thread ID (not our internal UUID)
   * @returns The number of messages updated with body content
   */
  async fetchThreadFull(externalThreadId: string): Promise<number> {
    logger.info({ externalThreadId }, 'Fetching full thread body on-demand');

    const res = await this.gmail.users.threads.get({
      userId: 'me',
      id: externalThreadId,
      format: 'full',
    });

    const messages = res.data.messages || [];
    let updated = 0;

    for (const msg of messages) {
      if (!msg.id) continue;

      const { bodyText, bodyHtml } = this.extractBody(msg.payload);

      // Only update if we actually got body content
      if (bodyText || bodyHtml) {
        await this.emailRepo.updateMessageBody(msg.id, bodyText, bodyHtml);
        updated++;
      }
    }

    logger.info({ externalThreadId, messagesUpdated: updated }, 'Full thread body fetched and saved');
    return updated;
  }

  /**
   * Fetch the latest sent emails directly from Gmail, ignoring the date sync window.
   * This is used to bootstrap the AI profile generation if the user hasn't sent any emails
   * within the default 7-day sync window.
   * @param maxResults Number of sent threads to fetch
   */
  async fetchLatestSentEmails(maxResults = 5): Promise<number> {
    logger.info({ connectionId: this.connectionId }, 'Fetching latest sent emails for profile generation');
    const listRes = await this.gmail.users.threads.list({
      userId: 'me',
      maxResults,
      q: 'in:sent',
    });

    const stubs = listRes.data.threads || [];
    if (stubs.length === 0) return 0;

    let totalMessages = 0;

    for (const stub of stubs) {
      if (!stub.id) continue;
      
      try {
        const res = await this.gmail.users.threads.get({
          userId: 'me',
          id: stub.id,
          format: 'full',
        });

        const threadData = res.data;
        const messages = threadData.messages || [];
        const firstMessage = messages[0];
        const lastMessage = messages[messages.length - 1];

        const subject = this.getHeader(firstMessage, 'Subject');
        const participants = this.extractParticipants(messages);
        const lastMessageAt = lastMessage?.internalDate
          ? new Date(parseInt(lastMessage.internalDate, 10))
          : null;

        const dbThread = await this.emailRepo.upsertThread({
          connectionId: this.connectionId,
          externalThreadId: stub.id,
          subject,
          participants,
          messageCount: messages.length,
          lastMessageAt,
          syncStatus: 'synced',
        });

        for (const msg of messages) {
          if (!msg.id) continue;

          const fromHeader = this.getHeader(msg, 'From') || '';
          const toHeader = this.getHeader(msg, 'To') || '';
          const ccHeader = this.getHeader(msg, 'Cc');
          const msgSubject = this.getHeader(msg, 'Subject');
          const receivedAt = msg.internalDate ? new Date(parseInt(msg.internalDate, 10)) : new Date();
          const labels = msg.labelIds || [];
          const isSentByUser = labels.includes('SENT');
          const isDraft = labels.includes('DRAFT');
          
          const { bodyText, bodyHtml } = this.extractBody(msg.payload);

          await this.emailRepo.createMessage({
            threadId: dbThread.id,
            externalMessageId: msg.id,
            fromAddress: fromHeader,
            toAddresses: this.parseAddressList(toHeader),
            ccAddresses: ccHeader ? this.parseAddressList(ccHeader) : null,
            subject: msgSubject,
            bodyText: bodyText,
            bodyHtml: bodyHtml,
            rawHeaders: null,
            receivedAt,
            isSentByUser,
            isDraft,
          });
          
          if (isSentByUser && (bodyText || bodyHtml)) {
             // Ensure the body is updated if the message stub already existed without a body
             await this.emailRepo.updateMessageBody(msg.id, bodyText, bodyHtml);
          }
          totalMessages++;
        }
      } catch (err: any) {
        logger.warn({ threadId: stub.id, error: err.message }, 'Failed to save sent thread, skipping');
      }
    }
    return totalMessages;
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
