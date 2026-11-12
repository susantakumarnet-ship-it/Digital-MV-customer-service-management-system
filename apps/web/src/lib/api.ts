import axios, { AxiosError, type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios';
import type { ApiErrorBody, LoginResponse } from '@mv/shared';
import { readCookie } from './utils';

/**
 * Central API client. The access token lives in memory only (never localStorage). The refresh token
 * is an HttpOnly cookie scoped to /api/v1/auth; refresh calls echo the mv_csrf cookie as X-CSRF-Token.
 */
export const api = axios.create({ baseURL: '/api/v1', withCredentials: true, timeout: 30000 });

let accessToken: string | null = null;
export function setAccessToken(token: string | null) {
  accessToken = token;
}
export function getAccessToken() {
  return accessToken;
}

type SessionListener = (res: LoginResponse | null) => void;
const listeners = new Set<SessionListener>();
/** Notified when a refresh yields a new session (or null when the session is lost). */
export function onSessionChange(fn: SessionListener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function doRefresh(): Promise<LoginResponse> {
  const call = () =>
    axios.post<LoginResponse>('/api/v1/auth/refresh', null, {
      withCredentials: true,
      headers: { 'X-CSRF-Token': readCookie('mv_csrf') ?? '' },
    });
  try {
    return (await call()).data;
  } catch (err) {
    const e = err as AxiosError<ApiErrorBody>;
    if (e.response?.status === 409 && e.response.data?.error?.code === 'REFRESH_RACE') {
      // Another tab rotated the token a moment ago; the browser now holds the new cookie.
      await sleep(300);
      return (await call()).data;
    }
    throw err;
  }
}

let inflight: Promise<LoginResponse> | null = null;
/** Single-flight refresh shared by all concurrent 401s. */
export function refreshSession(): Promise<LoginResponse> {
  if (!inflight) {
    inflight = doRefresh()
      .then((res) => {
        setAccessToken(res.accessToken ?? null);
        listeners.forEach((l) => l(res));
        return res;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (accessToken) config.headers.set('Authorization', `Bearer ${accessToken}`);
  return config;
});

const REFRESHABLE = new Set(['TOKEN_INVALID', 'UNAUTHENTICATED']);

api.interceptors.response.use(
  (r) => r,
  async (error: AxiosError<ApiErrorBody>) => {
    const original = error.config as (AxiosRequestConfig & { _retried?: boolean }) | undefined;
    const status = error.response?.status;
    const code = error.response?.data?.error?.code;
    const url = original?.url ?? '';
    const isAuthEndpoint = /\/auth\/(login|refresh|logout|forgot-password|reset-password)/.test(url);

    if (status === 401 && original && !original._retried && !isAuthEndpoint && code && REFRESHABLE.has(code) && accessToken) {
      original._retried = true;
      try {
        await refreshSession();
        return api(original);
      } catch {
        handleSessionLost();
      }
    } else if (status === 401 && !isAuthEndpoint && accessToken) {
      // SESSION_INVALID, SESSION_IDLE_TIMEOUT, ACCOUNT_INACTIVE → the session is gone.
      handleSessionLost(error.response?.data?.error?.message);
    }
    return Promise.reject(error);
  },
);

let lostNotified = false;
function handleSessionLost(message?: string) {
  setAccessToken(null);
  listeners.forEach((l) => l(null));
  if (!lostNotified && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    lostNotified = true;
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    const msg = message ? `&reason=${encodeURIComponent(message)}` : '';
    window.location.assign(`/login?next=${next}${msg}`);
  }
}

// ---- Error helpers ---------------------------------------------------------------------------

export interface ParsedApiError {
  status?: number;
  code: string;
  message: string;
  fields?: Record<string, string>;
  requestId?: string;
}

export function parseApiError(err: unknown): ParsedApiError {
  if (axios.isAxiosError(err)) {
    const body = err.response?.data as ApiErrorBody | undefined;
    if (body?.error) {
      return {
        status: err.response?.status,
        code: body.error.code,
        message: body.error.message,
        fields: body.error.fields,
        requestId: body.error.requestId,
      };
    }
    if (!err.response) return { code: 'NETWORK', message: 'Cannot reach the server. Check your connection and try again.' };
    return { status: err.response.status, code: 'HTTP_' + err.response.status, message: `Request failed (${err.response.status})` };
  }
  return { code: 'UNKNOWN', message: err instanceof Error ? err.message : 'Something went wrong' };
}

export function errorMessage(err: unknown) {
  const e = parseApiError(err);
  return e.requestId && (e.status ?? 0) >= 500 ? `${e.message} (ref ${e.requestId.slice(0, 8)})` : e.message;
}

/**
 * Maps API field errors onto a react-hook-form instance. Nested API keys like "scope.siteIds" are
 * passed through. Returns true when at least one field error was applied.
 */
export function applyFieldErrors(
  err: unknown,
  setError: (name: never, error: { type: string; message: string }) => void,
  known?: string[],
): boolean {
  const e = parseApiError(err);
  if (!e.fields) return false;
  let applied = false;
  for (const [field, message] of Object.entries(e.fields)) {
    if (known && !known.includes(field) && !known.includes(field.split('.')[0]!)) continue;
    setError(field as never, { type: 'server', message });
    applied = true;
  }
  return applied;
}

/** Fetch a binary response and return blob + filename from Content-Disposition. */
export async function getBlob(url: string, params?: Record<string, unknown>) {
  const res = await api.get<Blob>(url, { params, responseType: 'blob' });
  const cd = String(res.headers['content-disposition'] ?? '');
  const filename = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? 'download';
  return { blob: res.data, filename };
}
