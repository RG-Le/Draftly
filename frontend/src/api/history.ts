import { ApiError, apiRequest } from '../lib/http';
import type { Pagination, SendsHistoryItem } from '../types';

function mapSend(raw: any): SendsHistoryItem {
  return {
    id: String(raw.id),
    draftId: raw.draftId || raw.draft_id,
    threadSubject: raw.threadSubject || raw.thread_subject,
    status: raw.status || 'unknown',
    externalMessageId: raw.externalMessageId || raw.external_message_id || null,
    attemptNumber: raw.attemptNumber || raw.attempt_number,
    queuedAt: raw.queuedAt || raw.queued_at || null,
    completedAt: raw.completedAt || raw.completed_at || null
  };
}

export async function listSendHistory(page = 1, limit = 30): Promise<{
  sends: SendsHistoryItem[];
  pagination: Pagination;
}> {
  try {
    const payload = await apiRequest<any>({
      path: '/api/v1/history/sends',
      method: 'GET',
      query: { page, limit }
    });

    return {
      sends: (payload.sends || []).map(mapSend),
      pagination: payload.pagination || { page, limit }
    };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      return {
        sends: [],
        pagination: { page: 1, limit, total: 0, totalPages: 0 }
      };
    }
    throw error;
  }
}
