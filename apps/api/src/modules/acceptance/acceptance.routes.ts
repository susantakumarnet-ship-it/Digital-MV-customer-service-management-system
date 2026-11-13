import { z } from 'zod';
import { acceptanceDecisionSchema, acceptanceRequestSchema } from '@mv/shared';
import { ApiRouter, idParams } from '../../common/http/route';
import { limiter } from '../../common/middleware/security';
import * as svc from './acceptance.service';

/** Customer acceptance and closure on a complaint (BRF §16–17). */
export const complaintAcceptanceRouter = new ApiRouter('/complaints', 'Customer acceptance');

complaintAcceptanceRouter
  .route({
    method: 'get',
    path: '/:id/acceptance',
    summary: 'Acceptance status, service summary, decision history and what the caller may do',
    access: { anyOf: ['acceptance.read', 'acceptance.request', 'acceptance.decide'] },
    params: idParams,
    handler: ({ params, auth }) => svc.acceptanceForComplaint(auth, params.id),
  })
  .route({
    method: 'post',
    path: '/:id/acceptance',
    summary: 'Customer portal: accept the service, or reject it with comments (reopens the complaint)',
    description: 'Only users of the complaint\'s customer organisation may decide (D-12). Requires status Customer Acceptance Pending.',
    access: { permissions: ['acceptance.decide'] },
    params: idParams,
    body: acceptanceDecisionSchema,
    handler: ({ params, body, ctx }) => svc.decideInPortal(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/request-acceptance',
    summary: 'Request customer acceptance: emails a single-use, expiring secure link and notifies portal users',
    access: { permissions: ['acceptance.request'] },
    params: idParams,
    body: acceptanceRequestSchema,
    handler: ({ params, body, ctx }) => svc.requestAcceptance(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/acceptance/resend',
    summary: 'Send a fresh acceptance link (previous links stop working)',
    access: { permissions: ['acceptance.request'] },
    params: idParams,
    body: acceptanceRequestSchema,
    handler: ({ params, body, ctx }) => svc.resendAcceptance(ctx, params.id, body),
  })
  .route({
    method: 'get',
    path: '/:id/closure-checklist',
    summary: 'Closure conditions (approval, time logs, materials, NCRs, acceptance) and whether the complaint can be closed',
    access: { anyOf: ['complaint.close', 'complaint.resolve', 'complaint.readInternal'] },
    params: idParams,
    handler: ({ params, auth }) => svc.closureChecklist(auth, params.id),
  });

const tokenLimiter = limiter({ windowMs: 60_000, limit: 30 });
const tokenParams = z.object({ token: z.string().min(20).max(100).regex(/^[A-Za-z0-9_-]+$/) });

/** /customer-acceptance/:token — public secure-link flow (BRF §20). */
export const publicAcceptanceRouter = new ApiRouter('/customer-acceptance', 'Customer acceptance');

publicAcceptanceRouter
  .route({
    method: 'get',
    path: '/:token',
    summary: 'Service summary for the customer. Opening the link never records acceptance.',
    description: '404 LINK_INVALID, 410 LINK_EXPIRED / LINK_SUPERSEDED. A used link returns the summary with `decided`.',
    access: { public: true },
    middleware: [tokenLimiter],
    params: tokenParams,
    handler: ({ params }) => svc.viewByToken(params.token),
  })
  .route({
    method: 'post',
    path: '/:token',
    summary: 'Record the customer decision (single use). Reject requires comments; the signer name is required.',
    access: { public: true },
    middleware: [tokenLimiter],
    params: tokenParams,
    body: acceptanceDecisionSchema,
    handler: ({ params, body, ctx }) => svc.decideByToken(ctx, params.token, body),
  });
