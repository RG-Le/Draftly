import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  approveDraft,
  editDraft,
  generateDraftForThread,
  getThreadDetail,
  listThreads,
  rejectDraft,
  retriageThread
} from '../api/inbox';
import { usePipelineStatus } from '../context/PipelineStatusContext';
import { useToast } from '../context/ToastContext';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { DraftEditor } from '../components/DraftEditor';
import { EmptyState } from '../components/EmptyState';
import { LoadingCard } from '../components/LoadingCard';
import { MessageTimeline } from '../components/MessageTimeline';
import { ThreadList } from '../components/ThreadList';
import { getApiErrorMessage } from '../lib/api-error';

const triageFilters = [
  { key: '', label: 'All' },
  { key: 'reply_needed', label: 'Reply Needed' },
  { key: 'info', label: 'Info' },
  { key: 'promotions', label: 'Promotions' },
  { key: 'urgent', label: 'Urgent' },
  { key: 'spam', label: 'Spam' }
];

const PAGE_LIMIT = 20;

export function InboxPage() {
  const { threadId } = useParams();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const {
    draftInProgressThreadIds,
    markDraftCompleted,
    markDraftStarted,
    markTriageStarted,
    markTriageCompleted,
    triageInProgressThreadIds
  } = usePipelineStatus();
  const [classification, setClassification] = useState('');
  const [page, setPage] = useState(1);
  const [draftGenerationThreadId, setDraftGenerationThreadId] = useState<string | null>(null);
  const [draftGenerationStartedAt, setDraftGenerationStartedAt] = useState<number | null>(null);
  const [triageWatchThreadId, setTriageWatchThreadId] = useState<string | null>(null);
  const [triageWatchStartedAt, setTriageWatchStartedAt] = useState<number | null>(null);

  // When navigating from Drafts -> Inbox detail, we want the detail panel visible immediately.
  // Also protects against horizontal scroll caused by long unbroken content.
  useEffect(() => {
    window.scrollTo({ left: 0, top: 0, behavior: 'auto' });
  }, [threadId]);

  const shouldPollPipelines =
    Boolean(threadId) &&
    (draftGenerationThreadId === threadId ||
      triageWatchThreadId === threadId ||
      draftInProgressThreadIds.includes(threadId as string) ||
      triageInProgressThreadIds.includes(threadId as string));

  useEffect(() => {
    setPage(1);
  }, [classification]);

  const threadsQuery = useQuery({
    queryKey: ['threads', classification, page],
    queryFn: () => listThreads({ page, limit: PAGE_LIMIT, category: classification || undefined }),
    refetchInterval: shouldPollPipelines ? 5000 : false
  });

  const detailQuery = useQuery({
    queryKey: ['thread-detail', threadId],
    queryFn: () => getThreadDetail(threadId as string),
    enabled: Boolean(threadId),
    refetchInterval: shouldPollPipelines ? 3000 : false
  });

  const upsertPendingDraftInCache = () => {
    if (!threadId) return;
    queryClient.setQueriesData<any>({ queryKey: ['drafts'] }, (existing: any) => {
      if (!existing?.drafts || !Array.isArray(existing.drafts)) return existing;
      const syntheticId = `pending-${threadId}`;
      const withoutSynthetic = existing.drafts.filter((draft: any) => draft.id !== syntheticId);
      const pendingDraft = {
        id: syntheticId,
        threadId,
        threadSubject: detailQuery.data?.thread?.subject || 'Pending draft',
        status: 'draft_pending',
        currentContent: null,
        generatedContent: null,
        version: 1,
        updatedAt: new Date().toISOString()
      };
      return {
        ...existing,
        drafts: [pendingDraft, ...withoutSynthetic]
      };
    });
  };

  const removePendingDraftFromCache = () => {
    if (!threadId) return;
    const syntheticId = `pending-${threadId}`;
    queryClient.setQueriesData<any>({ queryKey: ['drafts'] }, (existing: any) => {
      if (!existing?.drafts || !Array.isArray(existing.drafts)) return existing;
      return {
        ...existing,
        drafts: existing.drafts.filter((draft: any) => draft.id !== syntheticId)
      };
    });
  };

  const actionMutation = useMutation({
    mutationFn: async (input: { action: 'save' | 'regenerate' | 'approve' | 'reject'; content?: string }) => {
      if (!threadId) return;
      const detail = detailQuery.data;
      const draft = detail?.draft;

      if (input.action === 'save') {
        return editDraft({
          threadId,
          draftId: draft?.id,
          expectedVersion: draft?.version,
          content: input.content || ''
        });
      }

      if (input.action === 'regenerate') {
        return generateDraftForThread(threadId, draft?.id);
      }

      if (input.action === 'approve') {
        return approveDraft({
          threadId,
          draftId: draft?.id,
          expectedVersion: draft?.version
        });
      }

      return rejectDraft({
        threadId,
        draftId: draft?.id
      });
    },
    onSuccess: (_data, variables) => {
      if (variables.action === 'regenerate' && threadId) {
        markDraftStarted(threadId);
        setDraftGenerationThreadId(threadId);
        setDraftGenerationStartedAt(Date.now());
        queryClient.setQueryData<any>(['thread-detail', threadId], (existing: any) => {
          if (!existing) return existing;
          return {
            ...existing,
            draft: existing.draft
              ? { ...existing.draft, status: 'draft_pending' }
              : {
                  id: `pending-${threadId}`,
                  threadId,
                  status: 'draft_pending',
                  currentContent: null,
                  generatedContent: null,
                  version: 1
                }
          };
        });
        upsertPendingDraftInCache();
      }

      pushToast({
        title:
          variables.action === 'save'
            ? 'Draft saved'
            : variables.action === 'approve'
              ? 'Draft approved'
              : variables.action === 'reject'
                ? 'Draft rejected'
                : 'Draft generation queued',
        description:
          variables.action === 'regenerate'
            ? 'We are monitoring draft generation and will refresh this thread automatically.'
            : 'Workspace updated.',
        tone: 'success'
      });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['thread-detail', threadId] });
      queryClient.invalidateQueries({ queryKey: ['drafts'] });
      queryClient.invalidateQueries({ queryKey: ['sends'] });
    },
    onError: (error: any) => {
      pushToast({
        title: 'Action failed',
        description: getApiErrorMessage(error, 'Could not complete this draft action.'),
        tone: 'danger'
      });
    }
  });

  const threads = threadsQuery.data?.threads || [];
  const selectedThread = detailQuery.data;
  const isDraftPipelineRunning =
    Boolean(threadId) &&
    (draftGenerationThreadId === threadId || draftInProgressThreadIds.includes(threadId as string));
  const isTriagePipelineRunning =
    Boolean(threadId) &&
    ((triageWatchThreadId === threadId && !selectedThread?.triage) ||
      triageInProgressThreadIds.includes(threadId as string));
  const classificationFilterBackendLimited =
    Boolean(classification) && threads.length > 0 && threads.every((thread) => !thread.triage?.classification);

  const pendingTriageCount = useMemo(() => {
    if (!threads.length) return 0;
    const pendingIds = new Set(triageInProgressThreadIds);
    return threads.filter((thread) => pendingIds.has(thread.id) || (!thread.triage?.classification && Boolean(triageInProgressThreadIds.length))).length;
  }, [threads, triageInProgressThreadIds]);

  const pendingDraftCount = useMemo(() => {
    if (!threads.length) return 0;
    const pendingIds = new Set(draftInProgressThreadIds);
    return threads.filter((thread) => pendingIds.has(thread.id)).length;
  }, [threads, draftInProgressThreadIds]);

  useEffect(() => {
    window.scrollTo({ left: 0, top: 0, behavior: 'auto' });
  }, [threadId]);

  useEffect(() => {
    if (!threadId) {
      setTriageWatchThreadId(null);
      setTriageWatchStartedAt(null);
      return;
    }
    if (selectedThread && !selectedThread.triage && triageWatchThreadId !== threadId) {
      markTriageStarted(threadId);
      setTriageWatchThreadId(threadId);
      setTriageWatchStartedAt(Date.now());
    }
    if (selectedThread?.triage && triageWatchThreadId === threadId) {
      setTriageWatchThreadId(null);
      setTriageWatchStartedAt(null);
    }
  }, [selectedThread, threadId, triageWatchThreadId, markTriageStarted]);

  useEffect(() => {
    if (!threadId || draftGenerationThreadId !== threadId) return;

    if (selectedThread?.draft && selectedThread.draft.status !== 'draft_pending') {
      markDraftCompleted(threadId);
      setDraftGenerationThreadId(null);
      setDraftGenerationStartedAt(null);
      removePendingDraftFromCache();
      queryClient.invalidateQueries({ queryKey: ['drafts'] });
      pushToast({
        title: 'Draft ready',
        description: 'Draft generation has finished for this thread.',
        tone: 'success'
      });
      return;
    }

    if (draftGenerationStartedAt && Date.now() - draftGenerationStartedAt > 2 * 60 * 1000) {
      setDraftGenerationThreadId(null);
      setDraftGenerationStartedAt(null);
      pushToast({
        title: 'Draft still processing',
        description: 'Generation may still be running in backend. Refresh shortly.',
        tone: 'info'
      });
    }
  }, [
    draftGenerationStartedAt,
    draftGenerationThreadId,
    queryClient,
    removePendingDraftFromCache,
    selectedThread,
    threadId,
    pushToast,
    markDraftCompleted
  ]);

  useEffect(() => {
    if (!threadId || triageWatchThreadId !== threadId || !triageWatchStartedAt) return;
    if (selectedThread?.triage) {
      markTriageCompleted(threadId);
      return;
    }

    if (Date.now() - triageWatchStartedAt > 2 * 60 * 1000) {
      setTriageWatchThreadId(null);
      setTriageWatchStartedAt(null);
      pushToast({
        title: 'Triage still pending',
        description: 'Classification is not ready yet. Backend triage may still be processing.',
        tone: 'info'
      });
    }
  }, [threadId, triageWatchThreadId, triageWatchStartedAt, selectedThread, pushToast, markTriageCompleted]);

  const triageTone = useMemo(() => {
    const classificationValue = selectedThread?.triage?.classification;
    if (!classificationValue) return 'neutral';
    if (classificationValue === 'reply_needed') return 'warning';
    if (classificationValue === 'promotions') return 'info';
    if (classificationValue === 'info') return 'neutral';
    return 'neutral';
  }, [selectedThread?.triage?.classification]);

  const retriageMutation = useMutation({
    mutationFn: async () => {
      if (!threadId) return;
      return retriageThread(threadId, 'gmail');
    },
    onSuccess: () => {
      if (!threadId) return;
      markTriageStarted(threadId);
      setTriageWatchThreadId(threadId);
      setTriageWatchStartedAt(Date.now());
      queryClient.setQueryData<any>(['thread-detail', threadId], (existing: any) => {
        if (!existing) return existing;
        return { ...existing, triage: null };
      });
      pushToast({
        title: 'Re-classify queued',
        description: 'We are re-running triage and will refresh this thread automatically.',
        tone: 'info'
      });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
    },
    onError: (error: any) => {
      pushToast({
        title: 'Re-classify failed',
        description: getApiErrorMessage(error, 'Could not trigger re-triage.'),
        tone: 'danger'
      });
    }
  });

  return (
    <div className="workspace">
      <section className="panel thread-panel">
        <div className="panel-header">
          <h2>Inbox Review Queue</h2>
          <select
            className="category-filter"
            value={classification}
            onChange={(e) => setClassification(e.target.value)}
          >
            {triageFilters.map((filter) => (
              <option key={filter.key} value={filter.key}>{filter.label}</option>
            ))}
          </select>
        </div>
        {classificationFilterBackendLimited ? (
          <p className="status-note warning">
            Category filtering needs the backend inbox endpoint to join triage results (and accept category filters). Right now this view is using a threads list without triage, so it may still show all threads.
          </p>
        ) : null}
        {pendingTriageCount || pendingDraftCount ? (
          <p className="status-note info">
            {pendingTriageCount ? `${pendingTriageCount} thread(s) pending triage.` : ''}
            {pendingTriageCount && pendingDraftCount ? ' ' : ''}
            {pendingDraftCount ? `${pendingDraftCount} thread(s) pending draft generation.` : ''}
          </p>
        ) : null}
        {isTriagePipelineRunning || isDraftPipelineRunning ? (
          <p className="status-note info">
            {isTriagePipelineRunning ? 'Triage pipeline in progress.' : ''} {isDraftPipelineRunning ? 'Draft generation in progress.' : ''}
          </p>
        ) : null}

        {threadsQuery.isLoading ? (
          <LoadingCard lines={5} />
        ) : threads.length === 0 && page === 1 ? (
          <EmptyState
            title="No threads yet"
            description="Start a sync to pull inbox threads into the review queue."
          />
        ) : (
          <>
            <ThreadList
              threads={threads}
              selectedThreadId={threadId}
              pendingTriageThreadIds={triageInProgressThreadIds}
              pendingDraftThreadIds={draftInProgressThreadIds}
            />
            <div className="pagination">
              <button
                className="pagination-btn"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ← Previous
              </button>
              <span className="pagination-info">Page {page}</span>
              <button
                className="pagination-btn"
                disabled={threads.length < PAGE_LIMIT}
                onClick={() => setPage((p) => p + 1)}
              >
                Next →
              </button>
            </div>
          </>
        )}
      </section>

      <section className="panel detail-panel">
        {!threadId ? (
          <EmptyState
            title="Choose a thread"
            description="Select any thread from the left panel to inspect messages and draft."
          />
        ) : detailQuery.isLoading ? (
          <LoadingCard lines={8} />
        ) : selectedThread ? (
          <>
            <div className="panel-header">
              <div>
                <h2>{selectedThread.thread.subject || '(No subject)'}</h2>
                <p>
                  {selectedThread.thread.messageCount} messages in thread
                </p>
              </div>
              <div className="header-badges">
                <Badge
                  label={selectedThread.triage?.classification || 'unclassified'}
                  tone={triageTone}
                />
                {isTriagePipelineRunning ? <Badge label="triage_pending" tone="warning" /> : null}
                {isDraftPipelineRunning ? <Badge label="draft_pending" tone="warning" /> : null}
                {selectedThread.triage?.confidence ? (
                  <span className="confidence">
                    {Math.round(selectedThread.triage.confidence * 100)}% confidence
                  </span>
                ) : null}
                <Button
                  variant="ghost"
                  onClick={() => retriageMutation.mutate()}
                  loading={retriageMutation.isPending}
                >
                  Re-classify
                </Button>
              </div>
            </div>

            {selectedThread.triage?.reasoning ? (
              <p className="reasoning">{selectedThread.triage.reasoning}</p>
            ) : null}

            <div className="split-grid">
              <div className="subpanel">
                <h3>Message Timeline</h3>
                <MessageTimeline messages={selectedThread.messages} />
              </div>

              <div className="subpanel">
                {selectedThread.draft ? (
                  <DraftEditor
                    value={selectedThread.draft.currentContent || selectedThread.draft.generatedContent}
                    status={selectedThread.draft.status}
                    version={selectedThread.draft.version}
                    loading={actionMutation.isPending || isDraftPipelineRunning}
                    onSave={async (content) => actionMutation.mutateAsync({ action: 'save', content })}
                    onRegenerate={async () => actionMutation.mutateAsync({ action: 'regenerate' })}
                    onApprove={async () => actionMutation.mutateAsync({ action: 'approve' })}
                    onReject={async () => actionMutation.mutateAsync({ action: 'reject' })}
                  />
                ) : (
                  <EmptyState
                    title="No draft generated"
                    description="Generate a draft manually for this thread."
                    action={
                      <Button
                        onClick={() => actionMutation.mutate({ action: 'regenerate' })}
                        loading={actionMutation.isPending || isDraftPipelineRunning}
                      >
                        Generate draft
                      </Button>
                    }
                  />
                )}
              </div>
            </div>
          </>
        ) : (
          <EmptyState
            title="Thread unavailable"
            description="This thread could not be loaded right now."
            action={
              <Link to="/app/inbox" className="inline-link">
                Back to inbox
              </Link>
            }
          />
        )}
      </section>
    </div>
  );
}
