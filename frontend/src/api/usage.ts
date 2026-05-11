import { ApiError, apiRequest } from '../lib/http';
import type { Pagination, UsageRecord, UsageSummary, UsageStats } from '../types';

export async function getUsageSummary(month: string): Promise<UsageSummary | null> {
  try {
    const payload = await apiRequest<any>({
      path: '/api/v1/usage/summary',
      method: 'GET',
      query: { month }
    });

    return {
      month: payload.month || month,
      totalEstimatedCost: payload.totalEstimatedCost ?? payload.totalCost ?? 0,
      currency: payload.currency || 'USD',
      breakdown: payload.breakdown || {}
    };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      return null;
    }
    throw error;
  }
}

function mapUsageStats(payload: any, period: string): UsageStats {
  const r = payload || {};
  return {
    period,
    emailsSynced: r.emailsSynced ?? r.emails_synced ?? 0,
    emailsClassified: r.emailsClassified ?? r.emails_classified ?? 0,
    heuristicClassified: r.heuristicClassified ?? r.heuristic_classified ?? 0,
    llmClassified: r.llmClassified ?? r.llm_classified ?? 0,
    triageBreakdown: r.triageBreakdown ?? r.triage_breakdown ?? {},
    draftsGenerated: r.draftsGenerated ?? r.drafts_generated ?? 0,
    draftsApproved: r.draftsApproved ?? r.drafts_approved ?? 0,
    draftsSent: r.draftsSent ?? r.drafts_sent ?? 0,
    totalLlmCostUsd: r.totalLlmCostUsd ?? r.total_llm_cost_usd ?? r.totalEstimatedCost ?? r.totalCost ?? 0,
    totalInputTokens: r.totalInputTokens ?? r.total_input_tokens ?? 0,
    totalOutputTokens: r.totalOutputTokens ?? r.total_output_tokens ?? 0
  };
}

export async function getUsageStats(period: string): Promise<UsageStats | null> {
  try {
    const payload = await apiRequest<any>({
      path: '/api/v1/usage',
      method: 'GET',
      query: { period }
    });
    return mapUsageStats(payload.stats ?? payload.data ?? payload, period);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      return null;
    }
    throw error;
  }
}

export async function listUsageRecords(
  from?: string,
  to?: string
): Promise<{ records: UsageRecord[]; pagination: Pagination }> {
  try {
    const payload = await apiRequest<any>({
      path: '/api/v1/usage',
      method: 'GET',
      query: { from, to, page: 1, limit: 100 }
    });

    return {
      records: payload.records || [],
      pagination: payload.pagination || { page: 1, limit: 100 }
    };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      return { records: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 0 } };
    }
    throw error;
  }
}
