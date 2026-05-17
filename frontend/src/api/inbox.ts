import { ApiError, apiRequest } from '../lib/http';
import type { DraftSummary, Pagination, ThreadDetail, ThreadMessage, ThreadSummary } from '../types';

interface ListThreadsOptions {
  page?: number;
  limit?: number;
  classification?: string;
  category?: string;
}

type InboxApiMode = 'unknown' | 'modern' | 'legacy';
let inboxApiMode: InboxApiMode = 'unknown';
type InboxModernRouteMode = 'unknown' | 'root' | 'threads';
let inboxModernRouteMode: InboxModernRouteMode = 'unknown';

function normalizeDraftStatus(status: string): string {
  if (status === 'edited') return 'draft_edited';
  return status;
}

function toThreadSummary(raw: any): ThreadSummary {
  // Backend responses have evolved over time (joined inbox threads, legacy connectors, etc.).
  // Accept multiple shapes so category tabs + draft indicators keep working across deployments.
  const triageRaw =
    raw.triage ||
    raw.triageResult ||
    raw.triage_result ||
    (raw.classification || raw.category || raw.categoryId || raw.triage_classification
      ? raw
      : null);

  const triageClassification =
    triageRaw?.classification ||
    triageRaw?.category ||
    triageRaw?.categoryId ||
    triageRaw?.triageClassification ||
    triageRaw?.triage_classification ||
    null;

  const triage =
    triageClassification
      ? {
          classification: triageClassification,
          confidence:
            triageRaw?.confidence ??
            triageRaw?.confidenceScore ??
            triageRaw?.confidence_score ??
            null,
          reasoning: triageRaw?.reasoning ?? triageRaw?.explanation ?? null
        }
      : null;

  const latestDraft =
    raw.latestDraft ||
    raw.latest_draft ||
    raw.draft ||
    raw.latestDraftSummary ||
    raw.latest_draft_summary ||
    null;

  return {
    id: String(raw.id),
    subject: raw.subject || '(No subject)',
    participants: raw.participants || [],
    messageCount: raw.messageCount || raw.message_count || 0,
    lastMessageAt: raw.lastMessageAt || raw.last_message_at || null,
    syncStatus: raw.syncStatus || raw.sync_status || 'synced',
    triage,
    latestDraft: latestDraft
      ? {
          id: String(latestDraft.id),
          status: normalizeDraftStatus(latestDraft.status || 'draft_ready'),
          version: latestDraft.version
        }
      : null
  };
}

function toMessage(raw: any): ThreadMessage {
  return {
    id: String(raw.id),
    from: raw.from || raw.fromAddress || '',
    to: raw.to || raw.toAddresses || [],
    cc: raw.cc || raw.ccAddresses || [],
    subject: raw.subject || null,
    bodyText: raw.bodyText || raw.body_text || null,
    bodyHtml: raw.bodyHtml || raw.body_html || null,
    receivedAt: raw.receivedAt || raw.received_at || null,
    isSentByUser: Boolean(raw.isSentByUser || raw.is_sent_by_user)
  };
}

function toDraft(raw: any, threadId: string): DraftSummary {
  const source = raw?.draft || raw?.data?.draft || raw;
  const generatedContent =
    source.generatedContent ||
    source.generated_content ||
    source.draftContent ||
    source.draft_content ||
    source.generatedDraft ||
    source.generated_draft ||
    source.bodyText ||
    source.body_text ||
    source.body ||
    source.content ||
    source.text ||
    null;
  const currentContent =
    source.currentContent ||
    source.current_content ||
    source.editedContent ||
    source.edited_content ||
    source.bodyText ||
    source.body_text ||
    source.body ||
    source.content ||
    generatedContent ||
    null;

  return {
    id: String(source.id),
    threadId,
    status: normalizeDraftStatus(source.status || 'draft_ready'),
    generatedContent,
    currentContent,
    version: source.version || 1,
    createdAt: source.createdAt || source.created_at,
    updatedAt: source.updatedAt || source.updated_at
  };
}

