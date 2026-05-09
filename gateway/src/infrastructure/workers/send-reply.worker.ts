import { Queue, Worker, Job } from 'bullmq';
import { getDatabase } from '../../infrastructure/database/connection.js';
import { EncryptionService } from '../../infrastructure/encryption/index.js';
import { ConnectionRepository } from '../../domain/connectors/connection.repository.js';
import { EmailRepository } from '../../domain/connectors/email.repository.js';
import { GmailAdapter } from '../../domain/connectors/gmail.adapter.js';
import { loadConfig } from '../../config/index.js';
import { emitToUser } from '../socket/websocket.js';
import { logger } from '../../shared/logger.js';

const QUEUE_NAME = 'send-reply';

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

export function getSendReplyQueue(): Queue {
  if (_queue) return _queue;

  _queue = new Queue(QUEUE_NAME, {
    connection: getBullMQConnection() as any,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    },
  });
  _queue.on('error', (err) => {
    logger.error({ err }, 'Send reply queue Redis error');
  });
  return _queue;
}

export interface SendReplyJobData {
  draftId: string;
  threadId: string;
  userId: string;
  correlationId: string;
}

/**
 * Enqueue a send-reply job.
 * Uses draftId as the dedup key for idempotency.
 */
export async function enqueueSendReply(data: SendReplyJobData): Promise<string> {
  const queue = getSendReplyQueue();
  const job = await queue.add('send', data, {
    jobId: `send-reply-${data.draftId}`, // Idempotency: only one send per draft
  });
  logger.info({ jobId: job.id, draftId: data.draftId }, 'Send reply job enqueued');
  return job.id!;
}

/**
 * Start the BullMQ worker that processes send-reply jobs.
 * Called once at gateway startup.
 */
export function startSendReplyWorker(): Worker {
  const config = loadConfig();

  const worker = new Worker<SendReplyJobData>(
    QUEUE_NAME,
    async (job: Job<SendReplyJobData>) => {
      const { draftId, threadId, userId, correlationId } = job.data;
      const log = logger.child({ correlationId, draftId, threadId, userId, jobId: job.id });

      log.info('Send reply job started');
      emitToUser(userId, 'draft:sending', { draftId, threadId, correlationId });

      const db = getDatabase();
      const encryption = new EncryptionService(config.SECRET_ENCRYPTION_KEY);
      const connectionRepo = new ConnectionRepository(db);
      const emailRepo = new EmailRepository(db);

      // 1. Load draft and verify it's approved
      const draft = await db('drafts').where({ id: draftId }).first();
      if (!draft) {
        log.error('Draft not found');
        throw new Error(`Draft ${draftId} not found`);
      }
      if (draft.status !== 'approved') {
        log.error({ status: draft.status }, 'Draft is not in approved state');
        throw new Error(`Draft ${draftId} is not approved (status: ${draft.status})`);
      }

      // 2. Load thread to get external thread ID
      const thread = await emailRepo.findThreadById(threadId);
      if (!thread) {
        throw new Error(`Thread ${threadId} not found`);
      }

      // 3. Load connection & decrypt tokens
      const connection = await connectionRepo.findByUserAndType(userId, 'gmail');
      if (!connection) {
        throw new Error('Gmail connection not found');
      }

      const accessToken = encryption.decrypt(connection.encryptedAccessToken);
      const refreshToken = encryption.decrypt(connection.encryptedRefreshToken);

      // 4. Create Gmail adapter
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

      // 5. Send via Gmail — prefer sending the Gmail draft if it exists
      let externalMessageId: string;

      if (draft.external_draft_id) {
        // Use Gmail's native drafts.send() for cleanest threading
        log.info({ externalDraftId: draft.external_draft_id }, 'Sending via Gmail drafts.send()');
        externalMessageId = await adapter.sendGmailDraft(draft.external_draft_id);
      } else {
        // Fallback: compose and send raw message
        log.info('No Gmail draft found, sending via raw message');
        const messages = await emailRepo.findMessagesByThread(threadId);
        const latestMessage = messages[messages.length - 1];

        const content = draft.current_content || draft.generated_content;
        const subject = thread.subject ? `Re: ${thread.subject.replace(/^Re:\s*/i, '')}` : 'Re:';

        const userEmail = (connection.connectorMetadata as any)?.email || '';
        const recipientEmail = latestMessage?.fromAddress || '';
        const toAddresses = recipientEmail && recipientEmail.toLowerCase() !== userEmail.toLowerCase()
          ? [recipientEmail]
          : (latestMessage?.toAddresses || []);

        externalMessageId = await adapter.sendReply({
          threadId: thread.externalThreadId,
          to: toAddresses,
          subject,
          body: content,
          inReplyTo: latestMessage?.externalMessageId,
          references: latestMessage?.externalMessageId,
        });
      }

      log.info({ externalMessageId }, 'Reply sent successfully via Gmail');

      // 6. Update draft status to 'sent' and clear external_draft_id (it no longer exists after send)
      await db('drafts').where({ id: draftId }).update({
        status: 'sent',
        external_draft_id: null,
        updated_at: new Date(),
      });

      // 7. Record send attempt
      await db('send_attempts').insert({
        draft_id: draftId,
        idempotency_key: `send-${draftId}-${job.attemptsMade + 1}`,
        status: 'delivered',
        external_message_id: externalMessageId,
        attempt_number: job.attemptsMade + 1,
        queued_at: new Date(job.timestamp || Date.now()),
        started_at: new Date(job.processedOn || Date.now()),
        completed_at: new Date(),
      });

      emitToUser(userId, 'send:success', { draftId, threadId, correlationId, externalMessageId });
      return { externalMessageId };
    },
    {
      connection: getBullMQConnection() as any,
      concurrency: 3,
      limiter: {
        max: 5,
        duration: 1000, // 5 sends per second max
      },
    },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Send reply job completed');
  });

  worker.on('failed', async (job, err) => {
    logger.error({ jobId: job?.id, error: err.message }, 'Send reply job failed');
    if (job) {
      const db = getDatabase();
      const { draftId, userId, threadId, correlationId } = job.data;
      
      emitToUser(userId, 'send:failed', { draftId, threadId, correlationId, error: err.message });

      // Record failed attempt
      await db('send_attempts').insert({
        draft_id: job.data.draftId,
        idempotency_key: `send-${job.data.draftId}-fail-${job.attemptsMade}`,
        status: 'failed',
        error_message: err.message,
        attempt_number: job.attemptsMade,
        queued_at: new Date(job.timestamp || Date.now()),
        started_at: new Date(job.processedOn || Date.now()),
        completed_at: new Date(),
      });
    }
  });
  worker.on('error', (err) => {
    logger.error({ err }, 'Send reply worker Redis error');
  });

  logger.info('Send reply worker started');
  return worker;
}
