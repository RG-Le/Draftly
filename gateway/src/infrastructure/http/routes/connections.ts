import { Router, Request, Response } from 'express';
import { google } from 'googleapis';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getDatabase } from '../../database/connection.js';
import { getRedis } from '../../redis/connection.js';
import { loadConfig } from '../../../config/index.js';
import { EncryptionService } from '../../encryption/index.js';
import { ConnectionRepository } from '../../../domain/connectors/connection.repository.js';
import { connectorRegistry } from '../../../domain/connectors/registry.js';
import { enqueueGmailSync } from '../../workers/gmail-sync.worker.js';
import { enqueueDraftSync } from '../../workers/draft-sync.worker.js';
import { requireAuth } from '../middleware/auth.js';
import { userRateLimitMiddleware } from '../middleware/rate-limiter.js';
import { ipRateLimitMiddleware } from '../middleware/rate-limiter.js';
import { ValidationError, NotFoundError, ExternalServiceError } from '../../../domain/errors/index.js';
import { logger } from '../../../shared/logger.js';
import { emitToUser } from '../../socket/websocket.js';

export const connectionsRouter = Router();

const DEFAULT_PROFILE_TEXT =
  'Write professionally and clearly. Keep responses concise — get to the point without unnecessary filler. ' +
  'Acknowledge the sender\'s context before replying. Use a warm but formal tone that feels approachable, not stiff. ' +
  'When making requests, be direct and polite. Structure complex points in short paragraphs; ' +
  'use bullets only when listing multiple distinct items.';

const config = loadConfig();

// Allowlist of origins the redirectUri is permitted to point to (mirrors CORS_ORIGINS).
const allowedFrontendOrigins = config.CORS_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * Validates a redirectUri against the CORS_ORIGINS allowlist.
 * Returns the safe URI string, or null if disallowed/invalid.
 */
function getSafeRedirectUri(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  try {
    const parsed = new URL(input);
    const isAllowed = allowedFrontendOrigins.some((origin) => origin === parsed.origin);
    return isAllowed ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Signs an OAuth state payload with HMAC-SHA256 using SECRET_ENCRYPTION_KEY.
 * Format: base64(json).base64(hmac)
 *
 * This prevents an attacker from forging a state containing a victim's userId,
 * because they cannot produce a valid HMAC without knowing the secret.
 */
function signOAuthState(payload: Record<string, unknown>): string {
  // Use first 32 bytes of the hex key as raw HMAC key material
  const keyBytes = Buffer.from(config.SECRET_ENCRYPTION_KEY.slice(0, 64), 'hex');
  const json = JSON.stringify(payload);
  const data = Buffer.from(json).toString('base64url');
  const sig = createHmac('sha256', keyBytes).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/**
 * Verifies an HMAC-signed state string produced by signOAuthState().
 * Throws ValidationError if the signature is missing or tampered.
 */
function verifyOAuthState(state: string): Record<string, unknown> {
  const parts = state.split('.');
  // base64url data and base64url sig — both are single-segment (no internal dots)
  if (parts.length < 2) {
    throw new ValidationError('Invalid OAuth state: missing signature');
  }
  // Last segment is the HMAC; everything before it is the data
  const sig = parts[parts.length - 1];
  const data = parts.slice(0, -1).join('.');

  const keyBytes = Buffer.from(config.SECRET_ENCRYPTION_KEY.slice(0, 64), 'hex');
  const expectedSig = createHmac('sha256', keyBytes).update(data).digest('base64url');

  // Constant-time comparison to prevent timing attacks
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new ValidationError('Invalid OAuth state: signature mismatch');
  }

  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf-8'));
  } catch {
    throw new ValidationError('Invalid OAuth state: malformed payload');
  }
}

// NOTE: Auth middleware is applied PER-ROUTE, not globally.
// The /callback route is a Google redirect (no Bearer token), so it must be excluded.

// ============================================================================
// GET /connections — List all connectors & user's connection status
// ============================================================================
connectionsRouter.get('/', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const db = getDatabase();
  const connectionRepo = new ConnectionRepository(db);

  const allConnectors = connectorRegistry.getEnabled();
  const userConnections = await connectionRepo.findAllByUser(userId);

  const result = allConnectors.map((connector) => {
    const conn = userConnections.find((c) => c.connectorType === connector.type);
    return {
      type: connector.type,
      displayName: connector.displayName,
      category: connector.category,
      description: connector.description,
      connected: !!conn && conn.status === 'active',
      isUsable: conn?.status === 'active',
      status: conn?.status || null,
      lastSyncedAt: conn?.lastSyncedAt || null,
      lastSyncStatus: conn?.lastSyncStatus || null,
    };
  });

  res.json({ connectors: result });
});

