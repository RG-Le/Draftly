import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { deleteAccount } from '../api/auth';
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
  getTriagePreferences,
  regenerateProfile,
  updateAutoSyncPreference,
  updateProfile,
  updateTriagePreferences
} from '../api/profile';
import { getTriageCategories } from '../api/triage';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { EmptyState } from '../components/EmptyState';
import { LoadingCard } from '../components/LoadingCard';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { getApiErrorMessage } from '../lib/api-error';
import { formatRelativeTime } from '../lib/format';

export function SettingsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { clearSession } = useAuth();

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

  const triageQuery = useQuery({
    queryKey: ['triage-preferences'],
    queryFn: getTriagePreferences
  });

  const triageCategoriesQuery = useQuery({
    queryKey: ['triage-categories'],
    queryFn: getTriageCategories
  });

  const [signatureTemplate, setSignatureTemplate] = useState('');
  const [preferredTone, setPreferredTone] = useState('professional');
  const [personalizedProfile, setPersonalizedProfile] = useState('');
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(false);
  const [autoSyncInterval, setAutoSyncInterval] = useState(24);
  const [customTriageInstructions, setCustomTriageInstructions] = useState('');
  const [showSyncDialog, setShowSyncDialog] = useState(false);
  const [syncDaysBack, setSyncDaysBack] = useState(7);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

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

  useEffect(() => {
    if (triageQuery.data) {
      setCustomTriageInstructions(triageQuery.data.customInstructions || '');
    }
  }, [triageQuery.data]);

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
    mutationFn: (daysBack: number) => {
      if (!connection || needsInitialConnection(connection)) {
        throw new Error('Connect Gmail first.');
      }
      if (needsReconnect(connection) || !isConnectionActive(connection)) {
        throw new Error('Connection is revoked/expired. Reconnect Gmail first.');
      }
      return syncInbox(connection.id, daysBack);
    },
    onSuccess: () => {
      setShowSyncDialog(false);
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

  const regenerateMutation = useMutation({
    mutationFn: regenerateProfile,
    onSuccess: () => {
      pushToast({
        title: 'Profile regeneration started.',
        description: "You'll be notified when complete.",
        tone: 'success'
      });
    },
    onError: (error) => {
      pushToast({
        title: 'Regeneration failed',
        description: getApiErrorMessage(error, 'Could not start profile regeneration.'),
        tone: 'danger'
      });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: deleteAccount,
    onSuccess: () => {
      clearSession();
      navigate('/');
    },
    onError: (error) => {
      pushToast({
        title: 'Account deletion failed',
        description: getApiErrorMessage(error, 'Could not delete account.'),
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

  const triageMutation = useMutation({
    mutationFn: () => updateTriagePreferences({ customInstructions: customTriageInstructions }),
    onSuccess: () => {
      pushToast({
        title: 'Triage settings saved',
        description: 'Custom instructions updated.',
        tone: 'success'
      });
      queryClient.invalidateQueries({ queryKey: ['triage-preferences'] });
    },
    onError: (error) => {
      pushToast({
        title: 'Failed to save triage settings',
        description: getApiErrorMessage(error, 'Could not update triage preferences.'),
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
              <select
                value={syncDaysBack}
                onChange={(e) => setSyncDaysBack(Number(e.target.value))}
                style={{ padding: '0.4rem 0.6rem', borderRadius: '8px', border: '1px solid var(--border)' }}
              >
                <option value={1}>1 day</option>
                <option value={3}>3 days</option>
                <option value={7}>7 days</option>
                <option value={10}>10 days</option>
                <option value={15}>15 days</option>
              </select>
              <Button
                variant="secondary"
                onClick={() => syncMutation.mutate(syncDaysBack)}
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
          <div className="header-badges">
            {profileQuery.data?.profileSource && (
              <Badge
                label={
                  profileQuery.data.profileSource === 'ai_generated'
                    ? 'AI Generated'
                    : profileQuery.data.profileSource === 'manual'
                    ? 'Manually Set'
                    : 'Default Profile'
                }
                tone={
                  profileQuery.data.profileSource === 'ai_generated'
                    ? 'success'
                    : profileQuery.data.profileSource === 'manual'
                    ? 'info'
                    : 'neutral'
                }
              />
            )}
            <Button
              variant="ghost"
              onClick={() => regenerateMutation.mutate()}
              loading={regenerateMutation.isPending}
            >
              Regenerate Profile
            </Button>
          </div>
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

      <section className="panel">
        <div className="panel-header">
          <h2>Triage Settings</h2>
        </div>

        <div className="profile-form">
          <div>
            <h4>Custom Instructions</h4>
            <p className="muted">
              Provide custom rules for how your emails should be classified.
            </p>
            <textarea
              value={customTriageInstructions}
              onChange={(e) => {
                if (e.target.value.length <= 500) {
                  setCustomTriageInstructions(e.target.value);
                }
              }}
              placeholder="e.g., Emails from boss@company.com are always reply_needed. Newsletters from dev.to should be classified as info."
              rows={5}
              style={{ width: '100%', minHeight: '140px' }}
            />
            <p className="muted" style={{ textAlign: 'right', marginTop: '0.25rem' }}>
              {customTriageInstructions.length}/500
            </p>
            <Button
              onClick={() => triageMutation.mutate()}
              loading={triageMutation.isPending}
            >
              Save triage instructions
            </Button>
          </div>

          <div style={{ marginTop: '1.5rem' }}>
            <h4>Active Categories</h4>
            <p className="muted">Emails are classified into one of these categories during triage. System categories cannot be removed.</p>
            <div className="triage-categories-list" style={{ marginTop: '0.75rem' }}>
              {triageCategoriesQuery.data?.categories.map((cat) => (
                <div className="preference-item" key={cat.id}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Badge
                      label={cat.label}
                      tone={cat.id === 'reply_needed' ? 'warning' : cat.id === 'already_replied' ? 'success' : cat.id === 'info' ? 'info' : cat.id === 'junk' ? 'danger' : 'neutral'}
                    />
                    {cat.isSystem && <span className="muted" style={{ fontSize: '0.75rem' }}>System</span>}
                  </div>
                  <p>{cat.description}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="panel panel-danger">
        <div className="panel-header">
          <h2>Danger Zone</h2>
        </div>
        <div className="preference-item">
          <div>
            <h4>Delete Account</h4>
            <p>Permanently delete your account, all emails, drafts, and classifications. This cannot be undone.</p>
          </div>
          <Button variant="danger" onClick={() => setShowDeleteDialog(true)}>
            Delete Account
          </Button>
        </div>
      </section>

      <Dialog
        open={showSyncDialog}
        title="Sync Inbox"
        onClose={() => setShowSyncDialog(false)}
      >
        <div className="profile-form">
          <label>
            Classify emails from the last
            <select value={syncDaysBack} onChange={(e) => setSyncDaysBack(Number(e.target.value))}>
              <option value={1}>1 day</option>
              <option value={3}>3 days</option>
              <option value={7}>7 days</option>
              <option value={10}>10 days</option>
              <option value={15}>15 days</option>
            </select>
            <span className="muted" style={{ display: 'block', marginTop: '0.25rem', fontSize: '0.8rem' }}>
              Max 15 days. First time? Try 7–15 days to classify older emails.
            </span>
          </label>
          <div className="inline-actions" style={{ marginTop: '1rem' }}>
            <Button variant="secondary" onClick={() => setShowSyncDialog(false)}>Cancel</Button>
            <Button
              onClick={() => syncMutation.mutate(syncDaysBack)}
              loading={syncMutation.isPending}
            >
              Start Sync
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={showDeleteDialog}
        title="Delete Account"
        onClose={() => setShowDeleteDialog(false)}
      >
        <div className="profile-form">
          <p>This will permanently delete all your emails, drafts, and classifications. This action cannot be undone.</p>
          <div className="inline-actions" style={{ marginTop: '1rem' }}>
            <Button variant="secondary" onClick={() => setShowDeleteDialog(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => deleteMutation.mutate()}
              loading={deleteMutation.isPending}
            >
              Delete my account
            </Button>
          </div>
        </div>
      </Dialog>

    </div>
  );
}
