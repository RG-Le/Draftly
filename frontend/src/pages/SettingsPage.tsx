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
import { getPreferences, getProfile, updatePreference, updateProfile } from '../api/profile';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { LoadingCard } from '../components/LoadingCard';
import { useToast } from '../context/ToastContext';
import { getApiErrorMessage } from '../lib/api-error';

export function SettingsPage() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: getProfile
  });

  const preferencesQuery = useQuery({
    queryKey: ['preferences'],
    queryFn: getPreferences
  });

  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: listConnections
  });

  const [signatureTemplate, setSignatureTemplate] = useState('');
  const [preferredTone, setPreferredTone] = useState('professional');
  const [personalizedProfile, setPersonalizedProfile] = useState('');

  useEffect(() => {
    if (profileQuery.data) {
      setSignatureTemplate(profileQuery.data.signatureTemplate || '');
      setPreferredTone(profileQuery.data.preferredTone || 'professional');
      setPersonalizedProfile(profileQuery.data.personalizedProfile || '');
    }
  }, [profileQuery.data]);

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

  const toggleAutoSync = useMutation({
    mutationFn: async (current: boolean) => {
      await updatePreference('autoSync', !current);
      return !current;
    },
    onSuccess: (next) => {
      pushToast({
        title: 'Preference updated',
        description: `Auto sync is now ${next ? 'enabled' : 'disabled'}.`,
        tone: 'success'
      });
      queryClient.invalidateQueries({ queryKey: ['preferences'] });
    }
  });

  const autoSyncPref = preferencesQuery.data?.find((pref) => pref.key === 'autoSync');
  const autoSyncEnabled = Boolean(autoSyncPref?.value);
  const canSync = isConnectionActive(connection);
  const mustReconnect = needsReconnect(connection);
  const mustConnect = needsInitialConnection(connection);
  const redirectUri = `${window.location.origin}${location.pathname}${location.search}`;

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
          <h2>Preferences</h2>
        </div>

        {preferencesQuery.isLoading ? (
          <LoadingCard lines={3} />
        ) : (
          <div className="preferences-list">
            <div className="preference-item">
              <div>
                <h4>Auto Sync</h4>
                <p>Allow background inbox sync jobs to keep the review queue fresh.</p>
              </div>
              <Button
                variant="secondary"
                onClick={() => toggleAutoSync.mutate(autoSyncEnabled)}
                loading={toggleAutoSync.isPending}
              >
                {autoSyncEnabled ? 'Disable' : 'Enable'}
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
