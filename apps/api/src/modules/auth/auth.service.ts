import { authenticator } from 'otplib';
import { AUDIT_ACTIONS, type LoginResponse } from '@mv/shared';
import { env } from '../../config/env';
import type { AuthContext, RequestContext } from '../../common/context';
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  randomToken,
  sha256,
  verifyPassword,
} from '../../common/crypto';
import { AppError, badRequest, conflict, notFound, unauthorized, validationFailed } from '../../common/errors';
import { audit } from '../../core/audit/audit.service';
import { renderEmail, sendMail } from '../../core/mail/mail.service';
import { notify } from '../../core/notifications/notification.service';
import { getSettingsGroup } from '../../core/settings/settings.service';
import { withTransaction } from '../../db/transaction';
import { User } from '../users/user.model';
import { isPrivileged, loadPrincipal, toAuthUser, type Principal } from './principal.service';
import { Session } from './session.model';
import { OneTimeToken } from './token.model';
import { signAccessToken, signMfaChallenge, verifyMfaChallenge } from './token.service';

authenticator.options = { window: 1 };

/** Window in which a just-rotated refresh token is treated as a benign race (multi-tab), not theft. */
const REFRESH_GRACE_MS = 20_000;
const INVALID_CREDENTIALS = 'The email/username or password is incorrect.';

export interface IssuedSession {
  response: LoginResponse;
  refreshToken: string;
  sessionExpiresAt: Date;
}

async function mfaRequiredFor(p: Principal) {
  const security = await getSettingsGroup('security');
  return security.mfaRequiredForPrivileged && isPrivileged(p);
}

async function restrictionFor(p: Principal) {
  if (p.user.mustChangePassword) return 'PASSWORD_CHANGE_REQUIRED' as const;
  if ((await mfaRequiredFor(p)) && !p.user.mfa?.enabled) return 'MFA_SETUP_REQUIRED' as const;
  return null;
}

async function issueSession(p: Principal, ctx: RequestContext): Promise<IssuedSession> {
  const security = await getSettingsGroup('security');
  const refreshToken = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + security.sessionAbsoluteTimeoutHours * 3600_000);
  const restriction = await restrictionFor(p);
  const session = await Session.create({
    userId: p.user._id,
    tokenHash: sha256(refreshToken),
    userAgent: ctx.userAgent,
    ip: ctx.ip,
    lastSeenAt: now,
    lastRotatedAt: now,
    expiresAt,
    restriction,
  });
  const access = signAccessToken(String(p.user._id), String(session._id));
  return {
    refreshToken,
    sessionExpiresAt: expiresAt,
    response: { accessToken: access.token, expiresIn: access.expiresIn, user: toAuthUser(p, await mfaRequiredFor(p)) },
  };
}

// ---- Login ---------------------------------------------------------------------------------------

