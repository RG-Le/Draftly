import { ApiError, apiRequest } from '../lib/http';
import type { ConnectionSummary } from '../types';

type ConnectionsApiMode = 'unknown' | 'modern' | 'legacy';
let connectionsApiMode: ConnectionsApiMode = 'unknown';

const unusableStatuses = new Set(['revoked', 'expired', 'error', 'inactive']);

function mapConnection(item: any): ConnectionSummary {
  const connectorType = item.connectorType || item.type || 'gmail';
  const displayName = item.displayName || connectorType.toUpperCase();
  const status = item.status || (item.connected ? 'active' : 'inactive');
  const normalizedStatus = String(status).toLowerCase();
  const isUsable =
    typeof item.isUsable === 'boolean'
      ? item.isUsable
      : !unusableStatuses.has(normalizedStatus) && normalizedStatus !== 'inactive';
  const connected =
    item.connected !== undefined
      ? Boolean(item.connected) && !unusableStatuses.has(normalizedStatus)
      : (normalizedStatus === 'active' || normalizedStatus === 'connected');

  return {
    id: item.id,
    connectorType,
    displayName,
    status,
    connected,
    isUsable,
    lastSyncedAt: item.lastSyncedAt ?? null,
    lastSyncStatus: item.lastSyncStatus ?? null
  };
}

export async function listConnections(): Promise<ConnectionSummary[]> {
  const payload = await apiRequest<any>({
    path: '/api/v1/connections',
    method: 'GET'
  });

  if (Array.isArray(payload?.connectors)) {
    connectionsApiMode = 'legacy';
  } else if (Array.isArray(payload?.data?.connections) || Array.isArray(payload?.connections)) {
    connectionsApiMode = 'modern';
  }

  const rawList = payload?.connections || payload?.data?.connections || payload?.connectors || [];
  return rawList.map(mapConnection);
}

export async function startGmailConnection(redirectUri?: string): Promise<{ authUrl: string }> {
  if (connectionsApiMode === 'legacy') {
    const query = redirectUri ? { redirect_uri: redirectUri } : undefined;
    const legacy = await apiRequest<any>({
      path: '/api/v1/connections/connect/gmail',
      method: 'GET',
      query
    });
    return { authUrl: legacy.authUrl };
  }

  try {
    const modern = await apiRequest<any>({
      path: '/api/v1/connections/initiate',
      method: 'POST',
      body: {
        connectorType: 'gmail',
        redirectUri
      }
    });
    if (modern?.authUrl) {
      connectionsApiMode = 'modern';
      return { authUrl: modern.authUrl };
    }
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 405)) {
      throw error;
    }
  }

  const query = redirectUri ? { redirect_uri: redirectUri } : undefined;
  const legacy = await apiRequest<any>({
    path: '/api/v1/connections/connect/gmail',
    method: 'GET',
    query
  });
  connectionsApiMode = 'legacy';
  return { authUrl: legacy.authUrl };
}

export async function reconnectGmailConnection(redirectUri?: string): Promise<{ authUrl: string }> {
  try {
    const query = redirectUri ? { redirect_uri: redirectUri } : undefined;
    const reconnect = await apiRequest<any>({
      path: '/api/v1/connections/reconnect/gmail',
      method: 'GET',
      query
    });
    if (reconnect?.authUrl) {
      return { authUrl: reconnect.authUrl };
    }
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 405)) {
      throw error;
    }
  }

  return startGmailConnection(redirectUri);
}

export async function completeConnectionCallback(
  code: string,
  state: string,
  connector?: string
): Promise<any> {
  return apiRequest({
    path: '/api/v1/connections/callback',
    method: 'GET',
    auth: false,
    query: { code, state, connector }
  });
}

/**
 * Triggers a Gmail inbox sync.
 *
 * @param connectionId - Optional specific connection ID to sync.
 * @param daysBack - Optional number of days of history to sync (must be a positive integer).
 *                   Defaults to the server's configured default when omitted.
 */
export async function syncInbox(connectionId?: string, daysBack?: number): Promise<any> {
  // Validate daysBack to prevent negative or non-integer values reaching the API.
  const validatedDaysBack =
    typeof daysBack === 'number' && Number.isInteger(daysBack) && daysBack > 0
      ? daysBack
      : undefined;

  const extra: Record<string, number> = validatedDaysBack
    ? { daysBack: validatedDaysBack, maxResults: 50 }
    : {};

  if (connectionsApiMode === 'legacy') {
    return apiRequest({
      path: '/api/v1/connections/gmail/sync',
      method: 'POST',
      body: { ...extra }
    });
  }

  try {
    const result = await apiRequest({
      path: '/api/v1/inbox/sync',
      method: 'POST',
      body: { ...(connectionId ? { connectionId } : {}), ...extra }
    });
    connectionsApiMode = 'modern';
    return result;
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 405)) {
      throw error;
    }
  }

  const legacyResult = await apiRequest({
    path: '/api/v1/connections/gmail/sync',
    method: 'POST',
    body: { ...extra }
  });
  connectionsApiMode = 'legacy';
  return legacyResult;
}

export async function disconnectConnection(connectionId?: string, connectorType = 'gmail'): Promise<void> {
  if (connectionId) {
    try {
      await apiRequest({
        path: `/api/v1/connections/${connectionId}`,
        method: 'DELETE'
      });
      return;
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 405)) {
        throw error;
      }
    }
  }

  await apiRequest({
    path: `/api/v1/connections/${connectorType}`,
    method: 'DELETE'
  });
}

export function getPrimaryGmailConnection(connections: ConnectionSummary[]): ConnectionSummary | null {
  return (
    connections.find((item) => item.connectorType === 'gmail' && item.status === 'active') ||
    connections.find((item) => item.connectorType === 'gmail' && item.connected) ||
    connections.find((item) => item.connectorType === 'gmail') ||
    null
  );
}

export function isConnectionActive(connection: ConnectionSummary | null): boolean {
  if (!connection) return false;
  if (typeof connection.isUsable === 'boolean') {
    return connection.isUsable && String(connection.status).toLowerCase() === 'active';
  }
  return String(connection.status).toLowerCase() === 'active';
}

export function needsReconnect(connection: ConnectionSummary | null): boolean {
  if (!connection) return false;
  const status = String(connection.status).toLowerCase();
  return status === 'revoked' || status === 'expired' || status === 'error';
}

export function needsInitialConnection(connection: ConnectionSummary | null): boolean {
  if (!connection) return true;
  if (needsReconnect(connection)) return false;

  const status = String(connection.status).toLowerCase();
  const connectedFlag = Boolean(connection.connected);
  const usableFlag = typeof connection.isUsable === 'boolean' ? connection.isUsable : connectedFlag;

  return !connectedFlag || !usableFlag || status === 'inactive';
}
