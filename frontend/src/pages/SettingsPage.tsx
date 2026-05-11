import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import {
  disconnectConnection,
  getPrimaryGmailConnection,
  isConnectionActive,
  listConnections,
  needsInitialConnection,
  needsReconnect,
  reconnectGmailConnection,
  startGmailConnection,
  syncInbox
} from '../api/connections';
import {
  getAutoSyncPreference,
  getProfile,
  updateAutoSyncPreference,
  updateProfile
} from '../api/profile';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { LoadingCard } from '../components/LoadingCard';
import { useToast } from '../context/ToastContext';
import { getApiErrorMessage } from '../lib/api-error';
import { formatRelativeTime } from '../lib/format';

export function SettingsPage() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: getProfile
  });

  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: listConnections
  });

  const autoSyncQuery = useQuery({
    queryKey: ['auto-sync-preference'],
    queryFn: getAutoSyncPreference
  });

  const [signatureTemplate, setSignatureTemplate] = useState('');
  const [preferredTone, setPreferredTone] = useState('professional');
  const [personalizedProfile, setPersonalizedProfile] = useState('');
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(false);
  const [autoSyncInterval, setAutoSyncInterval] = useState(24);

  useEffect(() => {
    if (profileQuery.data) {
      setSignatureTemplate(profileQuery.data.signatureTemplate || '');
      setPreferredTone(profileQuery.data.preferredTone || 'professional');
      setPersonalizedProfile(profileQuery.data.personalizedProfile || '');
    }
  }, [profileQuery.data]);

  useEffect(() => {
    if (autoSyncQuery.data) {
      setAutoSyncEnabled(autoSyncQuery.data.enabled);
      setAutoSyncInterval(autoSyncQuery.data.intervalHours ?? 24);
    }
  }, [autoSyncQuery.data]);

  const connection = useMemo(
    () => getPrimaryGmailConnection(connectionsQuery.data || []),
    [connectionsQuery.data]
  );

  const profileMutation = useMutation({
    mutationFn: (event: FormEvent) => {
      event.preventDefault();
      return updateProfile({
        signatureTemplate,
        preferredTone,
        personalizedProfile
      });
    },
    onSuccess: () => {
      pushToast({
        title: 'Profile updated',
        description: 'Writing preferences were saved.',
        tone: 'success'
      });
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
    onError: (error: any) => {
      pushToast({
        title: 'Profile update failed',
        description: error?.message || 'Could not save profile.',
        tone: 'danger'
      });
    }
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
    onError: (error) => {
      pushToast({
        title: 'Connect failed',
        description: getApiErrorMessage(error, 'Could not initiate Gmail connect flow.'),
        tone: 'danger'
      });
    }
  });

  const disconnectMutation = useMutation({
    mutationFn: () => disconnectConnection(connection?.id, connection?.connectorType || 'gmail'),
    onSuccess: () => {
      pushToast({
        title: 'Disconnected',
        description: 'Connector was revoked successfully.',
        tone: 'success'
      });
      queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (error) => {
      pushToast({
        title: 'Disconnect failed',
        description: getApiErrorMessage(error, 'Could not disconnect Gmail.'),
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
      return syncInbox(connection.id);
    },
    onSuccess: () => {
      pushToast({
        title: 'Sync queued',
        description: 'Manual sync request submitted.',
        tone: 'success'
      });
      queryClient.invalidateQueries({ queryKey: ['connections'] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
    },
    onError: (error) => {
      pushToast({
        title: 'Sync failed',
        description: getApiErrorMessage(error, 'Could not queue sync.'),
        tone: 'danger'
      });
    }
  });

  const autoSyncSaveMutation = useMutation({
    mutationFn: () => updateAutoSyncPreference({ enabled: autoSyncEnabled, intervalHours: autoSyncInterval }),
    onSuccess: () => {
      pushToast({
        title: autoSyncEnabled ? 'Auto-sync enabled. Syncing now.' : 'Auto-sync disabled.',
        description: '',
        tone: 'success'
      });
      queryClient.invalidateQueries({ queryKey: ['auto-sync-preference'] });
    },
    onError: (error) => {
      pushToast({
        title: 'Failed to save auto-sync settings',
        description: getApiErrorMessage(error, 'Could not update auto-sync preference.'),
        tone: 'danger'
      });
    }
  });

  const canSync = isConnectionActive(connection);
  const mustReconnect = needsReconnect(connection);
  const mustConnect = needsInitialConnection(connection);
  const redirectUri = `${window.location.origin}${location.pathname}${location.search}`;
  const gmailDisabled = !connection || mustConnect || !canSync;
  const lastSyncAt = autoSyncQuery.data?.lastSyncAt || connection?.lastSyncedAt || null;

  return (
    <div className="settings-grid">
      <section className="panel">
        <div className="panel-header">
          <h2>Connection</h2>
        </div>

        {connectionsQuery.isLoading ? (
          <LoadingCard lines={4} />
        ) : !connection || mustConnect ? (
          <EmptyState
            title="Gmail not connected yet"
            description="Connect Gmail to activate sync, triage, drafts, and send."
            action={
              <Button onClick={() => connectMutation.mutate(redirectUri)} loading={connectMutation.isPending}>
                Connect Gmail
              </Button>
            }
          />
        ) : (
          <div className="connection-settings">
            <div>
              <p className="muted">Connector</p>
              <h3>{connection.displayName}</h3>
            </div>
            <Badge
              label={connection.status}
              tone={connection.status === 'active' ? 'success' : connection.status === 'expired' ? 'danger' : 'warning'}
            />
            <div className="inline-actions">
              <Button
                variant="secondary"
                onClick={() => syncMutation.mutate()}
                loading={syncMutation.isPending}
                disabled={!canSync}
              >
                Sync now
              </Button>
              {mustReconnect ? (
                <Button onClick={() => connectMutation.mutate(redirectUri)} loading={connectMutation.isPending}>
                  Reconnect Gmail
                </Button>
              ) : null}
              <Button
                variant="danger"
                onClick={() => disconnectMutation.mutate()}
                loading={disconnectMutation.isPending}
                disabled={!connection?.id}
              >
                Disconnect
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Writing Profile</h2>
        </div>
        <form
          className="profile-form"
          onSubmit={(event) => {
            profileMutation.mutate(event);
          }}
        >
          <label>
            Preferred tone
            <select value={preferredTone} onChange={(event) => setPreferredTone(event.target.value)}>
              <option value="professional">Professional</option>
              <option value="friendly">Friendly</option>
              <option value="concise">Concise</option>
              <option value="formal">Formal</option>
            </select>
          </label>

          <label>
            Personalized profile
            <textarea
              value={personalizedProfile}
              onChange={(event) => setPersonalizedProfile(event.target.value)}
              placeholder="How should Draftly write for you? e.g., direct, strategic, and concise with clear asks."
            />
          </label>

          <label>
            Signature template
            <textarea
              value={signatureTemplate}
              onChange={(event) => setSignatureTemplate(event.target.value)}
              placeholder="--&#10;Your Name&#10;Your Role"
            />
          </label>

          <Button type="submit" loading={profileMutation.isPending}>
            Save profile
          </Button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Email Sync</h2>
        </div>

        {autoSyncQuery.isLoading ? (
          <LoadingCard lines={3} />
        ) : (
          <div
            className="preferences-list"
            title={gmailDisabled ? 'Connect and activate Gmail before enabling auto-sync' : undefined}
          >
            <div className="preference-item">
              <div>
                <h4>Auto Sync</h4>
                <p>
                  Automatically pull new emails on a schedule.
                  {lastSyncAt ? ` Last synced: ${formatRelativeTime(lastSyncAt)}.` : ' Never synced.'}
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={() => setAutoSyncEnabled(!autoSyncEnabled)}
                disabled={gmailDisabled}
              >
                {autoSyncEnabled ? 'Enabled' : 'Disabled'}
              </Button>
            </div>

            {autoSyncEnabled && (
              <div className="preference-item">
                <div>
                  <h4>Sync Interval</h4>
                  <p>How often Draftly checks for new emails.</p>
                </div>
                <select
                  value={autoSyncInterval}
                  disabled={gmailDisabled}
                  onChange={(e) => setAutoSyncInterval(Number(e.target.value))}
                >
                  <option value={1}>Every 1 hour</option>
                  <option value={2}>Every 2 hours</option>
                  <option value={4}>Every 4 hours</option>
                  <option value={6}>Every 6 hours</option>
                  <option value={12}>Every 12 hours</option>
                  <option value={24}>Every 24 hours</option>
                  <option value={48}>Every 2 days</option>
                  <option value={72}>Every 3 days</option>
                  <option value={168}>Every week</option>
                </select>
              </div>
            )}

            <Button
              onClick={() => autoSyncSaveMutation.mutate()}
              loading={autoSyncSaveMutation.isPending}
              disabled={gmailDisabled}
            >
              Save sync settings
            </Button>
          </div>
        )}
      </section>

    </div>
  );
}
