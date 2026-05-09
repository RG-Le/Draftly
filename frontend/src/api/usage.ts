import { ApiError, apiRequest } from '../lib/http';
import type { Pagination, UsageRecord, UsageSummary } from '../types';

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
