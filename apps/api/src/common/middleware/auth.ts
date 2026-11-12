import type { NextFunction, Request, Response } from 'express';
import type { PermissionKey } from '@mv/shared';
import { getSettingsGroup } from '../../core/settings/settings.service';
import { loadPrincipal, toAuthContext } from '../../modules/auth/principal.service';
import { Session } from '../../modules/auth/session.model';
import { verifyAccessToken } from '../../modules/auth/token.service';
import { AppError, forbidden, unauthorized } from '../errors';

const LAST_SEEN_THROTTLE_MS = 60_000;

/**
 * Verifies the bearer access token, then re-validates the session and user on every request so that
 * logout, deactivation, role changes and session revocation take effect immediately (AUTH-03/04).
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) return next(unauthorized());
  const claims = verifyAccessToken(token);
  if (!claims) return next(unauthorized('Your session has expired. Please sign in again.', 'TOKEN_INVALID'));

  const session = await Session.findById(claims.sid).lean();
  const now = new Date();
  if (!session || session.revokedAt || session.expiresAt <= now || String(session.userId) !== claims.sub) {
    return next(unauthorized('Your session has ended. Please sign in again.', 'SESSION_INVALID'));
  }
  const security = await getSettingsGroup('security');
  if (now.getTime() - new Date(session.lastSeenAt).getTime() > security.sessionIdleTimeoutMinutes * 60_000) {
    await Session.updateOne({ _id: session._id }, { $set: { revokedAt: now, revokedReason: 'IDLE_TIMEOUT' } });
    return next(unauthorized('Your session timed out due to inactivity.', 'SESSION_IDLE_TIMEOUT'));
  }

  const principal = await loadPrincipal(claims.sub);
  if (!principal || principal.user.status !== 'ACTIVE') {
    return next(unauthorized('Your account is not active.', 'ACCOUNT_INACTIVE'));
  }

  if (now.getTime() - new Date(session.lastSeenAt).getTime() > LAST_SEEN_THROTTLE_MS) {
    await Session.updateOne({ _id: session._id }, { $set: { lastSeenAt: now } });
  }

  req.auth = toAuthContext(principal, String(session._id), (session.restriction as never) ?? undefined);
  next();
}

/** Blocks restricted sessions (pending MFA setup / forced password change) from normal endpoints. */
export function enforceRestriction(allowRestricted: boolean) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const r = req.auth?.restriction;
    if (r && !allowRestricted) {
      const msg =
        r === 'MFA_SETUP_REQUIRED'
          ? 'Multi-factor authentication must be set up before continuing.'
          : 'You must change your password before continuing.';
      return next(new AppError(403, r, msg));
    }
    next();
  };
}

/** Default-deny permission check (RBAC-03). All listed permissions are required. */
export function requirePermissions(all: PermissionKey[] = [], anyOf: PermissionKey[] = []) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const perms = req.auth?.permissions;
    if (!perms) return next(unauthorized());
    if (all.some((p) => !perms.has(p))) return next(forbidden());
    if (anyOf.length && !anyOf.some((p) => perms.has(p))) return next(forbidden());
    next();
  };
}