// ============================================================================
// GET /connections/connect/:type — Initiate OAuth for a connector
// ============================================================================
connectionsRouter.get('/connect/:type', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const type = req.params.type as string;
  const userId = (req as any).user.id;
  // Optional redirect_uri from frontend — will be included in state and honoured in /callback
  const redirectUri = req.query.redirect_uri as string | undefined;

  const connector = connectorRegistry.get(type);
  if (!connector) {
    throw new NotFoundError('Connector', type);
  }

  if (type === 'gmail') {
    const oauth2Client = new google.auth.OAuth2(
      config.GOOGLE_CLIENT_ID,
      config.GOOGLE_CLIENT_SECRET,
      config.GMAIL_CALLBACK_URL,
    );

    // Sign the state with HMAC-SHA256 to prevent state forgery (Vuln 1 fix)
    const safeRedirectUri = getSafeRedirectUri(redirectUri) || null;
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: connector.scopes,
      state: signOAuthState({ userId, connectorType: type, redirectUri: safeRedirectUri }),
      include_granted_scopes: true,
    });

    res.json({ authUrl });
  } else {
    throw new ValidationError(`Connector '${type}' does not support OAuth yet`);
  }
});

// ============================================================================
// GET /connections/reconnect/:type — Alias for /connect (better semantic contract)
// ============================================================================
connectionsRouter.get('/reconnect/:type', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const type = req.params.type as string;
  const userId = (req as any).user.id;
  const redirectUri = req.query.redirect_uri as string | undefined;

  const connector = connectorRegistry.get(type);
  if (!connector) {
    throw new NotFoundError('Connector', type);
  }

  if (type === 'gmail') {
    const oauth2Client = new google.auth.OAuth2(
      config.GOOGLE_CLIENT_ID,
      config.GOOGLE_CLIENT_SECRET,
      config.GMAIL_CALLBACK_URL,
    );

    // Re-prompt for consent to force Google to issue a new refresh token
    // Sign the state with HMAC-SHA256 to prevent state forgery (Vuln 1 fix)
    const safeRedirectUri = getSafeRedirectUri(redirectUri) || null;
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: connector.scopes,
      state: signOAuthState({ userId, connectorType: type, redirectUri: safeRedirectUri }),
      include_granted_scopes: true,
    });

    res.json({ authUrl });
  } else {
    throw new ValidationError(`Connector '${type}' does not support OAuth yet`);
  }
});

