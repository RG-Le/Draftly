import { apiRequest, getApiBaseUrl } from '../lib/http';
import type { AuthSession, User } from '../types';

interface AuthPayload {
  user?: User;
  accessToken?: string;
  refreshToken?: string;
  tokens?: {
    accessToken?: string;
    refreshToken?: string;
  };
}

function normalizeAuthPayload(payload: AuthPayload): AuthSession {
  const user = payload.user;
  const accessToken = payload.accessToken || payload.tokens?.accessToken;
  const refreshToken = payload.refreshToken || payload.tokens?.refreshToken;

  if (!user || !accessToken || !refreshToken) {
    throw new Error('Invalid authentication response');
  }

  return { user, accessToken, refreshToken };
}

export function getGoogleAuthUrl(): string {
  const base = getApiBaseUrl();
  const callback = encodeURIComponent(`${window.location.origin}/auth/callback`);
  return `${base}/api/v1/auth/google?redirect_uri=${callback}`;
}

export async function loginLocal(email: string, password: string): Promise<AuthSession> {
  const payload = await apiRequest<AuthPayload>({
    path: '/api/v1/auth/login',
    method: 'POST',
    auth: false,
    body: { email, password }
  });
  return normalizeAuthPayload(payload);
}

export async function registerLocal(email: string, name: string, password: string): Promise<AuthSession> {
  const payload = await apiRequest<AuthPayload>({
    path: '/api/v1/auth/register',
    method: 'POST',
    auth: false,
    body: { email, name, password }
  });
  return normalizeAuthPayload(payload);
}

export async function completeGoogleCallback(code: string, state: string): Promise<AuthSession> {
  const payload = await apiRequest<AuthPayload>({
    path: '/api/v1/auth/google/callback',
    method: 'GET',
    auth: false,
    query: { code, state }
  });
  return normalizeAuthPayload(payload);
}

export async function getMe(): Promise<User> {
  const payload = await apiRequest<User | { user: User }>({
    path: '/api/v1/auth/me',
    method: 'GET'
  });

  if ('user' in payload) {
    return payload.user;
  }
  return payload;
}

export async function getMeWithToken(accessToken: string): Promise<User> {
  const response = await fetch(`${getApiBaseUrl()}/api/v1/auth/me`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(payload.error?.message || 'Unable to fetch profile');
  }

  const payload = (await response.json()) as User | { user: User };
  if ('user' in payload) return payload.user;
  return payload;
}

export async function logout(refreshToken?: string): Promise<void> {
  await apiRequest({
    path: '/api/v1/auth/logout',
    method: 'POST',
    body: refreshToken ? { refreshToken } : {}
  });
}

export async function deleteAccount(): Promise<void> {
  await apiRequest({
    path: '/api/v1/auth/me',
    method: 'DELETE'
  });
}
