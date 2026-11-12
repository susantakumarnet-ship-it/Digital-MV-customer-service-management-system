import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { masterOptionsQuery, publicComplaintSchema, type PublicSubmissionResult } from '@mv/shared';
import { env } from '../../config/env';
import { safeEqual } from '../../common/crypto';
import { AppError, badRequest, notFound } from '../../common/errors';
import { ApiRouter } from '../../common/http/route';
import { logger } from '../../common/logger';
import { limiter } from '../../common/middleware/security';
import { hashRequest, withIdempotency } from '../../core/idempotency/idempotency.service';
import { getSettingsGroup } from '../../core/settings/settings.service';
import { masterOptions } from '../masters/masters.service';
import { createComplaint, findOwnRecentComplaint } from './complaint.service';
import { filesOf, multipartJson, uploadMiddleware } from './complaints.routes';

/** Master data the public form may read (active records only, minimal fields). */
const PUBLIC_RESOURCES = ['regions', 'cities', 'sites', 'assets', 'equipmentTypes', 'requestTypes', 'priorities'] as const;

// ---- Form token: proves the form was opened ≥ N seconds ago (anti-automation) ------------------
function formTokenKey() {
  return createHmac('sha256', env().JWT_ACCESS_SECRET).update('public-form-token').digest();
}
export function issueFormToken(now = Date.now()) {
  const payload = `${now}.${randomBytes(8).toString('hex')}`;
  return `${payload}.${createHmac('sha256', formTokenKey()).update(payload).digest('base64url')}`;
}
export function checkFormToken(token: string, minSeconds: number): string | null {
  const [ts, nonce, sig] = token.split('.');
  if (!ts || !nonce || !sig) return 'Invalid form session. Please reload the page.';
  if (!safeEqual(createHmac('sha256', formTokenKey()).update(`${ts}.${nonce}`).digest('base64url'), sig)) {
    return 'Invalid form session. Please reload the page.';
  }
  const age = (Date.now() - Number(ts)) / 1000;
  if (age < minSeconds) return 'The form was submitted too quickly. Please review your details and submit again.';
  if (age > 24 * 3600) return 'This form has expired. Please reload the page.';
  return null;
}

async function verifyCaptcha(token: string | undefined, ip?: string) {
  const secret = env().TURNSTILE_SECRET_KEY;
  if (!secret) return true; // CAPTCHA not configured (D-32): other controls still apply.
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
    });
    const data = (await res.json()) as { success?: boolean };
    return Boolean(data.success);
  } catch (err) {
    logger.error({ err }, 'CAPTCHA verification failed');
    return false;
  }
}

async function assertPublicFormEnabled() {
  const s = await getSettingsGroup('publicForm');
  if (!s.enabled) throw notFound('Public complaint form');
  return s;
}

/** Per-IP hourly limit taken from configuration (PUB-05). */
const submissionLimiter = limiter({
  windowMs: 60 * 60_000,
  limit: async () => (await getSettingsGroup('publicForm')).maxSubmissionsPerHourPerIp,
});
const readLimiter = limiter({ windowMs: 60_000, limit: 120 });

export const publicRouter = new ApiRouter('/public', 'Public complaint form');

publicRouter
  .route({
    method: 'get',
    path: '/complaint-form',
    summary: 'Form bootstrap: privacy notice, attachment policy, CAPTCHA site key and a signed form token',
    access: { public: true },
    middleware: [readLimiter],
    handler: async () => {
      const form = await assertPublicFormEnabled();
      const attachments = await getSettingsGroup('attachments');
      return {
        formToken: issueFormToken(),
        privacyNoticeVersion: form.privacyNoticeVersion,
        privacyNoticeText: form.privacyNoticeText,
        attachments,
        captchaSiteKey: env().TURNSTILE_SITE_KEY ?? null,
      };
    },
  })
  .route({
    method: 'get',
    path: '/options/:resource',
    summary: 'Active master data for cascading dropdowns (Region › City › Site › Asset › Equipment, request types, priorities)',
    access: { public: true },
    middleware: [readLimiter],
    params: z.object({ resource: z.enum(PUBLIC_RESOURCES) }),
    query: masterOptionsQuery.omit({ includeInactive: true }),
    handler: async ({ params, query }) => {
      await assertPublicFormEnabled();
      const rows = await masterOptions(params.resource, { ...query, includeInactive: false });
      // Expose only what the form needs.
      return rows.map((r) => ({
        id: r.id,
        label: r.label,
        code: r.code,
        ...(r.regionId ? { regionId: r.regionId } : {}),
        ...(r.cityId ? { cityId: r.cityId } : {}),
        ...(r.siteId ? { siteId: r.siteId } : {}),
        ...(r.equipmentTypeId ? { equipmentTypeId: r.equipmentTypeId } : {}),
      }));
    },
  })
  .route({
    method: 'post',
    path: '/complaints',
    summary: 'Submit a complaint without an account. Multipart: `data` JSON + `files`. Send an Idempotency-Key header.',
    description:
      'Anti-abuse: per-IP hourly limit, honeypot field, minimum fill time via signed form token, optional Turnstile CAPTCHA, idempotent replays. Returns the complaint reference.',
    access: { public: true },
    middleware: [submissionLimiter, uploadMiddleware.array('files')],
    multipart: true,
    status: 201,
    raw: true,
    handler: async ({ req, res, ctx }) => {
      const form = await assertPublicFormEnabled();
      const raw = multipartJson(req);
      const input = publicComplaintSchema.parse(raw);
      const tokenError = checkFormToken(input.formToken, form.minimumFillSeconds);
      if (tokenError) throw new AppError(400, 'FORM_TOKEN_INVALID', tokenError);
      if (input.consentVersion !== form.privacyNoticeVersion) {
        throw new AppError(409, 'CONSENT_OUTDATED', 'The privacy notice has changed. Please reload the page and accept the current notice.');
      }
      if (!(await verifyCaptcha(input.captchaToken, ctx.ip))) throw badRequest('Please complete the human verification check.');

      const files = filesOf(req);
      const key = req.get('idempotency-key') ?? undefined;
      const { formToken: _ft, website: _w, captchaToken: _ct, ...stable } = input;
      const result = await withIdempotency<PublicSubmissionResult>(
        key,
        `public.complaints:${ctx.ip}`,
        hashRequest([stable, ...files.map((f) => f.buffer)]),
        async () => {
          const earlier = await findOwnRecentComplaint(input.email, input.siteId);
          const c = await createComplaint(
            { ...ctx, auth: undefined },
            input,
            { source: 'PUBLIC_FORM', consent: { accepted: true, version: input.consentVersion }, files },
          );
          return {
            status: 201,
            body: {
              referenceNo: c.referenceNo,
              receivedAt: c.receivedAt.toISOString(),
              possibleDuplicateOf: earlier?.referenceNo,
              message: `Your complaint has been registered with reference ${c.referenceNo}. A confirmation has been sent to ${input.email}.`,
            },
          };
        },
      );
      res.status(result.status).json(result.body);
    },
  });
