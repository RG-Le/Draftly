import { Knex } from 'knex';
import { EmailThread, EmailMessage } from '../entities/index.js';

/**
 * Repository for email_threads and email_messages tables.
 */
export class EmailRepository {
  constructor(private readonly db: Knex) {}

  // ========== Threads ==========

  async findThreadByExternalId(connectionId: string, externalThreadId: string): Promise<EmailThread | null> {
    const row = await this.db('email_threads')
      .where({ connection_id: connectionId, external_thread_id: externalThreadId })
      .first();
    return row ? this.mapThread(row) : null;
  }

  async findThreadsByConnection(connectionId: string, limit = 50, offset = 0): Promise<EmailThread[]> {
    const rows = await this.db('email_threads')
      .where({ connection_id: connectionId })
      .orderBy('last_message_at', 'desc')
      .limit(limit)
      .offset(offset);
    return rows.map((r: any) => this.mapThread(r));
  }

  async findInboxThreads(params: {
    connectionId: string;
    category?: string;
    limit?: number;
    offset?: number;
  }): Promise<EmailThread[]> {
    const { connectionId, category, limit = 50, offset = 0 } = params;

    let query = this.db('email_threads as t')
      .select(
        't.*',
        'tr.id as triage_id',
        'tr.classification',
        'tr.confidence as triage_confidence',
        'tr.reasoning as triage_reasoning',
        'tr.method as triage_method',
        'tr.created_at as triage_created_at',
        'd.id as draft_id',
        'd.status as draft_status',
        'd.updated_at as draft_updated_at'
      )
      .leftJoin('triage_results as tr', 't.id', 'tr.thread_id')
      .leftJoin('drafts as d', 't.id', 'd.thread_id')
      .where('t.connection_id', connectionId)
      .orderBy('t.last_message_at', 'desc')
      .limit(limit)
      .offset(offset);

    if (category) {
      query = query.where('tr.classification', category);
    }

    const rows = await query;
    return rows.map((r: any) => {
      const thread = this.mapThread(r);
      if (r.triage_id) {
        thread.triage = {
          id: r.triage_id,
          threadId: r.id,
          classification: r.classification,
          confidence: r.triage_confidence,
          reasoning: r.triage_reasoning,
          method: r.triage_method,
          llmMetadata: null,
          createdAt: r.triage_created_at
        };
      }
      if (r.draft_id) {
        thread.draft = {
          id: r.draft_id,
          status: r.draft_status,
          updatedAt: r.draft_updated_at
        } as any; // Partial draft object for list view
      }
      return thread;
    });
  }

  async findThreadById(threadId: string): Promise<EmailThread | null> {
    const row = await this.db('email_threads').where({ id: threadId }).first();
    return row ? this.mapThread(row) : null;
  }

  async findTriageByThreadId(threadId: string): Promise<any | null> {
    const row = await this.db('triage_results').where({ thread_id: threadId }).first();
    return row || null;
  }

  async findLatestDraftByThreadId(threadId: string): Promise<any | null> {
    const row = await this.db('drafts')
      .where({ thread_id: threadId })
      .orderBy('created_at', 'desc')
      .first();
    return row || null;
  }

  async upsertThread(thread: {
    connectionId: string;
    externalThreadId: string;
    subject: string | null;
    participants: Array<{ email: string; name?: string }> | null;
    messageCount: number;
    lastMessageAt: Date | null;
    syncStatus: string;
  }): Promise<EmailThread> {
    const existing = await this.findThreadByExternalId(thread.connectionId, thread.externalThreadId);

    if (existing) {
      const [updated] = await this.db('email_threads')
        .where({ id: existing.id })
        .update({
          subject: thread.subject,
          participants: thread.participants ? JSON.stringify(thread.participants) : null,
          message_count: thread.messageCount,
          last_message_at: thread.lastMessageAt,
          sync_status: thread.syncStatus,
          updated_at: new Date(),
        })
        .returning('*');
      return this.mapThread(updated);
    }

    const [created] = await this.db('email_threads')
      .insert({
        connection_id: thread.connectionId,
        external_thread_id: thread.externalThreadId,
        subject: thread.subject,
        participants: thread.participants ? JSON.stringify(thread.participants) : null,
        message_count: thread.messageCount,
        last_message_at: thread.lastMessageAt,
        sync_status: thread.syncStatus,
      })
      .returning('*');
    return this.mapThread(created);
  }

