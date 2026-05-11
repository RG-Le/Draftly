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
      const { connectionId, userId, correlationId, maxResults } = job.data;
      const log = logger.child({ correlationId, connectionId, userId, jobId: job.id });

      log.info({ maxResults: maxResults || 20, attempt: job.attemptsMade + 1 }, 'Gmail sync job started');
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

      // 3. Sync threads from Gmail API
      log.info({ maxResults: maxResults || 20 }, 'Calling Gmail API to sync threads');
      let result: { synced: number; messages: number };
      try {
        result = await adapter.syncRecentThreads(maxResults || 20);
      } catch (err: any) {
        log.error({ error: err.message, stack: err.stack }, 'Gmail API sync failed');
        await connectionRepo.updateSyncStatus(connectionId, 'error', err.message);
        throw err;
      }

      // 4. Update sync status
      await connectionRepo.updateSyncStatus(connectionId, 'success', null);
      log.info({ synced: result.synced, messages: result.messages }, 'Gmail API sync completed');

      // 5. Dispatch batch triage to the Python AI Engine for unclassified threads
      const threads = await emailRepo.findThreadsByConnection(connectionId, maxResults || 20);
      log.info({ threadCount: threads.length }, 'Threads fetched from DB for triage dispatch');

      const redis = getRedis();
      const celeryBridge = new CeleryBridge(redis);

      if (threads.length === 0) {
        log.warn('No threads found in DB after sync — triage dispatch skipped');
      } else {
        // Single query for all already-classified thread IDs (avoids N+1)
        const threadIds = threads.map((t) => t.id);
        const classifiedRows = await db('triage_results')
          .whereIn('thread_id', threadIds)
          .select('thread_id');
        const classifiedSet = new Set(classifiedRows.map((r: any) => r.thread_id));
        const unclassifiedIds = threadIds.filter((id) => !classifiedSet.has(id));

        log.info(
          { total: threadIds.length, alreadyClassified: classifiedRows.length, toDispatch: unclassifiedIds.length },
          'Triage dispatch readiness',
        );

        if (unclassifiedIds.length === 0) {
          log.info('All fetched threads already classified — triage dispatch skipped');
        } else {
          const batchSize = config.TRIAGE_BATCH_SIZE;
          let batchCount = 0;
          for (let i = 0; i < unclassifiedIds.length; i += batchSize) {
            const chunk = unclassifiedIds.slice(i, i + batchSize);
            const taskId = await celeryBridge.dispatchTriageBatchTask({ threadIds: chunk, userId, correlationId });
            batchCount++;
            log.info(
              { batchIndex: batchCount, threadCount: chunk.length, celeryTaskId: taskId },
              'Batch triage task dispatched to Celery via Redis LPUSH',
            );
          }
          log.info({ totalBatches: batchCount, totalThreads: unclassifiedIds.length }, 'All triage batches dispatched');
        }
      }

      // 6. Dispatch LLM profile calibration if profile hasn't been calibrated yet
      const profileExists = await db('user_profiles').where({ user_id: userId }).first();
      if (!profileExists || !profileExists.last_calibrated_at) {
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
