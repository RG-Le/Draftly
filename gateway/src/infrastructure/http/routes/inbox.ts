import { Router, Request, Response } from 'express';
import { getDatabase } from '../../database/connection.js';
import { ConnectionRepository } from '../../../domain/connectors/connection.repository.js';
import { requireAuth } from '../middleware/auth.js';
import { userRateLimitMiddleware } from '../middleware/rate-limiter.js';

export const inboxRouter = Router();

// ============================================================================
// GET /inbox — Unified inbox view across active connections
// ============================================================================
inboxRouter.get('/', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const page = parseInt(req.query.page as string) || 1;
  const offset = parseInt(req.query.offset as string) || (page - 1) * limit;
  const categoryFilter = req.query.category as string | undefined;

  const db = getDatabase();
  
  // Get active connection for user (assuming 1 for now, or fetch all active)
  const connectionRepo = new ConnectionRepository(db);
  const connection = await connectionRepo.findByUserAndType(userId, 'gmail');

  if (!connection || connection.status !== 'active') {
    res.json({ threads: [], pagination: { limit, offset, count: 0 } });
    return;
  }

  // Build unified query: join email_threads, triage_results, and drafts
  let query: any = db('email_threads as t')
    .leftJoin('triage_results as tr', 't.id', 'tr.thread_id')
    .leftJoin('drafts as d', 't.id', 'd.thread_id')
    .where('t.connection_id', connection.id);

  if (categoryFilter) {
    query = query.where('tr.classification', categoryFilter);
  }

  // Group by thread ID to handle multiple drafts safely
  query = query
    .select(
      't.id',
      't.external_thread_id',
      't.subject',
      't.participants',
      't.message_count',
      't.last_message_at',
      't.sync_status',
      'tr.classification',
      'tr.confidence',
      'tr.reasoning'
    )
    .max('d.status as draft_status')
    .groupByRaw('t.id, tr.classification, tr.confidence, tr.reasoning, t.external_thread_id, t.subject, t.participants, t.message_count, t.last_message_at, t.sync_status')
    .orderBy('t.last_message_at', 'desc')
    .limit(limit)
    .offset(offset);

  const rows = await query;

  res.json({
    threads: rows.map((r: any) => ({
      id: r.id,
      externalThreadId: r.external_thread_id,
      subject: r.subject,
      participants: typeof r.participants === 'string' ? JSON.parse(r.participants) : r.participants,
      messageCount: r.message_count,
      lastMessageAt: r.last_message_at,
      syncStatus: r.sync_status,
      triage: r.classification ? {
        classification: r.classification,
        confidence: r.confidence,
        reasoning: r.reasoning
      } : null,
      draftStatus: r.draft_status || null
    })),
    pagination: { limit, offset, count: rows.length }
  });
});
