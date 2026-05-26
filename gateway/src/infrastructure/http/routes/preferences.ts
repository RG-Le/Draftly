import { Router, Request, Response } from 'express';
import { getDatabase } from '../../database/connection.js';
import { enqueueGmailSync } from '../../workers/gmail-sync.worker.js';
import { enableAutoSync, disableAutoSync } from '../../workers/auto-sync.service.js';
import { requireAuth } from '../middleware/auth.js';
import { userRateLimitMiddleware } from '../middleware/rate-limiter.js';
import { ValidationError } from '../../../domain/errors/index.js';
import { logger } from '../../../shared/logger.js';

export const preferencesRouter = Router();

// ============================================================================
// GET /preferences — All user preferences
// ============================================================================
preferencesRouter.get('/', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const db = getDatabase();

  const rows = await db('user_preferences').where({ user_id: userId });
  const prefsMap: Record<string, any> = {};
  for (const row of rows) {
    prefsMap[row.key] = row.value;
  }

  const autoSync = prefsMap['auto_sync'] ?? { enabled: false, interval_hours: 24 };

  res.json({
    autoSync: {
      enabled: autoSync.enabled ?? false,
      intervalHours: autoSync.interval_hours ?? 24,
    },
  });
});

// ============================================================================
// GET /preferences/auto-sync — Current auto-sync config
// ============================================================================
preferencesRouter.get('/auto-sync', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const db = getDatabase();

  const pref = await db('user_preferences')
    .where({ user_id: userId, key: 'auto_sync' })
    .first();
  const value = pref?.value ?? { enabled: false, interval_hours: 24 };

  const connection = await db('user_connections')
    .where({ user_id: userId, connector_type: 'gmail', status: 'active' })
    .first();

  res.json({
    enabled: value.enabled ?? false,
    intervalHours: value.interval_hours ?? 24,
    lastSyncAt: connection?.last_synced_at ?? null,
    gmailConnected: !!connection,
  });
});

// ============================================================================
// PUT /preferences/auto-sync — Enable/disable auto-sync; set interval
//
// Body: { enabled: boolean, intervalHours?: number }
// Default intervalHours: 24
// Valid range: 1–168 (1 hour to 7 days)
// ============================================================================
preferencesRouter.put('/auto-sync', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { enabled, intervalHours = 24 } = req.body;

  if (typeof enabled !== 'boolean') {
    throw new ValidationError('enabled must be a boolean');
  }
  if (typeof intervalHours !== 'number' || !Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 168) {
    throw new ValidationError('intervalHours must be an integer between 1 and 168');
  }

  const db = getDatabase();

  await db('user_preferences')
    .insert({
      user_id: userId,
      key: 'auto_sync',
      value: JSON.stringify({ enabled, interval_hours: intervalHours }),
      updated_at: new Date(),
    })
    .onConflict(['user_id', 'key'])
    .merge(['value', 'updated_at']);

  const connection = await db('user_connections')
    .where({ user_id: userId, connector_type: 'gmail', status: 'active' })
    .first();

  if (enabled) {
    if (!connection) {
      throw new ValidationError('No active Gmail connection found. Connect Gmail before enabling auto-sync.');
    }
    await enableAutoSync(userId, connection.id, intervalHours);

    // Trigger an immediate sync when first enabling
    await enqueueGmailSync({
      connectionId: connection.id,
      userId,
      correlationId: `auto-sync-initial-${userId}`,
      maxResults: 50,
    });

    logger.info({ userId, intervalHours }, 'Auto-sync enabled with immediate sync triggered');
  } else {
    await disableAutoSync(userId);
    logger.info({ userId }, 'Auto-sync disabled');
  }

  res.json({
    enabled,
    intervalHours,
    message: enabled
      ? `Auto-sync enabled. Emails sync every ${intervalHours} hour(s). Syncing now.`
      : 'Auto-sync disabled.',
  });
});

// ============================================================================
// GET /preferences/triage — Get user's triage preferences
// ============================================================================
preferencesRouter.get('/triage', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const db = getDatabase();

  const pref = await db('user_preferences')
    .where({ user_id: userId, key: 'triage_settings' })
    .first();

  const value = pref?.value ?? { custom_instructions: null };

  res.json({
    customInstructions: value.custom_instructions ?? null,
  });
});

// ============================================================================
// PUT /preferences/triage — Update user's triage preferences
// ============================================================================
preferencesRouter.put('/triage', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { customInstructions } = req.body;

  if (customInstructions !== undefined && customInstructions !== null) {
    if (typeof customInstructions !== 'string') {
      throw new ValidationError('customInstructions must be a string');
    }
    if (customInstructions.length > 500) {
      throw new ValidationError('customInstructions must be 500 characters or fewer');
    }
  }

  const db = getDatabase();
  const value = { custom_instructions: customInstructions || null };

  await db('user_preferences')
    .insert({
      user_id: userId,
      key: 'triage_settings',
      value: JSON.stringify(value),
      updated_at: new Date(),
    })
    .onConflict(['user_id', 'key'])
    .merge(['value', 'updated_at']);

  res.json({
    customInstructions: value.custom_instructions,
    message: 'Triage preferences updated.',
  });
});