export async function login(identifier: string, password: string, ctx: RequestContext): Promise<IssuedSession | { mfa: LoginResponse }> {
  const id = identifier.trim().toLowerCase();
  const user = await User.findOne({ $or: [{ email: id }, { username: id }] }).select('+passwordHash').lean();
  const security = await getSettingsGroup('security');

  if (!user) {
    await verifyPassword(null, password); // equalise timing
    await audit(ctx, {
      action: AUDIT_ACTIONS.LOGIN_FAILURE,
      entityType: 'user',
      entityRef: id.slice(0, 254),
      outcome: 'FAILURE',
      meta: { reason: 'UNKNOWN_USER' },
    });
    throw unauthorized(INVALID_CREDENTIALS, 'INVALID_CREDENTIALS');
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
    await audit(ctx, {
      action: AUDIT_ACTIONS.LOGIN_FAILURE,
      entityType: 'user',
      entityId: user._id,
      entityRef: user.email,
      actorId: user._id,
      actorName: user.name,
      outcome: 'FAILURE',
      meta: { reason: 'LOCKED' },
    });
    throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'} or reset your password.`);
  }

  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    const failed = (user.failedLoginCount ?? 0) + 1;
    const lock = failed >= security.maxFailedLogins;
    await User.updateOne(
      { _id: user._id },
      lock
        ? { $set: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + security.lockoutMinutes * 60000) } }
        : { $set: { failedLoginCount: failed } },
    );
    await audit(ctx, {
      action: lock ? AUDIT_ACTIONS.LOGIN_LOCKED : AUDIT_ACTIONS.LOGIN_FAILURE,
      entityType: 'user',
      entityId: user._id,
      entityRef: user.email,
      actorId: user._id,
      actorName: user.name,
      outcome: 'FAILURE',
      meta: { reason: 'BAD_PASSWORD', failedCount: failed },
    });
    if (lock) {
      throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Your account is locked for ${security.lockoutMinutes} minutes.`);
    }
    throw unauthorized(INVALID_CREDENTIALS, 'INVALID_CREDENTIALS');
  }

  if (user.status !== 'ACTIVE') {
    await audit(ctx, {
      action: AUDIT_ACTIONS.LOGIN_FAILURE,
      entityType: 'user',
      entityId: user._id,
      entityRef: user.email,
      actorId: user._id,
      actorName: user.name,
      outcome: 'FAILURE',
      meta: { reason: `STATUS_${user.status}` },
    });
    throw new AppError(403, 'ACCOUNT_INACTIVE', 'Your account is not active. Please contact your administrator.');
  }

  if (user.mfa?.enabled) {
    return { mfa: { mfaRequired: true, challengeToken: signMfaChallenge(String(user._id)) } };
  }
  return completeLogin(String(user._id), ctx, 'PASSWORD');
}

async function completeLogin(userId: string, ctx: RequestContext, method: 'PASSWORD' | 'MFA' | 'RECOVERY_CODE') {
  const principal = await loadPrincipal(userId);
  if (!principal || principal.user.status !== 'ACTIVE') throw unauthorized(INVALID_CREDENTIALS, 'INVALID_CREDENTIALS');
  await User.updateOne(
    { _id: principal.user._id },
    { $set: { failedLoginCount: 0, lastLoginAt: new Date(), lastLoginIp: ctx.ip }, $unset: { lockedUntil: 1 } },
  );
  const issued = await issueSession(principal, ctx);
  await audit(ctx, {
    action: AUDIT_ACTIONS.LOGIN_SUCCESS,
    entityType: 'user',
    entityId: principal.user._id,
    entityRef: principal.user.email,
    actorId: principal.user._id,
    actorName: principal.user.name,
    meta: { method },
  });
  return issued;
}

export async function loginWithMfa(challengeToken: string, code: string, ctx: RequestContext) {
  const claims = verifyMfaChallenge(challengeToken);
  if (!claims) throw unauthorized('Your sign-in attempt expired. Please start again.', 'MFA_CHALLENGE_EXPIRED');
  const user = await User.findById(claims.sub).select('+mfa.secretEnc +mfa.recoveryCodeHashes').lean();
  if (!user || !user.mfa?.enabled || !user.mfa.secretEnc) throw unauthorized('Invalid sign-in attempt', 'MFA_INVALID');

  const clean = code.replace(/\s/g, '');
  if (/^\d{6}$/.test(clean) && authenticator.check(clean, decryptSecret(user.mfa.secretEnc))) {
    return completeLogin(String(user._id), ctx, 'MFA');
  }
  // Recovery code (single use)
  const h = sha256(clean.toUpperCase());
  if (user.mfa.recoveryCodeHashes?.includes(h)) {
    await User.updateOne({ _id: user._id }, { $pull: { 'mfa.recoveryCodeHashes': h } });
    return completeLogin(String(user._id), ctx, 'RECOVERY_CODE');
  }
  await audit(ctx, {
    action: AUDIT_ACTIONS.LOGIN_FAILURE,
    entityType: 'user',
    entityId: user._id,
    entityRef: user.email,
    actorId: user._id,
    actorName: user.name,
    outcome: 'FAILURE',
    meta: { reason: 'BAD_MFA_CODE' },
  });
  throw unauthorized('The verification code is incorrect.', 'MFA_INVALID');
}

// ---- Refresh / logout ----------------------------------------------------------------------------

export async function refreshSession(refreshToken: string, ctx: RequestContext): Promise<IssuedSession> {
  const hash = sha256(refreshToken);
  const now = new Date();
  const session = await Session.findOne({ tokenHash: hash });

  if (!session) {
    const reused = await Session.findOne({ 'rotatedHashes.hash': hash });
    if (reused) {
      const entry = reused.rotatedHashes.find((r) => r.hash === hash);
      if (entry?.at && now.getTime() - entry.at.getTime() < REFRESH_GRACE_MS && !reused.revokedAt) {
        // Another tab rotated a moment ago; the browser already holds the new cookie. Client retries.
        throw conflict('Session refresh in progress, please retry', 'REFRESH_RACE');
      }
      if (!reused.revokedAt) {
        reused.revokedAt = now;
        reused.revokedReason = 'REFRESH_TOKEN_REUSE';
        await reused.save();
        await audit(ctx, {
          action: AUDIT_ACTIONS.TOKEN_REUSE,
          entityType: 'session',
          entityId: reused._id,
          actorId: reused.userId,
          outcome: 'FAILURE',
        });
      }
    }
    throw unauthorized('Your session has ended. Please sign in again.', 'SESSION_INVALID');
  }
  if (session.revokedAt || session.expiresAt <= now) {
    throw unauthorized('Your session has ended. Please sign in again.', 'SESSION_INVALID');
  }
  const security = await getSettingsGroup('security');
  if (now.getTime() - session.lastSeenAt.getTime() > security.sessionIdleTimeoutMinutes * 60_000) {
    session.revokedAt = now;
    session.revokedReason = 'IDLE_TIMEOUT';
    await session.save();
    throw unauthorized('Your session timed out due to inactivity.', 'SESSION_IDLE_TIMEOUT');
  }

  const principal = await loadPrincipal(String(session.userId));
  if (!principal || principal.user.status !== 'ACTIVE') {
    session.revokedAt = now;
    session.revokedReason = 'ACCOUNT_INACTIVE';
    await session.save();
    throw unauthorized('Your account is not active.', 'ACCOUNT_INACTIVE');
  }

  const next = randomToken(32);
  session.rotatedHashes = [...session.rotatedHashes.slice(-19), { hash, at: now }] as never;
  session.tokenHash = sha256(next);
  session.lastRotatedAt = now;
  session.lastSeenAt = now;
  session.restriction = (await restrictionFor(principal)) as never;
  await session.save();

  const access = signAccessToken(String(principal.user._id), String(session._id));
  return {
    refreshToken: next,
    sessionExpiresAt: session.expiresAt,
    response: { accessToken: access.token, expiresIn: access.expiresIn, user: toAuthUser(principal, await mfaRequiredFor(principal)) },
  };
}

export async function revokeByRefreshToken(refreshToken: string | undefined, ctx: RequestContext) {
  if (!refreshToken) return;
  const s = await Session.findOneAndUpdate(
    { tokenHash: sha256(refreshToken), revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'LOGOUT' } },
  );
  if (s) await audit(ctx, { action: AUDIT_ACTIONS.LOGOUT, entityType: 'session', entityId: s._id, actorId: s.userId });
}

export async function revokeAllSessions(userId: string, reason: string, exceptSessionId?: string) {
  await Session.updateMany(
    { userId, revokedAt: null, ...(exceptSessionId ? { _id: { $ne: exceptSessionId } } : {}) },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
}

export async function listSessions(auth: AuthContext) {
  const rows = await Session.find({ userId: auth.userId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ lastSeenAt: -1 })
    .lean();
  return rows.map((s) => ({
    id: String(s._id),
    userAgent: s.userAgent,
    ip: s.ip,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    expiresAt: s.expiresAt,
    current: String(s._id) === auth.sessionId,
  }));
}

export async function revokeSession(auth: AuthContext, sessionId: string, ctx: RequestContext) {
  const s = await Session.findOneAndUpdate(
    { _id: sessionId, userId: auth.userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'USER_REVOKED' } },
  );
  if (!s) throw notFound('Session');
  await audit(ctx, { action: AUDIT_ACTIONS.SESSION_REVOKED, entityType: 'session', entityId: s._id });
}

// ---- Password reset / activation ----------------------------------------------------------------

export async function createOneTimeToken(userId: string, purpose: 'PASSWORD_RESET' | 'ACTIVATION', ctx: RequestContext) {
  const security = await getSettingsGroup('security');
  const token = randomToken(32);
  const minutes = purpose === 'ACTIVATION' ? 72 * 60 : security.passwordResetValidityMinutes;
  // Invalidate earlier unused tokens of the same purpose.
  await OneTimeToken.updateMany({ userId, purpose, usedAt: null }, { $set: { usedAt: new Date() } });
  await OneTimeToken.create({
    userId,
    purpose,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + minutes * 60_000),
    createdIp: ctx.ip,
  });
  return { token, minutes };
}

export async function sendPasswordEmail(
  user: { _id: unknown; email: string; name: string },
  purpose: 'PASSWORD_RESET' | 'ACTIVATION',
  ctx: RequestContext,
) {
  const { token, minutes } = await createOneTimeToken(String(user._id), purpose, ctx);
  const base = env().PUBLIC_APP_URL.replace(/\/$/, '');
  const isReset = purpose === 'PASSWORD_RESET';
  const url = `${base}/${isReset ? 'reset-password' : 'activate'}?token=${encodeURIComponent(token)}`;
  const validity = minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`;
  const mail = renderEmail({
    title: isReset ? 'Reset your password' : 'Activate your account',
    paragraphs: isReset
      ? [
          `Hello ${user.name},`,
          'We received a request to reset the password for your Digital MV Customer Service account.',
          `This link is valid for ${validity} and can be used once. If you did not request this, you can ignore this email.`,
        ]
      : [
          `Hello ${user.name},`,
          'An account has been created for you on the Digital MV Customer Service Management System.',
          `Use the link below to set your password. The link is valid for ${validity}.`,
        ],
    action: { label: isReset ? 'Reset password' : 'Set password', url },
  });
  await sendMail({ to: user.email, subject: isReset ? 'Reset your password' : 'Activate your account', ...mail });
}

