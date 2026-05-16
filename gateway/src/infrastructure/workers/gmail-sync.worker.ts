import { Queue, Worker, Job } from 'bullmq';
import { getDatabase } from '../../infrastructure/database/connection.js';
import { EncryptionService } from '../../infrastructure/encryption/index.js';
import { ConnectionRepository } from '../../domain/connectors/connection.repository.js';
import { EmailRepository } from '../../domain/connectors/email.repository.js';
import { GmailAdapter } from '../../domain/connectors/gmail.adapter.js';
import { CeleryBridge } from './celery-bridge.js';
import { loadConfig } from '../../config/index.js';
import { getRedis } from '../../infrastructure/redis/connection.js';
import { emitToUser } from '../socket/websocket.js';
import { logger } from '../../shared/logger.js';

const QUEUE_NAME = 'gmail-sync';

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

export function getGmailSyncQueue(): Queue {
  if (_queue) return _queue;

  _queue = new Queue(QUEUE_NAME, {
    connection: getBullMQConnection() as any,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });
  _queue.on('error', (err) => {
    logger.error({ err }, 'Gmail sync queue Redis error');
  });
  return _queue;
}

export interface GmailSyncJobData {
  connectionId: string;
  userId: string;
  correlationId: string;
  maxResults?: number;
  daysBack?: number;
}

/**
 * Enqueue a Gmail sync job.
 * Deduplicates by connectionId (only one active sync per connection).
 */
export async function enqueueGmailSync(data: GmailSyncJobData): Promise<string> {
  const queue = getGmailSyncQueue();
  const jobId = `gmail-sync-${data.connectionId}`;

  // Check if a job with this dedup ID is already active/waiting
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'waiting' || state === 'active' || state === 'delayed') {
      logger.warn(
        { jobId, connectionId: data.connectionId, state },
        'Gmail sync job deduplicated — existing job in progress, skipping re-queue',
      );
      return jobId;
    }
    // Remove completed/failed job so we can re-use the ID
    await existing.remove();
  }

  const job = await queue.add('sync', data, { jobId });
  logger.info(
    { jobId: job.id, connectionId: data.connectionId, userId: data.userId, correlationId: data.correlationId },
    'Gmail sync job enqueued',
  );
  return job.id!;
}

/**
 * Start the BullMQ worker that processes Gmail sync jobs.
 * Called once at gateway startup.
 */
