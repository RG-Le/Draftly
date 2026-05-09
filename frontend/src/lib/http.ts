import { getAccessToken, getRefreshToken, clearStoredSession, patchStoredSession } from './storage';

type QueryValue = string | number | boolean | null | undefined;

interface ApiRequestOptions {
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue>;
  auth?: boolean;
  signal?: AbortSignal;
  retryOnAuthError?: boolean;
}

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  retryAfterSeconds?: number;

  constructor(
    status: number,
    message: string,
    code?: string,
    details?: unknown,
    retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
let refreshPromise: Promise<boolean> | null = null;

export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${API_BASE_URL}${normalizedPath}`);

  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });
  }

  return url.toString();
}

async function parseBody<T>(response: Response): Promise<T | null> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function unwrapPayload<T>(payload: unknown): T {
  if (payload && typeof payload === 'object') {
    const envelope = payload as ErrorEnvelope & { data?: unknown };
    if (envelope.error) {
      throw new ApiError(
        400,
        envelope.error.message || 'Request failed',
        envelope.error.code,
        envelope.error.details
      );
    }

    if ('data' in envelope) {
      return envelope.data as T;
    }
  }

  return payload as T;
}

async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const response = await fetch(buildUrl('/api/v1/auth/refresh'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken })
        });

        if (!response.ok) {
          clearStoredSession();
          return false;
        }

        const payload = await parseBody<any>(response);
        if (!payload) return false;

        const data = 'data' in payload ? payload.data : payload;
        const nextAccess = data.accessToken as string | undefined;
        const nextRefresh = (data.refreshToken as string | undefined) || refreshToken;

        if (!nextAccess) return false;

        patchStoredSession({
          accessToken: nextAccess,
          refreshToken: nextRefresh
        });

        return true;
      } catch {
        clearStoredSession();
        return false;
      } finally {
        refreshPromise = null;
      }
    })();
  }

  return refreshPromise;
}

export async function apiRequest<T>(options: ApiRequestOptions): Promise<T> {
  const {
    path,
    method = 'GET',
    body,
    query,
    signal,
    auth = true,
    retryOnAuthError = true
  } = options;

  const accessToken = auth ? getAccessToken() : null;
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (auth && accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const response = await fetch(buildUrl(path, query), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal
  });

  const payload = await parseBody<unknown>(response);

  if (!response.ok) {
    if (response.status === 401 && auth && retryOnAuthError) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        return apiRequest<T>({
          ...options,
          retryOnAuthError: false
        });
      }
    }

    const envelope = (payload || {}) as ErrorEnvelope;
    const retryAfterRaw = response.headers.get('Retry-After');
    const retryAfterSeconds = retryAfterRaw ? Number.parseInt(retryAfterRaw, 10) : undefined;
    throw new ApiError(
      response.status,
      envelope.error?.message || response.statusText || 'Request failed',
      envelope.error?.code,
      envelope.error?.details,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined
    );
  }

  return unwrapPayload<T>(payload);
}