// ============================================================================
// GET /connections/callback — OAuth callback (handles code exchange)
//
// IMPORTANT: This route has NO auth middleware because it's a browser redirect
// from Google. The userId comes from the signed `state` parameter that WE set
// during the /connect/:type step (which WAS authenticated).
// ============================================================================
connectionsRouter.get('/callback', ipRateLimitMiddleware, async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const error = req.query.error as string | undefined;
  const grantedScopesRaw = req.query.scope as string | undefined;

  if (error) {
    logger.warn({ error }, 'OAuth callback error from provider');
    throw new ExternalServiceError('Google', `OAuth error: ${error}`);
  }

  if (!code || !state) {
    throw new ValidationError('Missing code or state in callback');
  }

  // Verify HMAC signature — prevents state forgery attack (Vuln 1 fix)
  let stateData: Record<string, unknown>;
  try {
    stateData = verifyOAuthState(state);
  } catch (err) {
    logger.warn({ err }, 'OAuth callback: state signature verification failed');
    throw new ValidationError('Invalid or tampered OAuth state');
  }

  const userId = stateData.userId as string;
  const connectorType = stateData.connectorType as string;
  // Re-validate the redirectUri through the allowlist even though we signed it at origin
  // (defence-in-depth: Vuln 2 fix)
  const redirectUri = getSafeRedirectUri(stateData.redirectUri);

  // ---- Scope Verification ----
  // Google returns the granted scopes in the `scope` query param (space-separated).
  // We must verify the user granted ALL required scopes, not just some.
  if (connectorType === 'gmail') {
    const connector = connectorRegistry.get('gmail')!;
    const requiredScopes = connector.scopes;
    const grantedScopes = grantedScopesRaw ? grantedScopesRaw.split(' ') : [];

    const missingScopes = requiredScopes.filter((s) => !grantedScopes.includes(s));

    if (missingScopes.length > 0) {
      logger.warn(
        { userId, missingScopes, grantedScopes },
        'User did not grant all required Gmail scopes',
      );
      throw new ValidationError(
        `Missing required permissions: ${missingScopes.map((s) => s.split('/').pop()).join(', ')}. ` +
        `Please reconnect and grant all permissions for Draftly to function correctly.`,
        { missingScopes, grantedScopes },
      );
    }

    const oauth2Client = new google.auth.OAuth2(
      config.GOOGLE_CLIENT_ID,
      config.GOOGLE_CLIENT_SECRET,
      config.GMAIL_CALLBACK_URL,
    );

    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.access_token || !tokens.refresh_token) {
      throw new ExternalServiceError('Google', 'Did not receive required tokens from Google');
    }

    // Encrypt tokens before storage
    const encryption = new EncryptionService(config.SECRET_ENCRYPTION_KEY);
    const encryptedAccess = encryption.encrypt(tokens.access_token);
    const encryptedRefresh = encryption.encrypt(tokens.refresh_token);
    const expiresAt = new Date(tokens.expiry_date || Date.now() + 3600 * 1000);

    // Store connection with granted scopes metadata
    const db = getDatabase();
    const connectionRepo = new ConnectionRepository(db);

    const connection = await connectionRepo.upsert({
      userId,
      connectorType: 'gmail',
      encryptedAccessToken: encryptedAccess,
      encryptedRefreshToken: encryptedRefresh,
      tokenExpiresAt: expiresAt,
      status: 'active',
      connectorMetadata: {
        grantedScopes,
        canRead: grantedScopes.includes('https://www.googleapis.com/auth/gmail.readonly'),
        canSend: grantedScopes.includes('https://www.googleapis.com/auth/gmail.send'),
        canModify: grantedScopes.includes('https://www.googleapis.com/auth/gmail.modify'),
      },
    });

    logger.info(
      { userId, connectionId: connection.id, grantedScopes },
      'Gmail connection established with verified scopes',
    );

    // Bootstrap user profile with defaults on first Gmail connection
    const user = await db('users').where({ id: userId }).first();
    const userName = user?.name || 'User';
    const sigTemplate = `--\n${userName}`;

    const existingProfile = await db('user_profiles').where({ user_id: userId }).first();
    if (!existingProfile) {
      await db('user_profiles').insert({
        user_id: userId,
        preferred_tone: 'professional',
        personalized_profile: DEFAULT_PROFILE_TEXT,
        signature_template: sigTemplate,
        greeting_style: JSON.stringify({ formal: true, common_phrases: ['Hello', 'Hi'] }),
        closing_style: JSON.stringify({ formal: true, common_phrases: ['Best regards', 'Thanks'] }),
        communication_norms: JSON.stringify({ sentence_length: 'medium', uses_bullet_points: false }),
        confidence_score: 0.5,
        profile_version: 1,
      });
    } else {
      const updates: Record<string, unknown> = {};
      if (!existingProfile.preferred_tone) updates.preferred_tone = 'professional';
      if (!existingProfile.personalized_profile) updates.personalized_profile = DEFAULT_PROFILE_TEXT;
      if (!existingProfile.signature_template) updates.signature_template = sigTemplate;
      if (Object.keys(updates).length > 0) {
        updates.updated_at = new Date();
        await db('user_profiles').where({ user_id: userId }).update(updates);
      }
    }

    emitToUser(userId, 'profile:initialized', {
      userId,
      preferredTone: 'professional',
      signatureTemplate: sigTemplate,
      personalizedProfile: DEFAULT_PROFILE_TEXT,
    });

    logger.info({ userId }, 'Profile bootstrap complete after Gmail connection');

    // Trigger initial sync
    const correlationId = (req as any).correlationId || 'manual';
    await enqueueGmailSync({
      connectionId: connection.id,
      userId,
      correlationId,
      maxResults: 20,
    });

    // Redirect to frontend if a redirect_uri was provided, otherwise return JSON (Postman fallback).
    // redirectUri has already been validated through getSafeRedirectUri() above (Vuln 2 fix).
    if (redirectUri) {
      const url = new URL(redirectUri);
      url.searchParams.set('gmail_connected', 'true');
      url.searchParams.set('connectionId', connection.id);
      res.redirect(302, url.toString());
    } else {
      res.json({
        message: 'Gmail connected successfully',
        connectionId: connection.id,
        status: 'active',
        syncQueued: true,
        permissions: {
          canRead: grantedScopes.includes('https://www.googleapis.com/auth/gmail.readonly'),
          canSend: grantedScopes.includes('https://www.googleapis.com/auth/gmail.send'),
          canModify: grantedScopes.includes('https://www.googleapis.com/auth/gmail.modify'),
        },
      });
    }
  } else {
    throw new ValidationError(`Unsupported connector type: ${connectorType}`);
  }
});

