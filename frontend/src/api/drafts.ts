import { ApiError, apiRequest } from '../lib/http';
import type { DraftSummary, Pagination } from '../types';

function normalizeStatus(status: string): string {
  return status === 'edited' ? 'draft_edited' : status;
}

function mapDraft(raw: any): DraftSummary {
  const generatedContent =
    raw.generatedContent ||
    raw.generated_content ||
    raw.bodyText ||
    raw.body_text ||
    raw.content ||
    raw.text ||
    null;
  const currentContent =
    raw.currentContent ||
    raw.current_content ||
    raw.bodyText ||
    raw.body_text ||
    raw.content ||
    generatedContent ||
    null;

  return {
    id: String(raw.id),
    threadId: String(raw.threadId || raw.thread_id || ''),
    threadSubject: raw.threadSubject || raw.thread_subject || '',
    status: normalizeStatus(raw.status || 'draft_ready'),
    generatedContent,
    currentContent,
    version: raw.version || 1,
    createdAt: raw.createdAt || raw.created_at,
    updatedAt: raw.updatedAt || raw.updated_at
  };
}

export async function listDrafts(status?: string): Promise<{ drafts: DraftSummary[]; pagination: Pagination }> {
  try {
    const payload = await apiRequest<any>({
      path: '/api/v1/drafts',
      method: 'GET',
      query: { status, page: 1, limit: 50 }
    });

    return {
      drafts: (payload.drafts || []).map(mapDraft),
      pagination: payload.pagination || { page: 1, limit: 50 }
    };
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 405)) {
      throw error;
    }
  }

  // Legacy fallback: avoid fanning out into N thread-detail calls (which can easily trip rate limits).
  // If /drafts is not available, we can still build a "draft queue" view from the joined threads list.
  const { listThreads } = await import('./inbox');
  const threadsResponse = await listThreads({ page: 1, limit: 50 });

  const drafts = threadsResponse.threads
    .filter((thread) => Boolean(thread.latestDraft))
    .map((thread) => ({
      id: String(thread.latestDraft!.id),
      threadId: thread.id,
      threadSubject: thread.subject,
      status: normalizeStatus(thread.latestDraft!.status),
      generatedContent: null,
      currentContent: null,
      version: thread.latestDraft!.version || 1,
      createdAt: thread.lastMessageAt,
      updatedAt: thread.lastMessageAt
    })) as DraftSummary[];

  const filtered = status ? drafts.filter((draft) => draft.status === status) : drafts;
  return {
    drafts: filtered,
    pagination: { page: 1, limit: 50, total: filtered.length, totalPages: 1 }
  };
}

export async function getDraftById(draftId: string): Promise<DraftSummary> {
  const payload = await apiRequest<any>({
    path: `/api/v1/drafts/${draftId}`,
    method: 'GET'
  });

  return mapDraft(payload.draft || payload);
}
