import { useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { getApiBaseUrl } from '../lib/http';
import { useAuth } from '../context/AuthContext';
import { usePipelineStatus } from '../context/PipelineStatusContext';
import { useToast } from '../context/ToastContext';

function invalidateCoreQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['connections'] });
  queryClient.invalidateQueries({ queryKey: ['threads'] });
  queryClient.invalidateQueries({ queryKey: ['thread-detail'] });
  queryClient.invalidateQueries({ queryKey: ['drafts'] });
  queryClient.invalidateQueries({ queryKey: ['sends'] });
}

export function useRealtimeEvents(enabled = true) {
  const { accessToken, isAuthenticated } = useAuth();
  const {
    markDraftCompleted,
    markDraftFailed,
    markDraftStarted,
    markSyncCompleted,
    markSyncFailed,
    markSyncStarted,
    markTriageCompleted,
    markTriageFailed,
    markTriageStarted
  } = usePipelineStatus();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || !isAuthenticated || !accessToken) return;

    const socket: Socket = io(getApiBaseUrl(), {
      // Allow polling fallback when WebSocket is blocked by proxy/CORS.
      transports: ['websocket', 'polling'],
      auth: { token: accessToken }
    });

    const notify = (title: string, description: string, tone: 'info' | 'success' | 'warning' | 'danger' = 'info') => {
      pushToast({ title, description, tone });
    };

    const handlers: Record<string, (payload: any) => void> = {
      'sync:started': () => {
        markSyncStarted();
        notify('Sync started', 'Inbox synchronization has started.', 'info');
      },
      'sync:completed': (payload) => {
        markSyncCompleted();
        notify(
          'Sync completed',
          `Updated ${payload?.updatedThreads ?? 0} threads and found ${payload?.newThreads ?? 0} new threads.`,
          'success'
        );
        invalidateCoreQueries(queryClient);
      },
      'sync:failed': (payload) => {
        markSyncFailed();
        notify('Sync failed', payload?.error || 'Unable to sync inbox right now.', 'danger');
      },
      'triage:started': (payload) => {
        markTriageStarted(payload?.threadId);
        notify('Triage started', 'Thread classification is running.', 'info');
      },
      triage_completed: (payload) => {
        markTriageCompleted(payload?.threadId);
        notify(
          'Triage complete',
          `Thread classified as ${payload?.classification || 'unknown'}.`,
          'info'
        );
        invalidateCoreQueries(queryClient);
      },
      triage_generated: (payload) => {
        markTriageCompleted(payload?.threadId);
        notify('Triage complete', `Thread classified as ${payload?.classification || 'unknown'}.`, 'info');
        invalidateCoreQueries(queryClient);
      },
      'triage:completed': (payload) => {
        markTriageCompleted(payload?.threadId);
        notify(
          'Triage complete',
          `Thread classified as ${payload?.classification || 'unknown'}.`,
          'info'
        );
        invalidateCoreQueries(queryClient);
      },
      'triage:generated': (payload) => {
        markTriageCompleted(payload?.threadId);
        notify('Triage complete', `Thread classified as ${payload?.classification || 'unknown'}.`, 'info');
        invalidateCoreQueries(queryClient);
      },
      'triage:failed': (payload) => {
        markTriageFailed(payload?.threadId);
        notify('Triage failed', payload?.error || 'Could not classify thread.', 'danger');
      },
      'draft:started': (payload) => {
        markDraftStarted(payload?.threadId);
        notify('Draft started', 'Draft generation is running for this thread.', 'info');
      },
      draft_generated: (payload) => {
        markDraftCompleted(payload?.threadId);
        notify('Draft ready', 'A new draft is now available for review.', 'success');
        invalidateCoreQueries(queryClient);
      },
      'draft:generated': (payload) => {
        markDraftCompleted(payload?.threadId);
        notify('Draft ready', 'A new draft is now available for review.', 'success');
        invalidateCoreQueries(queryClient);
      },
      'draft:ready': (payload) => {
        markDraftCompleted(payload?.threadId);
        notify('Draft ready', 'A new draft is now available for review.', 'success');
        invalidateCoreQueries(queryClient);
      },
      'draft:failed': (payload) => {
        markDraftFailed(payload?.threadId);
        notify('Draft failed', payload?.error || 'Draft generation failed.', 'danger');
      },
      'draft:sending': () => {
        notify('Sending reply', 'Approved draft is being dispatched to Gmail.', 'info');
      },
      'send:success': () => {
        notify('Email sent', 'Approved reply sent successfully.', 'success');
        invalidateCoreQueries(queryClient);
      },
      'send:failed': (payload) => {
        notify('Send failed', payload?.error || 'Reply could not be sent.', 'danger');
      },
      'connection:expiring': (payload) => {
        notify('Connection expiring', `Reconnect before ${payload?.expiresAt || 'soon'}.`, 'warning');
      },
      'connection:expired': () => {
        notify('Connection expired', 'Reconnect Gmail to continue syncing and sending.', 'warning');
        invalidateCoreQueries(queryClient);
      },
      'profile:initialized': () => {
        queryClient.invalidateQueries({ queryKey: ['profile'] });
      },
      'triage:batch_started': (payload) => {
        notify(
          'Batch triage started',
          `Classifying ${payload?.threadCount ?? 'multiple'} threads.`,
          'info'
        );
      },
      'triage:batch_completed': (payload) => {
        const results: Array<{ threadId: string; classification: string }> = payload?.results || [];
        if (results.length > 0) {
          const classMap = new Map(results.map((r) => [r.threadId, r.classification]));
          queryClient.setQueriesData<any>({ queryKey: ['threads'] }, (existing: any) => {
            if (!existing?.threads) return existing;
            return {
              ...existing,
              threads: existing.threads.map((t: any) => {
                const newClass = classMap.get(t.id);
                if (!newClass) return t;
                return { ...t, triage: { ...(t.triage || {}), classification: newClass } };
              })
            };
          });
          results.forEach((r) => {
            queryClient.invalidateQueries({ queryKey: ['thread-detail', r.threadId] });
          });
        }
        notify(
          'Batch triage complete',
          `${results.length} thread${results.length !== 1 ? 's' : ''} classified.`,
          'success'
        );
      },
      'triage:batch_failed': (payload) => {
        notify('Batch triage failed', payload?.error || 'Could not classify threads.', 'danger');
      }
    };

    Object.entries(handlers).forEach(([event, handler]) => socket.on(event, handler));

    socket.on('connect_error', (err: any) => {
      const message = err?.message ? String(err.message) : 'Unable to connect to realtime server.';
      const origin = window.location.origin;
      notify(
        'Realtime unavailable',
        `${message} (server: ${getApiBaseUrl()}, ui: ${origin}). Check backend Socket.IO CORS_ORIGINS includes the UI origin.`,
        'warning'
      );
    });

    socket.on('disconnect', (reason) => {
      // Keep this non-fatal: HTTP APIs still work without realtime.
      notify('Realtime disconnected', `Live updates paused (${reason}).`, 'warning');
    });

    return () => {
      Object.entries(handlers).forEach(([event, handler]) => socket.off(event, handler));
      socket.disconnect();
    };
  }, [
    enabled,
    isAuthenticated,
    accessToken,
    pushToast,
    queryClient,
    markDraftCompleted,
    markDraftFailed,
    markDraftStarted,
    markSyncCompleted,
    markSyncFailed,
    markSyncStarted,
    markTriageCompleted,
    markTriageFailed,
    markTriageStarted
  ]);
}