// ============================================================================
// POST /connections/:type/sync — Trigger manual sync
// ============================================================================
connectionsRouter.post('/:type/sync', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const type = req.params.type as string;

  const db = getDatabase();
  const connectionRepo = new ConnectionRepository(db);
  const connection = await connectionRepo.findByUserAndType(userId, type);

  if (!connection) {
    throw new NotFoundError('Connection', type);
  }

  if (connection.status !== 'active') {
    throw new ValidationError(`Connection is ${connection.status}. Please reconnect.`);
  }

  const correlationId = (req as any).correlationId || 'manual';
  const jobId = await enqueueGmailSync({
    connectionId: connection.id,
    userId,
    correlationId,
    maxResults: req.body?.maxResults || 20,
  });

  res.json({
    message: 'Sync job queued',
    jobId,
    connectionId: connection.id,
  });
});

// ============================================================================
// DELETE /connections/:type — Disconnect (revoke)
// ============================================================================
connectionsRouter.delete('/:type', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const type = req.params.type as string;

  const db = getDatabase();
  const connectionRepo = new ConnectionRepository(db);
  const connection = await connectionRepo.findByUserAndType(userId, type);

  if (!connection) {
    throw new NotFoundError('Connection', type);
  }

  await connectionRepo.markRevoked(connection.id);
  logger.info({ userId, connectionId: connection.id, type }, 'Connection revoked');

  res.json({ message: `${type} disconnected` });
});

// ============================================================================
// GET /connections/:type/threads — List synced threads
// ============================================================================
connectionsRouter.get('/:type/threads', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const type = req.params.type as string;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = parseInt(req.query.offset as string) || 0;

  const db = getDatabase();
  const connectionRepo = new ConnectionRepository(db);
  const connection = await connectionRepo.findByUserAndType(userId, type);

  if (!connection) {
    throw new NotFoundError('Connection', type);
  }

  const { EmailRepository } = await import('../../../domain/connectors/email.repository.js');
  const emailRepo = new EmailRepository(db);
  
  const category = req.query.category as string;
  const threads = await emailRepo.findInboxThreads({
    connectionId: connection.id,
    category,
    limit,
    offset
  });

  res.json({
    threads: threads.map((t) => ({
      id: t.id,
      externalThreadId: t.externalThreadId,
      subject: t.subject,
      participants: t.participants,
      messageCount: t.messageCount,
      lastMessageAt: t.lastMessageAt,
      syncStatus: t.syncStatus,
      triage: t.triage ? {
        classification: t.triage.classification,
        confidence: t.triage.confidence,
        reasoning: t.triage.reasoning
      } : null,
      draft: t.draft ? {
        status: t.draft.status
      } : null
    })),
    pagination: { limit, offset, count: threads.length },
  });
});

