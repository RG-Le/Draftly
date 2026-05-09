import { createContext, useContext, useMemo, useState } from 'react';
import type { AuthSession, Nullable, User } from '../types';
import { clearStoredSession, getStoredSession, patchStoredSession, storeSession } from '../lib/storage';

interface AuthContextValue {
  user: Nullable<User>;
  accessToken: Nullable<string>;
  refreshToken: Nullable<string>;
  isAuthenticated: boolean;
  setSession: (session: AuthSession) => void;
  clearSession: () => void;
  patchUser: (next: Partial<User>) => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const initial = getStoredSession();
  const [user, setUser] = useState<Nullable<User>>(initial?.user ?? null);
  const [accessToken, setAccessToken] = useState<Nullable<string>>(initial?.accessToken ?? null);
  const [refreshToken, setRefreshToken] = useState<Nullable<string>>(initial?.refreshToken ?? null);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      accessToken,
      refreshToken,
      isAuthenticated: Boolean(accessToken),
      setSession: (session) => {
        storeSession(session);
        setUser(session.user);
        setAccessToken(session.accessToken);
        setRefreshToken(session.refreshToken);
      },
      clearSession: () => {
        clearStoredSession();
        setUser(null);
        setAccessToken(null);
        setRefreshToken(null);
      },
      patchUser: (next) => {
        setUser((prev) => {
          const merged = { ...(prev ?? {}), ...next } as User;
          patchStoredSession({ user: merged });
          return merged;
        });
      }
    }),
    [user, accessToken, refreshToken]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
