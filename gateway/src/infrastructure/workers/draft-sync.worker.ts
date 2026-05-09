import { Queue, Worker, Job } from 'bullmq';
import { getDatabase } from '../../infrastructure/database/connection.js';
import { EncryptionService } from '../../infrastructure/encryption/index.js';
import { ConnectionRepository } from '../../domain/connectors/connection.repository.js';
import { EmailRepository } from '../../domain/connectors/email.repository.js';
import { GmailAdapter } from '../../domain/connectors/gmail.adapter.js';
import { loadConfig } from '../../config/index.js';
import { logger } from '../../shared/logger.js';

const QUEUE_NAME = 'draft-sync';

let _queue: Queue | null = null;

/** BullMQ needs its own Redis connections with maxRetriesPerRequest=null */
function getBullMQConnection() {
  const config = loadConfig();
  return {
    url: config.REDIS_URL,
    maxRetriesPerRequest: null,
    family: 4,
    connectTimeout: 10000,
    keepAlive: 30000,
    retryStrategy(times: number) {
      return Math.min(times * 200, 3000);
    },
  };
}

export function getDraftSyncQueue(): Queue {
  if (_queue) return _queue;

  _queue = new Queue(QUEUE_NAME, {
    connection: getBullMQConnection() as any,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    },
  });
  _queue.on('error', (err) => {
    logger.error({ err }, 'Draft sync queue Redis error');
  });
  return _queue;
}

export type DraftSyncAction = 'create' | 'update' | 'delete';

export interface DraftSyncJobData {
  draftId: string;
  threadId: string;
  userId: string;
  correlationId: string;
  action: DraftSyncAction;
}

/**
 * Enqueue a draft-sync job.
 * Uses draftId + action as the dedup key.
 */
export async function enqueueDraftSync(data: DraftSyncJobData): Promise<string> {
  const queue = getDraftSyncQueue();
  const job = await queue.add('sync', data, {
    jobId: `draft-sync-${data.action}-${data.draftId}`,
  });
  logger.info({ jobId: job.id, draftId: data.draftId, action: data.action }, 'Draft sync job enqueued');
  return job.id!;
}

/**
 * Build a GmailAdapter for a given user.
 * Shared helper so we don't duplicate this across workers.
 */
async function buildGmailAdapter(userId: string) {
  const config = loadConfig();
  const db = getDatabase();
  const encryption = new EncryptionService(config.SECRET_ENCRYPTION_KEY);
  const connectionRepo = new ConnectionRepository(db);
  const emailRepo = new EmailRepository(db);

  const connection = await connectionRepo.findByUserAndType(userId, 'gmail');
  if (!connection) {
    throw new Error('Gmail connection not found');
  }

  const accessToken = encryption.decrypt(connection.encryptedAccessToken);
  const refreshToken = encryption.decrypt(connection.encryptedRefreshToken);

  const adapter = new GmailAdapter(
    connection.id,
    userId,
    encryption,
    connectionRepo,
    emailRepo,
    accessToken,
    refreshToken,
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
  );

  return { adapter, connection, emailRepo, db };
}

/**
 * Start the BullMQ worker that syncs drafts to/from Gmail.
 * Called once at gateway startup.
 */
