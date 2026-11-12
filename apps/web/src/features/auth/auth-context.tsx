import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthUser, LoginResponse, PermissionKey } from '@mv/shared';
import { api, onSessionChange, refreshSession, setAccessToken } from '@/lib/api';
import type { Me } from '@/lib/types';
import { readCookie } from '@/lib/utils';

export type Restriction = Me['restriction'];

/** Mirrors the server's restriction logic so the UI can route without an extra request. */
export function restrictionOf(u: AuthUser): Restriction {
  if (u.mustChangePassword) return 'PASSWORD_CHANGE_REQUIRED';
  if (u.mfaRequired && !u.mfaEnabled) return 'MFA_SETUP_REQUIRED';
  return null;
}

type Status = 'loading' | 'authenticated' | 'anonymous';

export interface AuthContextValue {
  status: Status;
  user: Me | null;
  hasPermission: (p: PermissionKey) => boolean;
  hasAny: (ps: PermissionKey[]) => boolean;
  login: (identifier: string, password: string) => Promise<{ mfaChallenge?: string }>;
  completeMfa: (challengeToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  reloadMe: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<Me | null>(null);

  const applySession = useCallback((res: LoginResponse | null) => {
    if (res?.accessToken && res.user) {
      setAccessToken(res.accessToken);
      setUser({ ...res.user, restriction: restrictionOf(res.user) });
      setStatus('authenticated');
    } else {
      setAccessToken(null);
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  // Silent bootstrap from the refresh cookie.
  useEffect(() => {
    let cancelled = false;
    refreshSession()
      .then((res) => !cancelled && applySession(res))
      .catch(() => !cancelled && applySession(null));
    return () => {
      cancelled = true;
    };
  }, [applySession]);

  useEffect(() => {
    const off = onSessionChange((res) => applySession(res));
    return () => {
      off();
    };
  }, [applySession]);

  const login = useCallback(
    async (identifier: string, password: string) => {
      const { data } = await api.post<LoginResponse>('/auth/login', { identifier, password });
      if (data.mfaRequired && data.challengeToken) return { mfaChallenge: data.challengeToken };
      applySession(data);
      return {};
    },
    [applySession],
  );

  const completeMfa = useCallback(
    async (challengeToken: string, code: string) => {
      const { data } = await api.post<LoginResponse>('/auth/login/mfa', { challengeToken, code });
      applySession(data);
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', null, { headers: { 'X-CSRF-Token': readCookie('mv_csrf') ?? '' } });
    } finally {
      applySession(null);
      qc.clear();
    }
  }, [applySession, qc]);

  const reloadMe = useCallback(async () => {
    const { data } = await api.get<Me>('/auth/me');
    setUser({ ...data, restriction: data.restriction ?? restrictionOf(data) });
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const perms = new Set(user?.permissions ?? []);
    return {
      status,
      user,
      hasPermission: (p) => perms.has(p),
      hasAny: (ps) => ps.some((p) => perms.has(p)),
      login,
      completeMfa,
      logout,
      reloadMe,
    };
  }, [status, user, login, completeMfa, logout, reloadMe]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Test helper to render components with a fixed auth state. */
export function AuthTestProvider({ value, children }: { value: AuthContextValue; children: ReactNode }) {
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
