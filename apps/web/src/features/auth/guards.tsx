import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { PermissionKey } from '@mv/shared';
import { ForbiddenState } from '@/components/states';
import { LoadingScreen } from '@/components/ui/spinner';
import { useAuth } from './auth-context';

/**
 * Route guards are a usability aid only — every API call is authorised server-side (RBAC-03).
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <LoadingScreen label="Restoring your session…" />;
  if (status === 'anonymous' || !user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  if (user.restriction === 'PASSWORD_CHANGE_REQUIRED' && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  if (user.restriction === 'MFA_SETUP_REQUIRED' && location.pathname !== '/mfa-setup') {
    return <Navigate to="/mfa-setup" replace />;
  }
  return <>{children}</>;
}

export function RequirePermission({ all, any, children }: { all?: PermissionKey[]; any?: PermissionKey[]; children: ReactNode }) {
  const { hasPermission, hasAny } = useAuth();
  const ok = (all ?? []).every(hasPermission) && (!any?.length || hasAny(any));
  return ok ? <>{children}</> : <ForbiddenState />;
}

/** Shows children only when permitted (for buttons / sections). */
export function Can({ all, any, children }: { all?: PermissionKey[]; any?: PermissionKey[]; children: ReactNode }) {
  const { hasPermission, hasAny } = useAuth();
  const ok = (all ?? []).every(hasPermission) && (!any?.length || hasAny(any));
  return ok ? <>{children}</> : null;
}
