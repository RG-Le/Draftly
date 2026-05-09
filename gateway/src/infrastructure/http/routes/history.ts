import { Router, Request, Response } from 'express';
import { getDatabase } from '../../database/connection.js';
import { requireAuth } from '../middleware/auth.js';
import { userRateLimitMiddleware } from '../middleware/rate-limiter.js';

export const historyRouter = Router();

// ============================================================================
// GET /history/sends — Get the user's email send history
// ============================================================================
historyRouter.get('/sends', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const db = getDatabase();

  try {
    const sends = await db('send_attempts as sa')
      .join('drafts as d', 'sa.draft_id', 'd.id')
      .join('email_threads as t', 'd.thread_id', 't.id')
      .where('d.user_id', userId)
      .select(
        'sa.id',
        'sa.status',
        'sa.queued_at',
        'sa.completed_at',
        'sa.error_message',
        'd.id as draft_id',
        'd.current_content',
        't.subject',
        't.external_thread_id'
      )
      .orderBy('sa.queued_at', 'desc')
      .limit(50);

    res.json({
      sends: sends.map(s => ({
        id: s.id,
        status: s.status,
        queuedAt: s.queued_at,
        completedAt: s.completed_at,
        errorMessage: s.error_message,
        draftId: s.draft_id,
        content: s.current_content,
        subject: s.subject,
        externalThreadId: s.external_thread_id
      }))
    });
  } catch (error) {
    console.error('Error fetching send history:', error);
    res.status(500).json({ error: 'Failed to fetch send history' });
  }
});