  // ========== Messages ==========

  async findMessageByExternalId(externalMessageId: string): Promise<EmailMessage | null> {
    const row = await this.db('email_messages')
      .where({ external_message_id: externalMessageId })
      .first();
    return row ? this.mapMessage(row) : null;
  }

  async findMessagesByThread(threadId: string): Promise<EmailMessage[]> {
    const rows = await this.db('email_messages')
      .where({ thread_id: threadId })
      .orderBy('received_at', 'asc');
    return rows.map((r: any) => this.mapMessage(r));
  }

  async createMessage(msg: {
    threadId: string;
    externalMessageId: string;
    fromAddress: string;
    toAddresses: string[];
    ccAddresses: string[] | null;
    subject: string | null;
    bodyText: string | null;
    bodyHtml: string | null;
    rawHeaders: Record<string, unknown> | null;
    receivedAt: Date;
    isSentByUser: boolean;
  }): Promise<EmailMessage> {
    // Skip if message already exists (idempotent)
    const existing = await this.findMessageByExternalId(msg.externalMessageId);
    if (existing) return existing;

    const [created] = await this.db('email_messages')
      .insert({
        thread_id: msg.threadId,
        external_message_id: msg.externalMessageId,
        from_address: msg.fromAddress,
        to_addresses: JSON.stringify(msg.toAddresses),
        cc_addresses: msg.ccAddresses ? JSON.stringify(msg.ccAddresses) : null,
        subject: msg.subject,
        body_text: msg.bodyText,
        body_html: msg.bodyHtml,
        raw_headers: msg.rawHeaders ? JSON.stringify(msg.rawHeaders) : null,
        received_at: msg.receivedAt,
        is_sent_by_user: msg.isSentByUser,
      })
      .returning('*');
    return this.mapMessage(created);
  }

  /**
   * Update the body content of an existing message (used by metadata-first on-demand fetch).
   * Identified by external_message_id (Gmail message ID).
   * Idempotent — safe to call multiple times.
   */
  async updateMessageBody(
    externalMessageId: string,
    bodyText: string | null,
    bodyHtml: string | null,
  ): Promise<void> {
    await this.db('email_messages')
      .where({ external_message_id: externalMessageId })
      .update({
        body_text: bodyText,
        body_html: bodyHtml,
      });
  }

  // ========== Mappers ==========

  private mapThread(row: any): EmailThread {
    return {
      id: row.id,
      connectionId: row.connection_id,
      externalThreadId: row.external_thread_id,
      subject: row.subject,
      participants: typeof row.participants === 'string' ? JSON.parse(row.participants) : row.participants,
      messageCount: row.message_count,
      lastMessageAt: row.last_message_at,
      syncStatus: row.sync_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapMessage(row: any): EmailMessage {
    return {
      id: row.id,
      threadId: row.thread_id,
      externalMessageId: row.external_message_id,
      fromAddress: row.from_address,
      toAddresses: typeof row.to_addresses === 'string' ? JSON.parse(row.to_addresses) : row.to_addresses,
      ccAddresses: row.cc_addresses
        ? typeof row.cc_addresses === 'string' ? JSON.parse(row.cc_addresses) : row.cc_addresses
        : null,
      subject: row.subject,
      bodyText: row.body_text,
      bodyHtml: row.body_html,
      rawHeaders: row.raw_headers
        ? typeof row.raw_headers === 'string' ? JSON.parse(row.raw_headers) : row.raw_headers
        : null,
      receivedAt: row.received_at,
      isSentByUser: row.is_sent_by_user,
      createdAt: row.created_at,
    };
  }
}