export async function listThreads(options: ListThreadsOptions = {}): Promise<{
  threads: ThreadSummary[];
  pagination: Pagination;
}> {
  const { page = 1, limit = 20 } = options;
  const category = options.category || options.classification;

  // If the user is applying a category filter, prefer modern endpoints (they can join triage and filter server-side).
  // This avoids getting stuck in legacy mode (which cannot filter) after a temporary 404/transition.
  if (inboxApiMode === 'legacy' && !category) {
    const offset = (page - 1) * limit;
    const legacy = await apiRequest<any>({
      path: '/api/v1/connections/gmail/threads',
      method: 'GET',
      query: { limit, offset }
    });

    const threads = (legacy.threads || []).map(toThreadSummary);
    return {
      threads,
      pagination: legacy.pagination || { limit, offset, count: threads.length }
    };
  }

  const runModern = async () => {
    // When filtering by category, always try the joined inbox endpoint first.
    if (category || inboxModernRouteMode !== 'threads') {
      try {
        const payload = await apiRequest<any>({
          path: '/api/v1/inbox',
          method: 'GET',
          query: { page, limit, category, sort: '-lastMessageAt' }
        });
        inboxApiMode = 'modern';
        inboxModernRouteMode = 'root';
        const rawThreads = payload?.threads || payload?.data?.threads || [];
        const threads = rawThreads.map(toThreadSummary);
        const pagination = payload.pagination || payload?.data?.pagination || { page, limit, total: threads.length, totalPages: 1 };
        return { threads, pagination };
      } catch (error) {
        if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 405)) {
          throw error;
        }
      }
    }

    const payload = await apiRequest<any>({
      path: '/api/v1/inbox/threads',
      method: 'GET',
      // Backward compatibility: older servers used `classification`, newer uses `category`.
      query: { page, limit, category, classification: category, sort: '-lastMessageAt' }
    });
    inboxApiMode = 'modern';
    inboxModernRouteMode = 'threads';
    const threads = (payload.threads || []).map(toThreadSummary);
    const pagination = payload.pagination || { page, limit, total: threads.length, totalPages: 1 };
    return { threads, pagination };
  };

  try {
    return await runModern();
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 405)) {
      throw error;
    }
  }

  const offset = (page - 1) * limit;
  const legacy = await apiRequest<any>({
    path: '/api/v1/connections/gmail/threads',
    method: 'GET',
    query: { limit, offset }
  });

  inboxApiMode = 'legacy';
  const threads = (legacy.threads || []).map(toThreadSummary);
  return {
    threads,
    pagination: legacy.pagination || { limit, offset, count: threads.length }
  };
}

export async function getThreadDetail(threadId: string): Promise<ThreadDetail> {
  if (inboxApiMode === 'legacy') {
    const [threadPayload, triagePayload, draftPayload] = await Promise.allSettled([
      apiRequest<any>({ path: `/api/v1/connections/gmail/threads/${threadId}`, method: 'GET' }),
      apiRequest<any>({ path: `/api/v1/connections/gmail/threads/${threadId}/triage`, method: 'GET' }),
      apiRequest<any>({ path: `/api/v1/connections/gmail/threads/${threadId}/draft`, method: 'GET' })
    ]);

    if (threadPayload.status === 'rejected') {
      throw threadPayload.reason;
    }

    const threadData = threadPayload.value;
    const triageData = triagePayload.status === 'fulfilled' ? triagePayload.value : null;
    const draftData = draftPayload.status === 'fulfilled' ? draftPayload.value : null;

    return {
      thread: toThreadSummary(threadData.thread),
      messages: (threadData.messages || []).map(toMessage),
      triage: triageData?.classification
        ? {
            classification: triageData.classification,
            confidence: triageData.confidence ?? triageData.confidenceScore ?? null,
            reasoning: triageData.reasoning ?? null,
            method: triageData.method
          }
        : null,
      draft:
        draftData?.id && draftData?.status !== 'not_generated'
          ? toDraft(draftData, threadId)
          : null
    };
  }

  try {
    const payload = await apiRequest<any>({
      path: `/api/v1/inbox/threads/${threadId}`,
      method: 'GET'
    });
    inboxApiMode = 'modern';

    const [legacyTriagePayload, legacyDraftPayload] = await Promise.allSettled([
      apiRequest<any>({ path: `/api/v1/connections/gmail/threads/${threadId}/triage`, method: 'GET' }),
      apiRequest<any>({ path: `/api/v1/connections/gmail/threads/${threadId}/draft`, method: 'GET' })
    ]);

    const legacyTriage =
      legacyTriagePayload.status === 'fulfilled' && legacyTriagePayload.value?.classification
        ? {
            classification: legacyTriagePayload.value.classification,
            confidence:
              legacyTriagePayload.value.confidence ??
              legacyTriagePayload.value.confidenceScore ??
              null,
            method: legacyTriagePayload.value.method,
            reasoning: legacyTriagePayload.value.reasoning ?? null
          }
        : null;

    const payloadDraft = payload.draft || payload.latestDraft || payload.latest_draft || payload.thread?.draft || payload.thread?.latestDraft || null;

    const legacyDraft =
      legacyDraftPayload.status === 'fulfilled' &&
      (legacyDraftPayload.value?.id || legacyDraftPayload.value?.draft?.id) &&
      (legacyDraftPayload.value?.status || legacyDraftPayload.value?.draft?.status) !== 'not_generated'
        ? toDraft(legacyDraftPayload.value?.draft || legacyDraftPayload.value, threadId)
        : null;

    const fromPayload = payloadDraft ? toDraft(payloadDraft, threadId) : null;
    // Prefer the payload draft when it has actual content; fall back to the legacy draft otherwise.
    const draft =
      (fromPayload?.currentContent || fromPayload?.generatedContent)
        ? fromPayload
        : (legacyDraft ?? fromPayload);

    return {
      thread: toThreadSummary(payload.thread),
      messages: (payload.messages || []).map(toMessage),
      triage: payload.triage
        ? {
            classification: payload.triage.classification,
            confidence: payload.triage.confidence ?? payload.triage.confidenceScore ?? null,
            method: payload.triage.method,
            reasoning: payload.triage.reasoning ?? null
          }
        : legacyTriage,
      draft
    };
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 405)) {
      throw error;
    }
  }

  const [threadPayload, triagePayload, draftPayload] = await Promise.allSettled([
    apiRequest<any>({ path: `/api/v1/connections/gmail/threads/${threadId}`, method: 'GET' }),
    apiRequest<any>({ path: `/api/v1/connections/gmail/threads/${threadId}/triage`, method: 'GET' }),
    apiRequest<any>({ path: `/api/v1/connections/gmail/threads/${threadId}/draft`, method: 'GET' })
  ]);

  if (threadPayload.status === 'rejected') {
    throw threadPayload.reason;
  }

  const threadData = threadPayload.value;
  const triageData = triagePayload.status === 'fulfilled' ? triagePayload.value : null;
  const draftData = draftPayload.status === 'fulfilled' ? draftPayload.value : null;
  inboxApiMode = 'legacy';

  return {
    thread: toThreadSummary(threadData.thread),
    messages: (threadData.messages || []).map(toMessage),
    triage: triageData?.classification
      ? {
          classification: triageData.classification,
          confidence: triageData.confidence ?? triageData.confidenceScore ?? null,
          reasoning: triageData.reasoning ?? null,
          method: triageData.method
        }
      : null,
    draft:
      draftData?.id && draftData?.status !== 'not_generated'
        ? toDraft(draftData, threadId)
        : null
  };
}

