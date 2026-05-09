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
  const job = await queue.add('sync', data, {
    jobId: `gmail-sync-${data.connectionId}`, // Dedup key
  });
  logger.info({ jobId: job.id, connectionId: data.connectionId }, 'Gmail sync job enqueued');
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

      log.info('Gmail sync job started');
      emitToUser(userId, 'sync:started', { connectionId, correlationId });

      const db = getDatabase();
      const encryption = new EncryptionService(config.SECRET_ENCRYPTION_KEY);
      const connectionRepo = new ConnectionRepository(db);
      const emailRepo = new EmailRepository(db);

      // 1. Load connection & decrypt tokens
      const connection = await connectionRepo.findByUserAndType(userId, 'gmail');
      if (!connection) {
        log.error('No Gmail connection found for user');
        throw new Error('Gmail connection not found');
      }

      const accessToken = encryption.decrypt(connection.encryptedAccessToken);
      const refreshToken = encryption.decrypt(connection.encryptedRefreshToken);

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

      // 3. Sync threads
      const result = await adapter.syncRecentThreads(maxResults || 20);

      // 4. Update sync status
      await connectionRepo.updateSyncStatus(connectionId, 'success', null);
      log.info({ synced: result.synced, messages: result.messages }, 'Gmail sync completed');

      // 5. Dispatch triage tasks to the Python AI Engine via CeleryBridge
      // Fetch all synced threads for this connection that don't have triage results yet
      const threads = await emailRepo.findThreadsByConnection(connectionId, maxResults || 20);
      const redis = getRedis();
      const celeryBridge = new CeleryBridge(redis);

      for (const thread of threads) {
        // Check if triage result already exists
        const triageExists = await db('triage_results')
          .where({ thread_id: thread.id })
          .first();

        if (!triageExists) {
          await celeryBridge.dispatchTriageTask({
            threadId: thread.id,
            userId,
            correlationId,
          });
          log.info({ threadId: thread.id }, 'Dispatched triage task to AI Engine');
        }
      }

      // 6. Check if user has a profile; if not, bootstrap one
      const profileExists = await db('user_profiles').where({ user_id: userId }).first();
      if (!profileExists) {
        await celeryBridge.dispatchProfileBuildTask({
          userId,
          correlationId,
        });
        log.info('Dispatched profile build task (first-time persona bootstrap)');
      }

      emitToUser(userId, 'sync:completed', { 
        connectionId, 
        correlationId,
        newThreads: result.synced, // mapped from adapter response
        updatedThreads: 0 
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

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Gmail sync job completed');
  });

  worker.on('failed', async (job, err) => {
    logger.error({ jobId: job?.id, error: err.message }, 'Gmail sync job failed');
    if (job) {
      const db = getDatabase();
      const connectionRepo = new ConnectionRepository(db);
      await connectionRepo.updateSyncStatus(job.data.connectionId, 'error', err.message);
      
      emitToUser(job.data.userId, 'sync:failed', { 
        connectionId: job.data.connectionId, 
        correlationId: job.data.correlationId,
        error: err.message 
      });
    }
  });
  worker.on('error', (err) => {
    logger.error({ err }, 'Gmail sync worker Redis error');
  });

  logger.info('Gmail sync worker started');
  return worker;
}
