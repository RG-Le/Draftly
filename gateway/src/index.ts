import { loadConfig, loadJwtKeys } from './config/index.js';
import { createApp } from './infrastructure/http/app.js';
import { createDatabase, destroyDatabase } from './infrastructure/database/connection.js';
import { createRedis, destroyRedis } from './infrastructure/redis/connection.js';
import { EncryptionService } from './infrastructure/encryption/index.js';
import { startGmailSyncWorker } from './infrastructure/workers/gmail-sync.worker.js';
import { startSendReplyWorker } from './infrastructure/workers/send-reply.worker.js';
import { startDraftSyncWorker } from './infrastructure/workers/draft-sync.worker.js';
import { restoreAutoSyncJobs } from './infrastructure/workers/auto-sync.service.js';
import { initWebSocket } from './infrastructure/socket/websocket.js';
import { startEventSubscriber } from './infrastructure/redis/events.js';
import { logger } from './shared/logger.js';

async function main(): Promise<void> {
  // 1. Load and validate config
  const config = loadConfig();
  logger.info({ env: config.NODE_ENV, port: config.API_PORT }, 'Configuration loaded');

  // 2. Initialize infrastructure
  const db = createDatabase(config);
  logger.info('Database connection pool created');

  const redis = createRedis(config.REDIS_URL);
  logger.info('Redis connection established');

  const encryption = new EncryptionService(config.SECRET_ENCRYPTION_KEY);
  logger.info('Encryption service initialized');

  // 3. Load JWT keys
  try {
    const jwtKeys = loadJwtKeys(config);
    logger.info('JWT RS256 keys loaded');
    // Store for later use by auth service
    (globalThis as any).__jwtKeys = jwtKeys;
  } catch (err) {
    logger.warn({ err }, 'JWT keys not found — auth endpoints will not work. Run: npm run generate:keys');
  }

  // 4. Create Express app
  const app = createApp(config);

  // Make services available to routes via app.locals
  app.locals.db = db;
  app.locals.redis = redis;
  app.locals.encryption = encryption;
  app.locals.config = config;

  // 5. Start server
  const server = app.listen(config.API_PORT, () => {
    logger.info({ port: config.API_PORT, env: config.NODE_ENV }, '🚀 Draftly Gateway started');
  });

  // 6. Start WebSockets & Event Subscriber
  initWebSocket(server, config);
  startEventSubscriber();
  logger.info('WebSocket server and Redis event subscriber started');

  // 7. Start BullMQ workers
  startGmailSyncWorker();
  startSendReplyWorker();
  startDraftSyncWorker();
  logger.info('BullMQ workers started (Gmail sync, Send reply, Draft sync)');

  // 8. Restore auto-sync schedulers for users who had it enabled
  restoreAutoSyncJobs().catch((err) =>
    logger.warn({ err }, 'Auto-sync restore encountered an error — non-fatal'),
  );

  // 6. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    server.close(async () => {
      logger.info('HTTP server closed');
      await destroyRedis();
      logger.info('Redis disconnected');
      await destroyDatabase();
      logger.info('Database disconnected');
      process.exit(0);
    });

    // Force exit after 10s
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Catch unhandled errors
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — shutting down');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start gateway');
  process.exit(1);
});