export async function generateDraftForThread(threadId: string, draftId?: string, instructions?: string): Promise<any> {
  // Backend now upserts drafts, so we always hit the thread draft endpoint.
  try {
    return await apiRequest({
      path: `/api/v1/connections/gmail/threads/${threadId}/draft`,
      method: 'POST',
      body: { instructions }
    });
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 405)) {
      throw error;
    }
  }

  if (draftId) {
    return apiRequest({
      path: `/api/v1/drafts/${draftId}/regenerate`,
      method: 'POST',
      body: { instructions }
    });
  }

  return apiRequest({
    path: `/api/v1/connections/gmail/threads/${threadId}/draft`,
    method: 'POST',
    body: { instructions }
  });
}

export async function retriageThread(threadId: string, connectorType = 'gmail'): Promise<any> {
  return apiRequest({
    path: `/api/v1/connections/${connectorType}/threads/${threadId}/triage`,
    method: 'POST',
    body: {}
  });
}

interface EditDraftInput {
  threadId: string;
  content: string;
  draftId?: string;
  expectedVersion?: number;
}

export async function editDraft(input: EditDraftInput): Promise<any> {
  const { threadId, draftId, content, expectedVersion } = input;

  if (draftId) {
    try {
      return await apiRequest({
        path: `/api/v1/drafts/${draftId}`,
        method: 'PUT',
        body: { content, expectedVersion }
      });
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 405)) {
        throw error;
      }
    }
  }

  return apiRequest({
    path: `/api/v1/connections/gmail/threads/${threadId}/draft`,
    method: 'PUT',
    body: { content }
  });
}

interface DraftActionInput {
  threadId: string;
  draftId?: string;
  expectedVersion?: number;
  reason?: string;
}

export async function approveDraft(input: DraftActionInput): Promise<any> {
  if (input.draftId) {
    try {
      return await apiRequest({
        path: `/api/v1/drafts/${input.draftId}/approve`,
        method: 'POST',
        body: { expectedVersion: input.expectedVersion }
      });
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 405)) {
        throw error;
      }
    }
  }

  return apiRequest({
    path: `/api/v1/connections/gmail/threads/${input.threadId}/approve`,
    method: 'POST',
    body: {}
  });
}

export async function rejectDraft(input: DraftActionInput): Promise<any> {
  if (input.draftId) {
    try {
      return await apiRequest({
        path: `/api/v1/drafts/${input.draftId}/reject`,
        method: 'POST',
        body: { reason: input.reason || '' }
      });
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 405)) {
        throw error;
      }
    }
  }

  return apiRequest({
    path: `/api/v1/connections/gmail/threads/${input.threadId}/reject`,
    method: 'POST',
    body: { reason: input.reason || '' }
  });
}