/** Always succeeds from the caller's perspective — never reveals whether the email exists (AUTH-02). */
export async function forgotPassword(email: string, ctx: RequestContext) {
  const user = await User.findOne({ email: email.toLowerCase() }).lean();
  if (!user || user.status === 'INACTIVE') {
    await audit(ctx, { action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED, entityType: 'user', entityRef: email, outcome: 'FAILURE' });
    return;
  }
  await sendPasswordEmail(user, user.status === 'PENDING_ACTIVATION' ? 'ACTIVATION' : 'PASSWORD_RESET', ctx);
  await audit(ctx, {
    action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
    entityType: 'user',
    entityId: user._id,
    entityRef: user.email,
    actorId: user._id,
    actorName: user.name,
  });
}

export async function resetPassword(token: string, password: string, ctx: RequestContext) {
  const rec = await OneTimeToken.findOne({ tokenHash: sha256(token) });
  if (!rec || rec.usedAt || rec.expiresAt <= new Date()) {
    throw badRequest('This link is invalid or has expired. Please request a new one.');
  }
  const user = await User.findById(rec.userId).lean();
  if (!user || user.status === 'INACTIVE') throw badRequest('This link is invalid or has expired. Please request a new one.');

  const passwordHash = await hashPassword(password);
  await withTransaction(async (session) => {
    rec.usedAt = new Date();
    await rec.save({ session });
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          passwordHash,
          passwordChangedAt: new Date(),
          mustChangePassword: false,
          failedLoginCount: 0,
          ...(rec.purpose === 'ACTIVATION' || user.status === 'PENDING_ACTIVATION' ? { status: 'ACTIVE' } : {}),
        },
        $unset: { lockedUntil: 1 },
      },
      { session },
    );
    await Session.updateMany(
      { userId: user._id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'PASSWORD_RESET' } },
      { session },
    );
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.PASSWORD_RESET,
        entityType: 'user',
        entityId: user._id,
        entityRef: user.email,
        actorId: user._id,
        actorName: user.name,
        meta: { purpose: rec.purpose },
      },
      session,
    );
  });
}