export function startGmailSyncWorker(): Worker {
  const config = loadConfig();

  const worker = new Worker<GmailSyncJobData>(
    QUEUE_NAME,
    async (job: Job<GmailSyncJobData>) => {
      const { connectionId, userId, correlationId, maxResults, daysBack } = job.data;
      const log = logger.child({ correlationId, connectionId, userId, jobId: job.id });

      log.info({ maxResults: maxResults ?? 20, daysBack: daysBack ?? 1, attempt: job.attemptsMade + 1 }, 'Gmail sync job started');
      emitToUser(userId, 'sync:started', { connectionId, correlationId });

      const db = getDatabase();
      const encryption = new EncryptionService(config.SECRET_ENCRYPTION_KEY);
      const connectionRepo = new ConnectionRepository(db);
      const emailRepo = new EmailRepository(db);

      // 1. Load connection & decrypt tokens
      log.debug('Loading Gmail connection and decrypting tokens');
      const connection = await connectionRepo.findByUserAndType(userId, 'gmail');
      if (!connection) {
        log.error('No Gmail connection found for user — aborting sync');
        throw new Error('Gmail connection not found');
      }
      if (connection.status !== 'active') {
        log.error({ status: connection.status }, 'Gmail connection is not active — aborting sync');
        throw new Error(`Gmail connection status is '${connection.status}'`);
      }

      const accessToken = encryption.decrypt(connection.encryptedAccessToken);
      const refreshToken = encryption.decrypt(connection.encryptedRefreshToken);
      log.debug('Tokens decrypted successfully');

      // 2. Create Gmail adapter
      const adapter = new GmailAdapter(
        connectionId,
        userId,
        encryption,
        connectionRepo,
        emailRepo,
        accessToken,
        refreshToken,
        config.GOOGLE_CLIENT_ID,
        config.GOOGLE_CLIENT_SECRET,
      );

      // 3. Sync threads from Gmail API — with per-page triage dispatch
      //    Each page of ~20 threads is fetched in parallel, saved, then triage is dispatched
      //    immediately for that page. Celery starts classifying while the next page is being fetched.
      //    Smart daysBack: if last sync was within the requested range AND we have data, only fetch from last sync time.
      let safeDaysBack = Math.min(Math.max(daysBack ?? 7, 1), 15);
      
      // Only optimize if we actually have threads in DB (previous sync was successful with data)
      const existingThreadCount = await db('email_threads').where({ connection_id: connectionId }).count('id as count').first();
      const hasExistingData = parseInt((existingThreadCount as any)?.count || '0') > 0;
      
      if (hasExistingData && connection.lastSyncedAt) {
        const lastSyncMs = new Date(connection.lastSyncedAt).getTime();
        const requestedRangeMs = safeDaysBack * 86_400_000;
        const timeSinceLastSync = Date.now() - lastSyncMs;
        if (timeSinceLastSync < requestedRangeMs) {
          const daysSinceLastSync = Math.max(1, Math.ceil(timeSinceLastSync / 86_400_000));
          log.info({ originalDaysBack: safeDaysBack, optimizedDaysBack: daysSinceLastSync, lastSyncedAt: connection.lastSyncedAt }, 'Optimizing daysBack based on last sync time');
          safeDaysBack = daysSinceLastSync;
        }
      }
      log.info({ maxResults: maxResults ?? 20, daysBack: safeDaysBack, hasExistingData }, 'Calling Gmail API to sync threads');

      const redis = getRedis();
      const celeryBridge = new CeleryBridge(redis);
      let totalTriageBatches = 0;

      const onPageSynced = async (pageDbThreadIds: string[]) => {
        const classifiedRows = await db('triage_results')
          .whereIn('thread_id', pageDbThreadIds)
          .select('thread_id');
        const classifiedSet = new Set(classifiedRows.map((r: any) => r.thread_id));
        const unclassified = pageDbThreadIds.filter((id) => !classifiedSet.has(id));

        log.info(
          { pageSize: pageDbThreadIds.length, alreadyClassified: classifiedRows.length, toDispatch: unclassified.length },
          'Page synced — dispatching triage for unclassified threads',
        );

        if (unclassified.length === 0) return;

        const batchSize = config.TRIAGE_BATCH_SIZE;
        for (let i = 0; i < unclassified.length; i += batchSize) {
          const chunk = unclassified.slice(i, i + batchSize);
          const taskId = await celeryBridge.dispatchTriageBatchTask({ threadIds: chunk, userId, correlationId });
          totalTriageBatches++;
          log.info({ batchIndex: totalTriageBatches, threadCount: chunk.length, celeryTaskId: taskId }, 'Per-page triage batch dispatched');
        }
      };

      let result: { synced: number; messages: number };
      try {
        result = await adapter.syncRecentThreads(maxResults ?? 20, safeDaysBack, onPageSynced);
      } catch (err: any) {
        log.error({ error: err.message, stack: err.stack }, 'Gmail API sync failed');
        await connectionRepo.updateSyncStatus(connectionId, 'error', err.message);
        throw err;
      }

      // 4. Update sync status
      await connectionRepo.updateSyncStatus(connectionId, 'success', null);
      log.info(
        { synced: result.synced, messages: result.messages, triageBatchesDispatched: totalTriageBatches },
        'Gmail sync completed — all per-page triage batches dispatched',
      );

      // 5. Dispatch LLM profile calibration if profile hasn't been calibrated yet
      //    With metadata-first sync, sent email bodies need to be fetched before profile analysis.
      const profileExists = await db('user_profiles').where({ user_id: userId }).first();
      if (!profileExists || !profileExists.last_calibrated_at) {
        // Fetch body content for sent emails (needed for profile style analysis)
        let sentMessages = await db('email_messages as em')
          .join('email_threads as et', 'em.thread_id', 'et.id')
          .where('et.connection_id', connectionId)
          .where('em.is_sent_by_user', true)
          .select('et.external_thread_id')
          .groupBy('et.external_thread_id')
          .limit(10);

        if (sentMessages.length < 3) {
          log.info('Not enough sent emails found in DB, fetching latest sent emails directly from Gmail API for profile');
          await adapter.fetchLatestSentEmails(5);
          
          // Re-fetch after downloading latest sent emails
          sentMessages = await db('email_messages as em')
            .join('email_threads as et', 'em.thread_id', 'et.id')
            .where('et.connection_id', connectionId)
            .where('em.is_sent_by_user', true)
            .select('et.external_thread_id')
            .groupBy('et.external_thread_id')
            .limit(10);
        }

        // Now ensure any sent messages we found actually have their bodies downloaded
        const sentMessagesWithoutBody = await db('email_messages as em')
          .join('email_threads as et', 'em.thread_id', 'et.id')
          .where('et.connection_id', connectionId)
          .where('em.is_sent_by_user', true)
          .whereNull('em.body_text')
          .select('et.external_thread_id')
          .groupBy('et.external_thread_id')
          .limit(10);

        if (sentMessagesWithoutBody.length > 0) {
          log.info({ sentThreadCount: sentMessagesWithoutBody.length }, 'Fetching body for sent emails (needed for profile)');
          for (const row of sentMessagesWithoutBody) {
            try {
              await adapter.fetchThreadFull(row.external_thread_id);
            } catch (err: any) {
              log.warn({ threadId: row.external_thread_id, error: err.message }, 'Failed to fetch sent thread body');
            }
          }
        }

        const profileTaskId = await celeryBridge.dispatchProfileBuildTask({ userId, correlationId });
        log.info({ celeryTaskId: profileTaskId }, 'Profile build task dispatched');
      } else {
        log.debug('Profile already calibrated — skipping profile build dispatch');
      }

      emitToUser(userId, 'sync:completed', {
        connectionId,
        correlationId,
        newThreads: result.synced,
        updatedThreads: 0,
      });

      return result;
    },
    {
      connection: getBullMQConnection() as any,
      concurrency: 5,
      limiter: {
        max: 10,
        duration: 1000, // 10 jobs per second max
      },
    },
  );

  worker.on('completed', (job, result) => {
    logger.info(
      { jobId: job.id, connectionId: job.data.connectionId, synced: result?.synced, messages: result?.messages },
      'Gmail sync job completed successfully',
    );
  });

  worker.on('failed', async (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        connectionId: job?.data.connectionId,
        userId: job?.data.userId,
        attempt: job?.attemptsMade,
        maxAttempts: job?.opts?.attempts,
        error: err.message,
        stack: err.stack,
      },
      'Gmail sync job failed',
    );
    if (job) {
      const db = getDatabase();
      const connectionRepo = new ConnectionRepository(db);
      await connectionRepo.updateSyncStatus(job.data.connectionId, 'error', err.message);
      emitToUser(job.data.userId, 'sync:failed', {
        connectionId: job.data.connectionId,
        correlationId: job.data.correlationId,
        error: err.message,
      });
    }
  });

  worker.on('error', (err) => {
    logger.error({ error: err.message, stack: err.stack }, 'Gmail sync worker Redis/BullMQ error');
  });

  worker.on('stalled', (jobId) => {
    logger.warn({ jobId }, 'Gmail sync job stalled — will be retried');
  });

  logger.info({ queue: QUEUE_NAME, concurrency: 5 }, 'Gmail sync worker started');
  return worker;
}
