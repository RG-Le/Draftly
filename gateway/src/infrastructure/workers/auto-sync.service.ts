import { getGmailSyncQueue } from './gmail-sync.worker.js';
import { getDatabase } from '../database/connection.js';
import { logger } from '../../shared/logger.js';

export async function enableAutoSync(
  userId: string,
  connectionId: string,
  intervalHours: number,
): Promise<void> {
  const queue = getGmailSyncQueue();
  const intervalMs = intervalHours * 60 * 60 * 1000;

  await queue.upsertJobScheduler(
    `auto-sync-${userId}`,
    { every: intervalMs },
    {
      name: 'sync',
      data: {
        connectionId,
        userId,
        correlationId: `auto-sync-${userId}`,
        maxResults: 50,
      },
    },
  );

  logger.info({ userId, intervalHours }, 'Auto-sync scheduler enabled');
}

export async function disableAutoSync(userId: string): Promise<void> {
  const queue = getGmailSyncQueue();
  const removed = await queue.removeJobScheduler(`auto-sync-${userId}`);
  logger.info({ userId, removed }, 'Auto-sync scheduler disabled');
}

/**
 * Restores all active auto-sync BullMQ schedulers from user_preferences at startup.
 * Called once after the database and workers are initialized.
 */
export async function restoreAutoSyncJobs(): Promise<void> {
  const db = getDatabase();

  const prefs = await db('user_preferences')
    .where({ key: 'auto_sync' })
    .whereRaw("(value->>'enabled')::boolean = true");

  if (prefs.length === 0) {
    logger.info('No auto-sync jobs to restore at startup');
    return;
  }

  let restored = 0;
  for (const pref of prefs) {
    const intervalHours: number = pref.value?.interval_hours ?? 24;
    const connection = await db('user_connections')
      .where({ user_id: pref.user_id, connector_type: 'gmail', status: 'active' })
      .first();

    if (connection) {
      await enableAutoSync(pref.user_id, connection.id, intervalHours);
      restored++;
    } else {
      logger.warn({ userId: pref.user_id }, 'Auto-sync enabled but no active Gmail connection — skipping restore');
    }
  }

  logger.info({ restored, total: prefs.length }, 'Auto-sync jobs restored at startup');
}