export async function changePassword(auth: AuthContext, current: string, next: string, ctx: RequestContext) {
  const user = await User.findById(auth.userId).select('+passwordHash').lean();
  if (!user) throw unauthorized();
  if (!(await verifyPassword(user.passwordHash, current))) {
    throw validationFailed({ currentPassword: 'Current password is incorrect' });
  }
  const passwordHash = await hashPassword(next);
  await withTransaction(async (session) => {
    await User.updateOne(
      { _id: user._id },
      { $set: { passwordHash, passwordChangedAt: new Date(), mustChangePassword: false } },
      { session },
    );
    // Sign out every other device; keep the current session but lift the restriction.
    await Session.updateMany(
      { userId: user._id, revokedAt: null, _id: { $ne: auth.sessionId } },
      { $set: { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' } },
      { session },
    );
    await audit(ctx, { action: AUDIT_ACTIONS.PASSWORD_CHANGED, entityType: 'user', entityId: user._id, entityRef: user.email }, session);
    await notify(
      {
        recipientIds: [user._id],
        type: 'security.passwordChanged',
        title: 'Your password was changed',
        body: 'If you did not make this change, contact your administrator immediately.',
        severity: 'warning',
      },
      session,
    );
  });
  const principal = await loadPrincipal(auth.userId);
  await Session.updateOne({ _id: auth.sessionId }, { $set: { restriction: principal ? await restrictionFor(principal) : null } });
}

// ---- MFA -----------------------------------------------------------------------------------------

export async function beginMfaSetup(auth: AuthContext) {
  const user = await User.findById(auth.userId).lean();
  if (!user) throw unauthorized();
  if (user.mfa?.enabled) throw conflict('Multi-factor authentication is already enabled', 'MFA_ALREADY_ENABLED');
  const secret = authenticator.generateSecret(20);
  await User.updateOne({ _id: user._id }, { $set: { 'mfa.pendingSecretEnc': encryptSecret(secret) } });
  return {
    secret,
    otpauthUrl: authenticator.keyuri(user.email, env().MFA_ISSUER, secret),
  };
}

export async function enableMfa(auth: AuthContext, code: string, ctx: RequestContext) {
  const user = await User.findById(auth.userId).select('+mfa.pendingSecretEnc').lean();
  if (!user?.mfa?.pendingSecretEnc) throw badRequest('Start MFA setup first');
  const secret = decryptSecret(user.mfa.pendingSecretEnc);
  if (!authenticator.check(code, secret)) throw validationFailed({ code: 'The code is incorrect. Check your device time and try again.' });

  const recoveryCodes = Array.from({ length: 10 }, () => {
    const raw = randomToken(6).replace(/[^A-Za-z0-9]/g, '').toUpperCase().padEnd(8, 'X').slice(0, 8);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        'mfa.enabled': true,
        'mfa.secretEnc': user.mfa.pendingSecretEnc,
        'mfa.enabledAt': new Date(),
        'mfa.recoveryCodeHashes': recoveryCodes.map((c) => sha256(c)),
      },
      $unset: { 'mfa.pendingSecretEnc': 1 },
    },
  );
  await audit(ctx, { action: AUDIT_ACTIONS.MFA_ENABLED, entityType: 'user', entityId: user._id, entityRef: user.email });
  // Lift MFA_SETUP_REQUIRED on the current session.
  const principal = await loadPrincipal(auth.userId);
  await Session.updateOne({ _id: auth.sessionId }, { $set: { restriction: principal ? await restrictionFor(principal) : null } });
  return { recoveryCodes };
}

export async function disableMfa(auth: AuthContext, password: string, code: string, ctx: RequestContext) {
  const user = await User.findById(auth.userId).select('+passwordHash +mfa.secretEnc').lean();
  if (!user?.mfa?.enabled || !user.mfa.secretEnc) throw badRequest('Multi-factor authentication is not enabled');
  if (!(await verifyPassword(user.passwordHash, password))) throw validationFailed({ password: 'Password is incorrect' });
  if (!authenticator.check(code.replace(/\s/g, ''), decryptSecret(user.mfa.secretEnc))) {
    throw validationFailed({ code: 'The code is incorrect' });
  }
  const principal = await loadPrincipal(auth.userId);
  if (principal && (await mfaRequiredFor(principal))) {
    throw conflict('Multi-factor authentication is mandatory for your role and cannot be disabled.', 'MFA_MANDATORY');
  }
  await User.updateOne(
    { _id: user._id },
    { $set: { 'mfa.enabled': false, 'mfa.recoveryCodeHashes': [] }, $unset: { 'mfa.secretEnc': 1, 'mfa.enabledAt': 1 } },
  );
  await audit(ctx, { action: AUDIT_ACTIONS.MFA_DISABLED, entityType: 'user', entityId: user._id, entityRef: user.email });
}
