import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import type { PermissionKey } from '@mv/shared';
import { AuthTestProvider, type AuthContextValue } from '@/features/auth/auth-context';
import type { Me } from '@/lib/types';

export function makeUser(permissions: PermissionKey[], overrides: Partial<Me> = {}): Me {
  return {
    id: 'u1',
    name: 'Test User',
    email: 'test@example.com',
    roles: [{ id: 'r1', key: 'ADMIN', name: 'Administrator' }],
    permissions,
    scope: { global: true, organizationIds: [], regionIds: [], siteIds: [] },
    mfaEnabled: false,
    mfaRequired: false,
    mustChangePassword: false,
    restriction: null,
    ...overrides,
  };
}

export function makeAuth(user: Me | null, overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  const perms = new Set(user?.permissions ?? []);
  return {
    status: user ? 'authenticated' : 'anonymous',
    user,
    hasPermission: (p) => perms.has(p),
    hasAny: (ps) => ps.some((p) => perms.has(p)),
    login: vi.fn(async () => ({})),
    completeMfa: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    reloadMe: vi.fn(async () => undefined),
    ...overrides,
  };
}

export function Wrapper({ auth, children, route = '/' }: { auth: AuthContextValue; children: ReactNode; route?: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <AuthTestProvider value={auth}>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </AuthTestProvider>
    </QueryClientProvider>
  );
}
