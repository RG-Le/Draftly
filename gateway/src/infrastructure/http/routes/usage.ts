import { Router, Request, Response } from 'express';
import { getDatabase } from '../../database/connection.js';
import { requireAuth } from '../middleware/auth.js';
import { userRateLimitMiddleware } from '../middleware/rate-limiter.js';

export const usageRouter = Router();

function getPeriodStart(period: string): Date | null {
  const now = new Date();
  const days: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };
  if (days[period] !== undefined) {
    return new Date(now.getTime() - days[period] * 86_400_000);
  }
  return null; // 'all'
}

// ============================================================================
// GET /usage?period=7d|30d|90d|all   (default: 30d)
// Returns aggregated cost, token, and activity metrics for the authenticated user.
// ============================================================================
usageRouter.get('/', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const period = (['7d', '30d', '90d', 'all'].includes(req.query.period as string)
    ? req.query.period as string
    : '30d');
  const db = getDatabase();
  const periodStart = getPeriodStart(period);
  const now = new Date();

  // ── 1. Threads synced ──────────────────────────────────────────────────────
  let threadQ = db('email_threads as t')
    .join('user_connections as uc', 't.connection_id', 'uc.id')
    .where('uc.user_id', userId);
  if (periodStart) threadQ = threadQ.where('t.created_at', '>=', periodStart);
  const threadRow = await threadQ.count('t.id as count').first() as any;

  // ── 2. Triage stats + cost ─────────────────────────────────────────────────
  let triageQ = db('triage_results as tr')
    .join('email_threads as et', 'tr.thread_id', 'et.id')
    .join('user_connections as uc', 'et.connection_id', 'uc.id')
    .where('uc.user_id', userId);
  if (periodStart) triageQ = triageQ.where('tr.created_at', '>=', periodStart);

  const triageStats = await triageQ.clone().select(
    db.raw('COUNT(*) as total'),
    db.raw("SUM(CASE WHEN tr.method = 'heuristic' THEN 1 ELSE 0 END) as heuristic_count"),
    db.raw("SUM(CASE WHEN tr.method = 'llm' OR tr.method = 'batch_llm' THEN 1 ELSE 0 END) as llm_count"),
    db.raw("COALESCE(SUM(CAST(NULLIF(tr.llm_metadata->>'cost', '') AS FLOAT)), 0) as triage_cost"),
    db.raw("COALESCE(SUM(CAST(NULLIF(tr.llm_metadata->>'input_tokens', '') AS INTEGER)), 0) as triage_input"),
    db.raw("COALESCE(SUM(CAST(NULLIF(tr.llm_metadata->>'output_tokens', '') AS INTEGER)), 0) as triage_output"),
  ).first() as any;

  const triageBreakdown = await triageQ.clone()
    .groupBy('tr.classification')
    .select('tr.classification', db.raw('COUNT(*) as count'));

  // ── 3. Draft stats + cost ──────────────────────────────────────────────────
  let draftQ = db('drafts').where({ user_id: userId });
  if (periodStart) draftQ = draftQ.where('created_at', '>=', periodStart);

  const draftStats = await draftQ.clone().select(
    db.raw('COUNT(*) as total'),
    db.raw("COALESCE(SUM(CAST(NULLIF(generation_metadata->>'cost', '') AS FLOAT)), 0) as draft_cost"),
    db.raw("COALESCE(SUM(CAST(NULLIF(generation_metadata->>'input_tokens', '') AS INTEGER)), 0) as draft_input"),
    db.raw("COALESCE(SUM(CAST(NULLIF(generation_metadata->>'output_tokens', '') AS INTEGER)), 0) as draft_output"),
  ).first() as any;

  const draftByStatus = await draftQ.clone()
    .groupBy('status')
    .select('status', db.raw('COUNT(*) as count'));

  // ── 4. Emails sent ─────────────────────────────────────────────────────────
  let sendQ = db('send_attempts as sa')
    .join('drafts as d', 'sa.draft_id', 'd.id')
    .where('d.user_id', userId)
    .where('sa.status', 'delivered');
  if (periodStart) sendQ = sendQ.where('sa.completed_at', '>=', periodStart);
  const sendRow = await sendQ.count('sa.id as count').first() as any;

  // ── 5. Auto-sync preference ────────────────────────────────────────────────
  const autoSyncPref = await db('user_preferences')
    .where({ user_id: userId, key: 'auto_sync' })
    .first();
  const autoSyncVal = autoSyncPref?.value ?? { enabled: false, interval_hours: 24 };

  const connection = await db('user_connections')
    .where({ user_id: userId, connector_type: 'gmail', status: 'active' })
    .first();

  // ── Build response ─────────────────────────────────────────────────────────
  const breakdownMap: Record<string, number> = {};
  for (const row of triageBreakdown) {
    breakdownMap[row.classification] = parseInt(row.count);
  }

  const statusMap: Record<string, number> = {};
  for (const row of draftByStatus) {
    statusMap[row.status] = parseInt(row.count);
  }

  const triageCost = parseFloat(triageStats.triage_cost) || 0;
  const draftCost = parseFloat(draftStats.draft_cost) || 0;

  const triageInput = parseInt(triageStats.triage_input) || 0;
  const triageOutput = parseInt(triageStats.triage_output) || 0;
  const draftInput = parseInt(draftStats.draft_input) || 0;
  const draftOutput = parseInt(draftStats.draft_output) || 0;

  res.json({
    period: {
      label: period,
      from: periodStart?.toISOString() ?? null,
      to: now.toISOString(),
    },
    summary: {
      emailsSynced: parseInt(threadRow?.count) || 0,
      emailsClassified: parseInt(triageStats.total) || 0,
      heuristicClassified: parseInt(triageStats.heuristic_count) || 0,
      llmClassified: parseInt(triageStats.llm_count) || 0,
      triageBreakdown: breakdownMap,
      draftsGenerated: parseInt(draftStats.total) || 0,
      draftsPending: statusMap['generated'] || 0,
      draftsApproved: statusMap['approved'] || 0,
      draftsSent: statusMap['sent'] || 0,
      draftsRejected: statusMap['rejected'] || 0,
      emailsSent: parseInt(sendRow?.count) || 0,
      llmCost: {
        triageUsd: parseFloat(triageCost.toFixed(6)),
        draftingUsd: parseFloat(draftCost.toFixed(6)),
        totalUsd: parseFloat((triageCost + draftCost).toFixed(6)),
      },
      tokens: {
        triageInput,
        triageOutput,
        draftInput,
        draftOutput,
        totalInput: triageInput + draftInput,
        totalOutput: triageOutput + draftOutput,
        grandTotal: triageInput + triageOutput + draftInput + draftOutput,
      },
    },
    autoSync: {
      enabled: autoSyncVal.enabled ?? false,
      intervalHours: autoSyncVal.interval_hours ?? 24,
      lastSyncAt: connection?.last_synced_at ?? null,
    },
  });
});
