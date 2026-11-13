import type { CookieOptions, Request, Response } from 'express';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  mfaDisableSchema,
  mfaLoginSchema,
  mfaVerifySchema,
  paginationQuery,
  profileUpdateSchema,
  resetPasswordSchema,
} from '@mv/shared';
import { env } from '../../config/env';
import { randomToken, safeEqual } from '../../common/crypto';
import { forbidden, unauthorized } from '../../common/errors';
import { ApiRouter, idParams, paged } from '../../common/http/route';
import { limiter } from '../../common/middleware/security';
import { AuditLog } from '../../core/audit/audit.model';
import { audit } from '../../core/audit/audit.service';
import { User } from '../users/user.model';
import * as auth from './auth.service';
import { loadPrincipal, toAuthUser, isPrivileged } from './principal.service';
import { getSettingsGroup } from '../../core/settings/settings.service';

export const REFRESH_COOKIE = 'mv_rt';
export const CSRF_COOKIE = 'mv_csrf';
const REFRESH_PATH = '/api/v1/auth';

function cookieBase(): CookieOptions {
  return { secure: env().COOKIE_SECURE || env().NODE_ENV === 'production', sameSite: 'strict' };
}

function setSessionCookies(res: Response, refreshToken: string, expires: Date) {
  res.cookie(REFRESH_COOKIE, refreshToken, { ...cookieBase(), httpOnly: true, path: REFRESH_PATH, expires });
  // Double-submit CSRF token: readable by the SPA, echoed in X-CSRF-Token for cookie-authenticated calls.
  res.cookie(CSRF_COOKIE, randomToken(24), { ...cookieBase(), httpOnly: false, path: '/', expires });
}

function clearSessionCookies(res: Response) {
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase(), httpOnly: true, path: REFRESH_PATH });
  res.clearCookie(CSRF_COOKIE, { ...cookieBase(), path: '/' });
}

function assertCsrf(req: Request) {
  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get('x-csrf-token');
  if (!cookie || !header || !safeEqual(String(cookie), header)) throw forbidden('Security check failed. Please sign in again.', 'CSRF_FAILED');
}

// Per-IP sign-in limit per 15 minutes (SEC-03). Configurable so automated test suites can raise it.
const loginLimiter = limiter({ windowMs: 15 * 60_000, limit: () => env().LOGIN_RATE_LIMIT_PER_15_MIN });
const sensitiveLimiter = limiter({ windowMs: 60 * 60_000, limit: 10 });

export const authRouter = new ApiRouter('/auth', 'Authentication');