export function startDraftSyncWorker(): Worker {
  const worker = new Worker<DraftSyncJobData>(
    QUEUE_NAME,
    async (job: Job<DraftSyncJobData>) => {
      const { draftId, threadId, userId, correlationId, action } = job.data;
      const log = logger.child({ correlationId, draftId, threadId, userId, jobId: job.id, action });

      log.info('Draft sync job started');

      const { adapter, emailRepo, db } = await buildGmailAdapter(userId);

      // Load draft from DB
      const draft = await db('drafts').where({ id: draftId }).first();
      if (!draft) {
        log.error('Draft not found');
        throw new Error(`Draft ${draftId} not found`);
      }

      // Load thread to get external thread ID and latest message for reply headers
      const thread = await emailRepo.findThreadById(threadId);
      if (!thread) {
        throw new Error(`Thread ${threadId} not found`);
      }

      if (action === 'create') {
        // Get latest message for reply headers
        const messages = await emailRepo.findMessagesByThread(threadId);
        const latestMessage = messages[messages.length - 1];

        const content = draft.current_content || draft.generated_content;
        const subject = thread.subject ? `Re: ${thread.subject.replace(/^Re:\s*/i, '')}` : 'Re:';

        // Determine recipient
        const connection = await new ConnectionRepository(db).findByUserAndType(userId, 'gmail');
        const userEmail = (connection?.connectorMetadata as any)?.email || '';
        const recipientEmail = latestMessage?.fromAddress || '';
        const toAddresses = recipientEmail && recipientEmail.toLowerCase() !== userEmail.toLowerCase()
          ? [recipientEmail]
          : (latestMessage?.toAddresses || []);

        const externalDraftId = await adapter.createGmailDraft({
          threadId: thread.externalThreadId,
          to: toAddresses,
          subject,
          body: content,
          inReplyTo: latestMessage?.externalMessageId,
          references: latestMessage?.externalMessageId,
        });

        if (!externalDraftId) {
          log.error('Gmail createGmailDraft returned an empty ID — draft NOT saved to Gmail. Check OAuth scopes.');
          throw new Error('Gmail draft creation returned empty ID');
        }

        // Store the external draft ID in our DB
        await db('drafts').where({ id: draftId }).update({
          external_draft_id: externalDraftId,
          updated_at: new Date(),
        });

        log.info({ externalDraftId }, 'Draft synced to Gmail');
        return { externalDraftId };
      }

      if (action === 'update') {
        if (!draft.external_draft_id) {
          log.warn('No external_draft_id — cannot update Gmail draft, creating instead');
          // Fall through to create if no external draft exists
          const newJob = await enqueueDraftSync({ ...job.data, action: 'create' });
          return { fallbackJobId: newJob };
        }

        const messages = await emailRepo.findMessagesByThread(threadId);
        const latestMessage = messages[messages.length - 1];

        const content = draft.current_content || draft.generated_content;
        const subject = thread.subject ? `Re: ${thread.subject.replace(/^Re:\s*/i, '')}` : 'Re:';

        const connection = await new ConnectionRepository(db).findByUserAndType(userId, 'gmail');
        const userEmail = (connection?.connectorMetadata as any)?.email || '';
        const recipientEmail = latestMessage?.fromAddress || '';
        const toAddresses = recipientEmail && recipientEmail.toLowerCase() !== userEmail.toLowerCase()
          ? [recipientEmail]
          : (latestMessage?.toAddresses || []);

        await adapter.updateGmailDraft(draft.external_draft_id, {
          threadId: thread.externalThreadId,
          to: toAddresses,
          subject,
          body: content,
          inReplyTo: latestMessage?.externalMessageId,
          references: latestMessage?.externalMessageId,
        });

        log.info({ externalDraftId: draft.external_draft_id }, 'Gmail draft updated');
        return { externalDraftId: draft.external_draft_id };
      }

      if (action === 'delete') {
        if (!draft.external_draft_id) {
          log.warn('No external_draft_id — nothing to delete from Gmail');
          return { skipped: true };
        }

        await adapter.deleteGmailDraft(draft.external_draft_id);

        // Clear the external draft ID
        await db('drafts').where({ id: draftId }).update({
          external_draft_id: null,
          updated_at: new Date(),
        });

        log.info({ externalDraftId: draft.external_draft_id }, 'Gmail draft deleted');
        return { deleted: true };
      }

      throw new Error(`Unknown draft sync action: ${action}`);
    },
    {
      connection: getBullMQConnection() as any,
      concurrency: 5,
      limiter: {
        max: 10,
        duration: 1000, // 10 syncs per second max
      },
    },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Draft sync job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, error: err.message }, 'Draft sync job failed');
  });
  worker.on('error', (err) => {
    logger.error({ err }, 'Draft sync worker Redis error');
  });

  logger.info('Draft sync worker started');
  return worker;
}
