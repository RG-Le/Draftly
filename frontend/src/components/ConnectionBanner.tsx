import type { ConnectionSummary } from '../types';
import { formatRelativeTime } from '../lib/format';
import { Button } from './Button';
import { Badge } from './Badge';
import { isConnectionActive, needsInitialConnection, needsReconnect } from '../api/connections';

interface ConnectionBannerProps {
  connection: ConnectionSummary | null;
  onConnect: () => void;
  onSync: () => void;
  syncInProgress?: boolean;
  syncStatusHint?: string;
}

export function ConnectionBanner({ connection, onConnect, onSync, syncInProgress = false, syncStatusHint }: ConnectionBannerProps) {
  if (!connection || needsInitialConnection(connection)) {
    return (
      <div className="connection-banner warning">
        <div>
          <h3>Gmail connection needed</h3>
          <p>
            Enable AI replies to start syncing threads, generating drafts, and sending approved responses.
          </p>
        </div>
        <Button onClick={onConnect}>Connect Gmail</Button>
      </div>
    );
  }

  if (needsReconnect(connection)) {
    return (
      <div className="connection-banner warning">
        <div>
          <h3>Gmail access revoked or expired</h3>
          <p>
            Reconnect Gmail to continue syncing threads, generating drafts, and sending approved replies.
          </p>
        </div>
        <div className="connection-actions">
          <Badge label={connection.status} tone="danger" />
          <Button onClick={onConnect}>Reconnect Gmail</Button>
        </div>
      </div>
    );
  }

  const tone: 'success' | 'danger' | 'warning' =
    connection.status === 'active' ? 'success' : connection.status === 'expired' ? 'danger' : 'warning';

  return (
    <div className="connection-banner">
      <div>
        <h3>Gmail connected</h3>
        <p>
          Last synced {formatRelativeTime(connection.lastSyncedAt)}.
          {connection.lastSyncStatus ? ` Last result: ${connection.lastSyncStatus}.` : ''}
        </p>
        {syncStatusHint ? <p>{syncStatusHint}</p> : null}
      </div>
      <div className="connection-actions">
        <Badge label={connection.status} tone={tone} />
        <Button variant="secondary" onClick={onSync} loading={syncInProgress} disabled={!isConnectionActive(connection)}>
          Sync now
        </Button>
      </div>
    </div>
  );
}