authRouter
  .route({
    method: 'post',
    path: '/login',
    summary: 'Sign in with email/username and password',
    description: 'Returns an access token and sets the refresh cookie, or `{ mfaRequired, challengeToken }` when MFA is enabled.',
    access: { public: true },
    body: loginSchema,
    middleware: [loginLimiter],
    handler: async ({ body, ctx, res }) => {
      const result = await auth.login(body.identifier, body.password, ctx);
      if ('mfa' in result) return result.mfa;
      setSessionCookies(res, result.refreshToken, result.sessionExpiresAt);
      return result.response;
    },
  })
  .route({
    method: 'post',
    path: '/login/mfa',
    summary: 'Complete sign-in with a TOTP or recovery code',
    access: { public: true },
    body: mfaLoginSchema,
    middleware: [loginLimiter],
    handler: async ({ body, ctx, res }) => {
      const result = await auth.loginWithMfa(body.challengeToken, body.code, ctx);
      setSessionCookies(res, result.refreshToken, result.sessionExpiresAt);
      return result.response;
    },
  })
  .route({
    method: 'post',
    path: '/refresh',
    summary: 'Rotate the refresh token and obtain a new access token',
    description: 'Cookie-authenticated. Requires `X-CSRF-Token` equal to the `mv_csrf` cookie.',
    access: { public: true },
    handler: async ({ req, res, ctx }) => {
      assertCsrf(req);
      const token = req.cookies?.[REFRESH_COOKIE];
      if (!token) throw unauthorized('Please sign in.', 'NO_SESSION');
      try {
        const result = await auth.refreshSession(token, ctx);
        setSessionCookies(res, result.refreshToken, result.sessionExpiresAt);
        return result.response;
      } catch (err) {
        if ((err as { status?: number }).status === 401) clearSessionCookies(res);
        throw err;
      }
    },
  })
  .route({
    method: 'post',
    path: '/logout',
    summary: 'Sign out of the current session',
    access: { public: true },
    handler: async ({ req, res, ctx }) => {
      assertCsrf(req);
      await auth.revokeByRefreshToken(req.cookies?.[REFRESH_COOKIE], ctx);
      clearSessionCookies(res);
      return null;
    },
  })
  .route({
    method: 'post',
    path: '/logout-all',
    summary: 'Sign out of all sessions including this one',
    access: { allowRestricted: true },
    handler: async ({ auth: a, res, ctx }) => {
      await auth.revokeAllSessions(a.userId, 'LOGOUT_ALL');
      await audit(ctx, { action: 'auth.logout.all', entityType: 'user', entityId: a.userId });
      clearSessionCookies(res);
      return null;
    },
  })
  .route({
    method: 'post',
    path: '/forgot-password',
    summary: 'Request a password reset email',
    description: 'Always returns 202 regardless of whether the account exists.',
    access: { public: true },
    body: forgotPasswordSchema,
    status: 202,
    middleware: [sensitiveLimiter],
    handler: async ({ body, ctx }) => {
      await auth.forgotPassword(body.email, ctx);
      return { message: 'If an account exists for this email, a reset link has been sent.' };
    },
  })
  .route({
    method: 'post',
    path: '/reset-password',
    summary: 'Set a new password using a reset or activation token',
    access: { public: true },
    body: resetPasswordSchema,
    middleware: [sensitiveLimiter],
    handler: async ({ body, ctx }) => {
      await auth.resetPassword(body.token, body.password, ctx);
      return { message: 'Your password has been set. You can now sign in.' };
    },
  })
  .route({
    method: 'get',
    path: '/me',
    summary: 'Current user, roles, effective permissions and scope',
    access: { allowRestricted: true },
    handler: async ({ auth: a }) => {
      const p = await loadPrincipal(a.userId);
      if (!p) throw unauthorized();
      const security = await getSettingsGroup('security');
      return { ...toAuthUser(p, security.mfaRequiredForPrivileged && isPrivileged(p)), restriction: a.restriction ?? null };
    },
  })
  .route({
    method: 'patch',
    path: '/me',
    summary: 'Update own profile (name, phone, timezone)',
    access: {},
    body: profileUpdateSchema,
    handler: async ({ auth: a, body, ctx }) => {
      const before = await User.findById(a.userId).select('name phone timezone').lean();
      const set: Record<string, unknown> = {};
      const unset: Record<string, 1> = {};
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        if (v === '') unset[k] = 1;
        else set[k] = v;
      }
      await User.updateOne({ _id: a.userId }, { $set: set, $unset: unset });
      await audit(ctx, { action: 'user.profile.updated', entityType: 'user', entityId: a.userId, before, after: body });
      return { ok: true };
    },
  })
  .route({
    method: 'post',
    path: '/change-password',
    summary: 'Change own password (signs out other devices)',
    access: { allowRestricted: true },
    body: changePasswordSchema,
    middleware: [sensitiveLimiter],
    handler: async ({ auth: a, body, ctx }) => {
      await auth.changePassword(a, body.currentPassword, body.newPassword, ctx);
      return { message: 'Password changed' };
    },
  })
  .route({
    method: 'get',
    path: '/sessions',
    summary: 'List my active sessions',
    access: {},
    handler: ({ auth: a }) => auth.listSessions(a),
  })
  .route({
    method: 'delete',
    path: '/sessions/:id',
    summary: 'Revoke one of my sessions',
    access: {},
    params: idParams,
    handler: async ({ auth: a, params, ctx }) => {
      await auth.revokeSession(a, params.id, ctx);
      return null;
    },
  })
  .route({
    method: 'get',
    path: '/activity',
    summary: 'My sign-in history',
    access: {},
    query: paginationQuery,
    handler: async ({ auth: a, query }) => {
      const filter = { actorId: a.userId, action: { $regex: '^auth\\.' } };
      const [rows, total] = await Promise.all([
        AuditLog.find(filter)
          .sort({ timestamp: -1 })
          .skip((query.page - 1) * query.limit)
          .limit(query.limit)
          .select('action outcome ip userAgent timestamp meta')
          .lean(),
        AuditLog.countDocuments(filter),
      ]);
      return paged(
        rows.map((r) => ({ id: String(r._id), action: r.action, outcome: r.outcome, ip: r.ip, userAgent: r.userAgent, timestamp: r.timestamp, meta: r.meta })),
        total,
        query.page,
        query.limit,
      );
    },
  })
  .route({
    method: 'post',
    path: '/mfa/setup',
    summary: 'Begin TOTP MFA enrolment (returns otpauth URL for QR code)',
    access: { allowRestricted: true },
    handler: ({ auth: a }) => auth.beginMfaSetup(a),
  })
  .route({
    method: 'post',
    path: '/mfa/enable',
    summary: 'Confirm MFA enrolment with a code; returns one-time recovery codes',
    access: { allowRestricted: true },
    body: mfaVerifySchema,
    handler: ({ auth: a, body, ctx }) => auth.enableMfa(a, body.code, ctx),
  })
  .route({
    method: 'post',
    path: '/mfa/disable',
    summary: 'Disable MFA (password + current code required)',
    access: {},
    body: mfaDisableSchema,
    middleware: [sensitiveLimiter],
    handler: async ({ auth: a, body, ctx }) => {
      await auth.disableMfa(a, body.password, body.code, ctx);
      return { ok: true };
    },
  });