// ============================================================================
// GET /connections/:type/threads/:id — Get thread details + message history
// ============================================================================
connectionsRouter.get('/:type/threads/:id', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const type = req.params.type as string;
  const id = req.params.id as string;

  const db = getDatabase();
  const connectionRepo = new ConnectionRepository(db);
  const connection = await connectionRepo.findByUserAndType(userId, type);

  if (!connection) {
    throw new NotFoundError('Connection', type);
  }

  const { EmailRepository } = await import('../../../domain/connectors/email.repository.js');
  const emailRepo = new EmailRepository(db);
  
  const thread = await emailRepo.findThreadById(id);
  if (!thread || thread.connectionId !== connection.id) {
    throw new NotFoundError('Thread', id);
  }

  const messages = await emailRepo.findMessagesByThread(id);

  res.json({
    thread,
    messages: messages.map(m => ({
      id: m.id,
      fromAddress: m.fromAddress,
      toAddresses: m.toAddresses,
      ccAddresses: m.ccAddresses,
      subject: m.subject,
      bodyText: m.bodyText,
      bodyHtml: m.bodyHtml,
      receivedAt: m.receivedAt,
      isSentByUser: m.isSentByUser
    }))
  });
});

// ============================================================================
// GET /connections/:type/threads/:id/triage — Get AI classification
// ============================================================================
connectionsRouter.get('/:type/threads/:id/triage', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const type = req.params.type as string;
  const id = req.params.id as string;

  const db = getDatabase();
  const connectionRepo = new ConnectionRepository(db);
  const connection = await connectionRepo.findByUserAndType(userId, type);

  if (!connection) {
    throw new NotFoundError('Connection', type);
  }

  const { EmailRepository } = await import('../../../domain/connectors/email.repository.js');
  const emailRepo = new EmailRepository(db);
  
  const thread = await emailRepo.findThreadById(id);
  if (!thread || thread.connectionId !== connection.id) {
    throw new NotFoundError('Thread', id);
  }

  const triage = await emailRepo.findTriageByThreadId(id);

  if (!triage) {
    res.json({ status: 'pending_or_missing' });
    return;
  }

  res.json({
    id: triage.id,
    classification: triage.classification,
    confidenceScore: triage.confidence_score,
    reasoning: triage.reasoning,
    actionRequired: triage.action_required,
    urgencyScore: triage.urgency_score,
    metadata: triage.metadata,
    createdAt: triage.created_at
  });
});

// ============================================================================
// GET /connections/:type/threads/:id/draft — Get latest AI draft
// ============================================================================
connectionsRouter.get('/:type/threads/:id/draft', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const type = req.params.type as string;
  const id = req.params.id as string;

  const db = getDatabase();
  const connectionRepo = new ConnectionRepository(db);
  const connection = await connectionRepo.findByUserAndType(userId, type);

  if (!connection) {
    throw new NotFoundError('Connection', type);
  }

  const { EmailRepository } = await import('../../../domain/connectors/email.repository.js');
  const emailRepo = new EmailRepository(db);
  
  const thread = await emailRepo.findThreadById(id);
  if (!thread || thread.connectionId !== connection.id) {
    throw new NotFoundError('Thread', id);
  }

  const draft = await emailRepo.findLatestDraftByThreadId(id);

  if (!draft) {
    res.json({ status: 'not_generated' });
    return;
  }

  res.json({
    id: draft.id,
    status: draft.status,
    generatedContent: draft.generated_content,
    currentContent: draft.current_content,
    version: draft.version,
    generationMetadata: draft.generation_metadata,
    createdAt: draft.created_at,
    updatedAt: draft.updated_at
  });
});

