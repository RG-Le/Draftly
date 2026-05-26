import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getDatabase } from '../../database/connection.js';
import { getRedis } from '../../redis/connection.js';
import { requireAuth } from '../middleware/auth.js';
import { userRateLimitMiddleware } from '../middleware/rate-limiter.js';
import { logger } from '../../../shared/logger.js';

export const profileRouter = Router();

const VALID_TONES = ['professional', 'casual', 'friendly', 'formal', 'concise'] as const;

const profileUpdateSchema = z.object({
  preferredTone: z.enum(VALID_TONES).optional(),
  preferred_tone: z.enum(VALID_TONES).optional(),
  personalizedProfile: z.string().max(2000, 'Personalized profile must be under 2000 characters').optional(),
  personalized_profile: z.string().max(2000, 'Personalized profile must be under 2000 characters').optional(),
  signatureTemplate: z.string().max(500, 'Signature must be under 500 characters').optional(),
  signature_template: z.string().max(500, 'Signature must be under 500 characters').optional(),
});

// ============================================================================
// GET /profile — Get the user's AI-generated communication profile
// ============================================================================
profileRouter.get('/', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const db = getDatabase();

  const profile = await db('user_profiles').where({ user_id: userId }).first();

  if (!profile) {
    res.json({
      exists: false,
      profile: null,
      message: 'No profile generated yet. Trigger a Gmail sync to begin profile analysis.'
    });
    return;
  }

  res.json({
    exists: true,
    profile: {
      preferredTone: profile.preferred_tone,
      personalizedProfile: profile.personalized_profile,
      greetingStyle: profile.greeting_style,
      closingStyle: profile.closing_style,
      signatureTemplate: profile.signature_template,
      communicationNorms: profile.communication_norms,
      confidenceScore: profile.confidence_score,
      profileVersion: profile.profile_version,
      profileSource: profile.profile_source || 'default',
      isAiGenerated: (profile.profile_source || 'default') === 'ai_generated',
      lastCalibratedAt: profile.last_calibrated_at || profile.updated_at,
    }
  });
});

// ============================================================================
// PUT /profile — Update the user's communication profile
// ============================================================================
profileRouter.put('/', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const db = getDatabase();

  const parseResult = profileUpdateSchema.safeParse(req.body);
  if (!parseResult.success) {
    const errors = parseResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: errors } });
    return;
  }

  const { preferredTone, preferred_tone, personalizedProfile, personalized_profile, signatureTemplate, signature_template } = req.body;

  const tone = preferredTone !== undefined ? preferredTone : preferred_tone;
  const personalized = personalizedProfile !== undefined ? personalizedProfile : personalized_profile;
  const signature = signatureTemplate !== undefined ? signatureTemplate : signature_template;

  const updateData: any = { updated_at: new Date() };
  if (tone !== undefined) updateData.preferred_tone = tone;
  if (personalized !== undefined) updateData.personalized_profile = personalized;
  if (signature !== undefined) updateData.signature_template = signature;

  const profile = await db('user_profiles').where({ user_id: userId }).first();

  if (!profile) {
    const [created] = await db('user_profiles').insert({
      user_id: userId,
      preferred_tone: tone,
      personalized_profile: personalized,
      signature_template: signature
    }).returning('*');
    
    res.json({
      exists: true,
      profile: {
        preferredTone: created.preferred_tone,
        personalizedProfile: created.personalized_profile,
        signatureTemplate: created.signature_template,
        greetingStyle: created.greeting_style,
        closingStyle: created.closing_style,
        communicationNorms: created.communication_norms,
        confidenceScore: created.confidence_score,
        profileVersion: created.profile_version,
        lastCalibratedAt: created.updated_at
      }
    });
    return;
  }

  const [updated] = await db('user_profiles')
    .where({ user_id: userId })
    .update(updateData)
    .returning('*');

  res.json({
    exists: true,
    profile: {
      preferredTone: updated.preferred_tone,
      personalizedProfile: updated.personalized_profile,
      signatureTemplate: updated.signature_template,
      greetingStyle: updated.greeting_style,
      closingStyle: updated.closing_style,
      communicationNorms: updated.communication_norms,
      confidenceScore: updated.confidence_score,
      profileVersion: updated.profile_version,
      lastCalibratedAt: updated.updated_at
    }
  });
});

// ============================================================================
// POST /profile/regenerate — Trigger AI profile re-analysis from sent emails
// ============================================================================
profileRouter.post('/regenerate', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const correlationId = (req as any).correlationId || `manual-profile-${userId}`;
  const db = getDatabase();

  try {
    const { ConnectionRepository } = await import('../../../domain/connectors/connection.repository.js');
    const connectionRepo = new ConnectionRepository(db);
    const connection = await connectionRepo.findByUserAndType(userId, 'gmail');

    if (connection && connection.status === 'active') {
      const sentMessages = await db('email_messages as em')
        .join('email_threads as et', 'em.thread_id', 'et.id')
        .where('et.connection_id', connection.id)
        .where('em.is_sent_by_user', true)
        .select('et.external_thread_id')
        .groupBy('et.external_thread_id')
        .limit(10);

      if (sentMessages.length < 3) {
        logger.info({ userId }, 'Not enough sent emails found in DB for manual regeneration, fetching latest sent emails directly from Gmail API');
        const { GmailAdapter } = await import('../../../domain/connectors/gmail.adapter.js');
        const { EmailRepository } = await import('../../../domain/connectors/email.repository.js');
        const { EncryptionService } = await import('../../../infrastructure/encryption/index.js');
        const { loadConfig } = await import('../../../config/index.js');
        
        const config = loadConfig();
        const encryption = new EncryptionService(config.SECRET_ENCRYPTION_KEY);
        const emailRepo = new EmailRepository(db);
        
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
        
        await adapter.fetchLatestSentEmails(5);
      }
    }
  } catch (err: any) {
    logger.warn({ userId, error: err.message }, 'Failed to fetch latest sent emails before manual regeneration');
  }

  const redis = getRedis();
  const { CeleryBridge } = await import('../../workers/celery-bridge.js');
  const bridge = new CeleryBridge(redis);

  const taskId = await bridge.dispatchProfileBuildTask({ userId, correlationId });

  logger.info({ userId, taskId }, 'Manual profile regeneration dispatched');
  res.json({ message: 'Profile regeneration triggered. You will be notified when complete.', taskId });
});

// ============================================================================
// DELETE /profile — Reset the user's profile (forces re-generation on next sync)
// ============================================================================
profileRouter.delete('/', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const db = getDatabase();

  await db('user_profiles').where({ user_id: userId }).del();

  res.json({ message: 'Profile reset. It will be re-generated on next sync.' });
});
