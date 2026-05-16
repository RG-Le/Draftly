import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getMe, logout } from '../api/auth';
import {
  getPrimaryGmailConnection,
  isConnectionActive,
  listConnections,
  needsInitialConnection,
  needsReconnect,
  reconnectGmailConnection,
  startGmailConnection,
  syncInbox
} from '../api/connections';
import { useAuth } from '../context/AuthContext';
import { usePipelineStatus } from '../context/PipelineStatusContext';
import { useToast } from '../context/ToastContext';
import { useRealtimeEvents } from '../hooks/useRealtimeEvents';
import { AppShell } from '../components/AppShell';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { getApiErrorMessage } from '../lib/api-error';

export function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, patchUser, clearSession, refreshToken } = useAuth();
  const { syncInProgress: realtimeSyncInProgress, markSyncCompleted, markSyncStarted, triageBanner, setTriageBanner } = usePipelineStatus();
  const { pushToast } = useToast();
  const [syncMonitor, setSyncMonitor] = useState<{ startedAt: number; baselineLastSyncedAt: string | null } | null>(null);

  useRealtimeEvents(true);

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: getMe,
    staleTime: 1000 * 60
  });

  useEffect(() => {
    if (meQuery.data) {
      patchUser(meQuery.data);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meQuery.data]);

  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: listConnections,
    staleTime: 1000 * 30,
    refetchInterval: syncMonitor ? 4000 : false
  });

  const connectMutation = useMutation({
    mutationFn: (targetRedirectUri: string) => {
      if (needsReconnect(connection)) {
        return reconnectGmailConnection(targetRedirectUri);
      }
      return startGmailConnection(targetRedirectUri);
    },
    onSuccess: (result) => {
      window.location.href = result.authUrl;
    },
    onError: (error: any) => {
      pushToast({
        title: 'Connect failed',
        description: error?.message || 'Could not initiate Gmail connection.',
        tone: 'danger'
      });
    }
  });

  const syncMutation = useMutation({
    mutationFn: () => {
      if (!connection || needsInitialConnection(connection)) {
        throw new Error('Connect Gmail first.');
      }
      if (needsReconnect(connection) || !isConnectionActive(connection)) {
        throw new Error('Connection is revoked/expired. Reconnect Gmail first.');
      }
      return syncInbox(connection.id, 7);
    },
    onSuccess: () => {
      markSyncStarted();
      setSyncMonitor({
        startedAt: Date.now(),
        baselineLastSyncedAt: connection?.lastSyncedAt || null
      });
      pushToast({
        title: 'Sync queued',
        description: 'Inbox sync has been scheduled.',
        tone: 'success'
      });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (error: any) => {
      pushToast({
        title: 'Sync failed',
        description: getApiErrorMessage(error, 'Could not queue inbox sync.'),
        tone: 'danger'
      });
    }
  });

  const connection = getPrimaryGmailConnection(connectionsQuery.data || []);
  const redirectUri = `${window.location.origin}${location.pathname}${location.search}`;
  const syncInProgress = realtimeSyncInProgress || Boolean(syncMonitor) || syncMutation.isPending;
  const syncStatusHint = syncInProgress ? 'Sync and downstream triage/draft pipeline is running. Updates will appear automatically.' : undefined;

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('gmail_connected') !== 'true') return;

    setSyncMonitor({
      startedAt: Date.now(),
      baselineLastSyncedAt: connection?.lastSyncedAt || null
    });
    markSyncStarted();
    pushToast({
      title: 'Gmail connected',
      description: 'Initial sync has been queued and we are monitoring progress.',
      tone: 'success'
    });
    params.delete('gmail_connected');
    params.delete('connectionId');
    navigate(
      {
        pathname: location.pathname,
        search: params.toString() ? `?${params.toString()}` : ''
      },
      { replace: true }
    );
  }, [location.pathname, location.search, connection?.lastSyncedAt, navigate, pushToast, markSyncStarted]);

  useEffect(() => {
    if (!syncMonitor || !connection) return;

    const syncCompleted =
      Boolean(connection.lastSyncedAt) && connection.lastSyncedAt !== syncMonitor.baselineLastSyncedAt;

    if (syncCompleted) {
      markSyncCompleted();
      setSyncMonitor(null);
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      pushToast({
        title: 'Sync finished',
        description: `Last sync result: ${connection.lastSyncStatus || 'unknown'}.`,
        tone: connection.lastSyncStatus === 'error' ? 'danger' : 'success'
      });
      return;
    }

    const elapsedMs = Date.now() - syncMonitor.startedAt;
    if (elapsedMs > 3 * 60 * 1000) {
      markSyncCompleted();
      setSyncMonitor(null);
      pushToast({
        title: 'Sync still processing',
        description: 'Processing may still be in background. You can continue working and refresh shortly.',
        tone: 'info'
      });
    }
  }, [connection, queryClient, pushToast, syncMonitor, markSyncCompleted]);

  return (
    <AppShell
      user={user}
      onLogout={async () => {
        try {
          await logout(refreshToken || undefined);
        } catch {
          // We still clear session locally when logout endpoint is unavailable.
        } finally {
          clearSession();
          navigate('/');
        }
      }}
    >
      <div className="app-content">
        {triageBanner ? (
          <div className={`triage-banner triage-banner-${triageBanner.type}`}>
            <span>{triageBanner.message}</span>
            <div className="triage-banner-actions">
              {triageBanner.type === 'failed' && triageBanner.permanent && (
                <button
                  className="triage-banner-btn"
                  onClick={() => syncMutation.mutate()}
                >
                  Retry Sync
                </button>
              )}
              {!triageBanner.permanent && (
                <button className="triage-banner-close" onClick={() => setTriageBanner(null)} aria-label="Dismiss">×</button>
              )}
            </div>
          </div>
        ) : null}
        <ConnectionBanner
          connection={connection}
          onConnect={() => connectMutation.mutate(redirectUri)}
          onSync={() => syncMutation.mutate()}
          syncInProgress={syncInProgress}
          syncStatusHint={syncStatusHint}
        />
        <Outlet />
      </div>
    </AppShell>
  );
}