// ============================================================================
// POST /connections/:type/threads/:id/triage — Trigger manual re-triage
// ============================================================================
connectionsRouter.post('/:type/threads/:id/triage', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const type = req.params.type as string;
  const id = req.params.id as string;

  const db = getDatabase();
  const connectionRepo = new ConnectionRepository(db);
  const connection = await connectionRepo.findByUserAndType(userId, type);

  if (!connection) {
    throw new NotFoundError('Connection', type);
  }

  const { EmailRepository } = await import('../../../domain/connectors/email.repository.js');
  const emailRepo = new EmailRepository(db);

  const thread = await emailRepo.findThreadById(id);
  if (!thread || thread.connectionId !== connection.id) {
    throw new NotFoundError('Thread', id);
  }

  // Delete existing triage result so the pipeline runs fresh
  await db('triage_results').where({ thread_id: id }).delete();

  const correlationId = (req as any).correlationId || `manual-triage-${id}`;
  const redis = getRedis();
  const { CeleryBridge } = await import('../../workers/celery-bridge.js');
  const celeryBridge = new CeleryBridge(redis);

  const taskId = await celeryBridge.dispatchTriageTask({
    threadId: id,
    userId,
    correlationId,
  });

  logger.info({ threadId: id, taskId }, 'Manual re-triage dispatched');

  res.json({
    message: 'Re-triage triggered',
    taskId,
    threadId: id,
    correlationId,
  });
});

// ============================================================================
// POST /connections/:type/threads/:id/draft — Trigger manual draft generation
// ============================================================================
connectionsRouter.post('/:type/threads/:id/draft', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const type = req.params.type as string;
  const id = req.params.id as string;

  const db = getDatabase();
  const connectionRepo = new ConnectionRepository(db);
  const connection = await connectionRepo.findByUserAndType(userId, type);

  if (!connection) {
    throw new NotFoundError('Connection', type);
  }

  const { EmailRepository } = await import('../../../domain/connectors/email.repository.js');
  const emailRepo = new EmailRepository(db);
  
  const thread = await emailRepo.findThreadById(id);
  if (!thread || thread.connectionId !== connection.id) {
    throw new NotFoundError('Thread', id);
  }

  const correlationId = (req as any).correlationId || `manual-draft-${id}`;
  const redis = getRedis();
  const { CeleryBridge } = await import('../../workers/celery-bridge.js');
  const celeryBridge = new CeleryBridge(redis);

  const taskId = await celeryBridge.dispatchDraftTask({
    threadId: id,
    userId,
    correlationId,
  });

  res.json({
    message: 'Manual draft generation triggered',
    taskId,
    threadId: id,
    correlationId
  });
});

// ============================================================================
// PUT /connections/:type/threads/:id/draft — Edit the draft content
// ============================================================================
connectionsRouter.put('/:type/threads/:id/draft', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const type = req.params.type as string;
  const id = req.params.id as string;
  const { content } = req.body;

  if (!content || typeof content !== 'string') {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'content (string) is required' } });
    return;
  }

  const db = getDatabase();
  const connectionRepo = new ConnectionRepository(db);
  const connection = await connectionRepo.findByUserAndType(userId, type);

  if (!connection) {
    throw new NotFoundError('Connection', type);
  }

  const { EmailRepository } = await import('../../../domain/connectors/email.repository.js');
  const emailRepo = new EmailRepository(db);

  const thread = await emailRepo.findThreadById(id);
  if (!thread || thread.connectionId !== connection.id) {
    throw new NotFoundError('Thread', id);
  }

  const draft = await emailRepo.findLatestDraftByThreadId(id);
  if (!draft) {
    throw new NotFoundError('Draft for thread', id);
  }

  if (draft.status === 'sent' || draft.status === 'approved') {
    res.status(409).json({ error: { code: 'CONFLICT', message: `Cannot edit a draft in "${draft.status}" state` } });
    return;
  }

  // Update the draft's current_content and bump the version
  const [updated] = await db('drafts').where({ id: draft.id }).update({
    current_content: content,
    status: 'edited',
    version: draft.version + 1,
    updated_at: new Date(),
  }).returning('*');

  // Record the action
  await db('draft_actions').insert({
    draft_id: draft.id,
    user_id: userId,
    action_type: 'edit',
    snapshot_after: content,
    metadata: JSON.stringify({ version: draft.version + 1 }),
  });

  // Sync the updated content to Gmail draft
  if (draft.external_draft_id) {
    await enqueueDraftSync({
      draftId: draft.id,
      threadId: id,
      userId,
      correlationId: `edit-sync-${draft.id}`,
      action: 'update',
    });
  }

  res.json({
    id: updated.id,
    status: updated.status,
    version: updated.version,
    currentContent: updated.current_content,
    updatedAt: updated.updated_at,
  });
});

