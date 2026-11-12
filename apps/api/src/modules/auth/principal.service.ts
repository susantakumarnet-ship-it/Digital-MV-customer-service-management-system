import { isPermissionKey, PRIVILEGED_ROLE_KEYS, type AuthUser, type PermissionKey } from '@mv/shared';
import type { AuthContext } from '../../common/context';
import { Role } from '../roles/role.model';
import { User } from '../users/user.model';

/** Loads the user + ACTIVE roles and computes the effective permission set (union of roles). */
export async function loadPrincipal(userId: string) {
  const user = await User.findById(userId).lean();
  if (!user) return null;
  const roles = await Role.find({ _id: { $in: user.roleIds ?? [] }, status: 'ACTIVE' })
    .select('key name permissions')
    .lean();
  const permissions = new Set<PermissionKey>();
  for (const r of roles) for (const p of r.permissions ?? []) if (isPermissionKey(p)) permissions.add(p);
  return { user, roles, permissions };
}

export type Principal = NonNullable<Awaited<ReturnType<typeof loadPrincipal>>>;

export function isPrivileged(p: Principal) {
  return p.roles.some((r) => r.key && PRIVILEGED_ROLE_KEYS.includes(r.key as never));
}

export function toAuthContext(p: Principal, sessionId: string, restriction?: AuthContext['restriction']): AuthContext {
  return {
    userId: String(p.user._id),
    sessionId,
    name: p.user.name,
    email: p.user.email,
    organizationId: p.user.organizationId ? String(p.user.organizationId) : undefined,
    roles: p.roles.map((r) => ({ id: String(r._id), key: r.key ?? undefined, name: r.name })),
    permissions: p.permissions,
    scope: {
      global: Boolean(p.user.scope?.global),
      organizationIds: (p.user.scope?.organizationIds ?? []).map(String),
      regionIds: (p.user.scope?.regionIds ?? []).map(String),
      siteIds: (p.user.scope?.siteIds ?? []).map(String),
    },
    restriction,
  };
}

export function toAuthUser(p: Principal, mfaRequired: boolean): AuthUser {
  return {
    id: String(p.user._id),
    name: p.user.name,
    email: p.user.email,
    username: p.user.username ?? undefined,
    phone: p.user.phone ?? undefined,
    roles: p.roles.map((r) => ({ id: String(r._id), key: r.key ?? undefined, name: r.name })),
    permissions: [...p.permissions].sort(),
    scope: {
      global: Boolean(p.user.scope?.global),
      organizationIds: (p.user.scope?.organizationIds ?? []).map(String),
      regionIds: (p.user.scope?.regionIds ?? []).map(String),
      siteIds: (p.user.scope?.siteIds ?? []).map(String),
    },
    mfaEnabled: Boolean(p.user.mfa?.enabled),
    mfaRequired,
    timezone: p.user.timezone ?? undefined,
    mustChangePassword: Boolean(p.user.mustChangePassword),
  };
}
