import type { AuthSession, User } from '../types';

const SESSION_KEY = 'draftly.session.v1';

interface StoredSession {
  accessToken: string;
  refreshToken: string;
  user: User;
}

export function getStoredSession(): StoredSession | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed.accessToken || !parsed.refreshToken || !parsed.user) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function storeSession(session: AuthSession): void {
  const payload: StoredSession = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    user: session.user
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
}

export function clearStoredSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

export function getAccessToken(): string | null {
  return getStoredSession()?.accessToken ?? null;
}

export function getRefreshToken(): string | null {
  return getStoredSession()?.refreshToken ?? null;
}

export function patchStoredSession(next: Partial<StoredSession>): void {
  const current = getStoredSession();
  if (!current) return;

  const merged: StoredSession = {
    ...current,
    ...next,
    user: {
      ...current.user,
      ...(next.user ?? {})
    }
  };

  localStorage.setItem(SESSION_KEY, JSON.stringify(merged));
}