// ============================================================================
// POST /connections/:type/threads/:id/approve — Approve and send
// ============================================================================
connectionsRouter.post('/:type/threads/:id/approve', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const type = req.params.type as string;
  const id = req.params.id as string;

  const db = getDatabase();
  const connectionRepo = new ConnectionRepository(db);
  const connection = await connectionRepo.findByUserAndType(userId, type);

  if (!connection) {
    throw new NotFoundError('Connection', type);
  }

  const { EmailRepository } = await import('../../../domain/connectors/email.repository.js');
  const emailRepo = new EmailRepository(db);

  const thread = await emailRepo.findThreadById(id);
  if (!thread || thread.connectionId !== connection.id) {
    throw new NotFoundError('Thread', id);
  }

  const draft = await emailRepo.findLatestDraftByThreadId(id);
  if (!draft) {
    throw new NotFoundError('Draft for thread', id);
  }

  if (draft.status === 'sent') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'Draft has already been sent' } });
    return;
  }
  if (draft.status === 'approved') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'Draft is already approved and queued for sending' } });
    return;
  }

  // Update status to approved
  await db('drafts').where({ id: draft.id }).update({
    status: 'approved',
    updated_at: new Date(),
  });

  // Record the action
  await db('draft_actions').insert({
    draft_id: draft.id,
    user_id: userId,
    action_type: 'approve',
    metadata: JSON.stringify({ version: draft.version }),
  });

  // Enqueue the send job
  const { enqueueSendReply } = await import('../../workers/send-reply.worker.js');
  const jobId = await enqueueSendReply({
    draftId: draft.id,
    threadId: id,
    userId,
    correlationId: `approve-${draft.id}`,
  });

  res.json({
    status: 'approved',
    message: 'Draft approved and queued for sending',
    jobId,
  });
});

// ============================================================================
// POST /connections/:type/threads/:id/reject — Reject the draft
// ============================================================================
connectionsRouter.post('/:type/threads/:id/reject', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const type = req.params.type as string;
  const id = req.params.id as string;

  const db = getDatabase();
  const connectionRepo = new ConnectionRepository(db);
  const connection = await connectionRepo.findByUserAndType(userId, type);

  if (!connection) {
    throw new NotFoundError('Connection', type);
  }

  const { EmailRepository } = await import('../../../domain/connectors/email.repository.js');
  const emailRepo = new EmailRepository(db);

  const thread = await emailRepo.findThreadById(id);
  if (!thread || thread.connectionId !== connection.id) {
    throw new NotFoundError('Thread', id);
  }

  const draft = await emailRepo.findLatestDraftByThreadId(id);
  if (!draft) {
    throw new NotFoundError('Draft for thread', id);
  }

  if (draft.status === 'sent') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'Cannot reject a draft that has already been sent' } });
    return;
  }

  // Update status to rejected
  await db('drafts').where({ id: draft.id }).update({
    status: 'rejected',
    updated_at: new Date(),
  });

  // Record the action
  await db('draft_actions').insert({
    draft_id: draft.id,
    user_id: userId,
    action_type: 'reject',
    metadata: JSON.stringify({ version: draft.version }),
  });

  // Delete the Gmail draft so it doesn't linger in the user's drafts folder
  if (draft.external_draft_id) {
    await enqueueDraftSync({
      draftId: draft.id,
      threadId: id,
      userId,
      correlationId: `reject-sync-${draft.id}`,
      action: 'delete',
    });
  }

  res.json({
    status: 'rejected',
    message: 'Draft has been rejected',
  });
});

