import { Router, Request, Response } from 'express';
import { getDatabase } from '../../database/connection.js';
import { requireAuth } from '../middleware/auth.js';
import { userRateLimitMiddleware } from '../middleware/rate-limiter.js';

export const profileRouter = Router();

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
      lastCalibratedAt: profile.updated_at
    }
  });
});

// ============================================================================
// PUT /profile — Update the user's communication profile
// ============================================================================
profileRouter.put('/', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const db = getDatabase();

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
// DELETE /profile — Reset the user's profile (forces re-generation on next sync)
// ============================================================================
profileRouter.delete('/', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const db = getDatabase();

  await db('user_profiles').where({ user_id: userId }).del();

  res.json({ message: 'Profile reset. It will be re-generated on next sync.' });
});
