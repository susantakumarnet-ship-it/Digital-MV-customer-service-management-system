import { z } from 'zod';
import { objectId, ncrActionSchema, ncrAssignSchema, ncrCommentSchema, ncrCreateSchema, ncrListQuery, ncrTransitionSchema, ncrUpdateSchema } from '@mv/shared';
import { ApiRouter, idParams } from '../../common/http/route';
import { filesOf, multipartJson, uploadMiddleware } from '../complaints/complaints.routes';
import * as svc from './ncr.service';

/** /ncrs — non-conformance reports (BRF §15, §20). */
export const ncrsRouter = new ApiRouter('/ncrs', 'NCRs');

ncrsRouter
  .route({
    method: 'get',
    path: '/',
    summary: 'NCRs within scope (filters: status|OPEN, complaint, work order, owner, mine, severity, category, overdue, q)',
    access: { permissions: ['ncr.read'] },
    query: ncrListQuery,
    handler: ({ query, auth }) => svc.listNcrs(auth, query as never),
  })
  .route({
    method: 'get',
    path: '/summary',
    summary: 'NCR counts within scope (open, awaiting verification, overdue, assigned to me, by status/severity)',
    access: { permissions: ['ncr.read'] },
    handler: ({ auth }) => svc.ncrSummary(auth),
  })
  .route({
    method: 'get',
    path: '/options',
    summary: 'Configured NCR categories/severities and (for assigners) owner candidates, optionally within a complaint scope',
    access: { anyOf: ['ncr.create', 'ncr.update', 'ncr.assign', 'ncr.read'] },
    query: z.object({ complaintId: objectId.optional() }),
    handler: ({ query, auth }) => svc.ncrOptions(auth, query),
  })
  .route({
    method: 'post',
    path: '/',
    summary: 'Raise an NCR against a complaint (optionally a work order, asset or failed checklist item); multipart with evidence',
    access: { permissions: ['ncr.create'] },
    middleware: [uploadMiddleware.array('files')],
    multipart: true,
    status: 201,
    handler: ({ req, ctx }) => svc.createNcr(ctx, ncrCreateSchema.parse(multipartJson(req)), filesOf(req)),
  })
  .route({
    method: 'get',
    path: '/:id',
    summary: 'NCR detail with evidence, verification, comments, revision history and available actions',
    access: { permissions: ['ncr.read'] },
    params: idParams,
    handler: ({ params, auth }) => svc.getNcr(auth, params.id),
  })
  .route({
    method: 'patch',
    path: '/:id',
    summary: 'Edit NCR details (category, severity, title, description, due date) while open',
    access: { anyOf: ['ncr.assign', 'ncr.create'] },
    params: idParams,
    body: ncrUpdateSchema,
    handler: ({ params, body, ctx }) => svc.updateNcr(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/assign',
    summary: 'Assign or reassign the NCR owner (and due date)',
    access: { permissions: ['ncr.assign'] },
    params: idParams,
    body: ncrAssignSchema,
    handler: ({ params, body, ctx }) => svc.assignNcr(ctx, params.id, body),
  })
  .route({
    method: 'put',
    path: '/:id/actions',
    summary: 'Owner records containment, root cause, corrective action, disposition (every change kept — NCR-04)',
    access: { permissions: ['ncr.update'] },
    params: idParams,
    body: ncrActionSchema,
    handler: ({ params, body, ctx }) => svc.recordActions(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/transition',
    summary: 'Workflow action: startAction, submitForVerification, return (reason), verify (needs verification evidence), close',
    description: 'The owner cannot verify their own NCR (D-08). Verification requires at least one verification attachment (BR-014).',
    access: { anyOf: ['ncr.update', 'ncr.verify', 'ncr.close'] },
    params: idParams,
    body: ncrTransitionSchema,
    handler: ({ params, body, ctx }) => svc.transitionNcr(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/comments',
    summary: 'Add a comment',
    access: { permissions: ['ncr.read'] },
    params: idParams,
    body: ncrCommentSchema,
    handler: ({ params, body, ctx }) => svc.addComment(ctx, params.id, body.text),
  })
  .route({
    method: 'post',
    path: '/:id/attachments',
    summary: 'Add evidence (context=evidence) or verification evidence (context=verification, verifier only)',
    access: { anyOf: ['ncr.create', 'ncr.update', 'ncr.verify'] },
    params: idParams,
    middleware: [uploadMiddleware.array('files')],
    multipart: true,
    handler: ({ req, params, ctx }) => {
      const meta = z.object({ context: z.enum(['evidence', 'verification']).default('evidence') }).parse(multipartJson(req));
      return svc.addEvidence(ctx, params.id, filesOf(req), meta.context);
    },
  });
