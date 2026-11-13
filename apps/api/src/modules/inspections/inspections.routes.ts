import { z } from 'zod';
import {
  inspectionTemplateSchema,
  objectId,
  paginationQuery,
  reasonBody,
  reportDraftSchema,
  templateListQuery,
  temporaryAssetDecisionSchema,
} from '@mv/shared';
import { ApiRouter, idParams } from '../../common/http/route';
import { filesOf, multipartJson, uploadMiddleware } from '../complaints/complaints.routes';
import * as svc from './inspection.service';

/** /inspections — checklist templates and temporary-asset review. */
export const inspectionsRouter = new ApiRouter('/inspections', 'Inspections & reports');

inspectionsRouter
  .route({
    method: 'get',
    path: '/templates',
    summary: 'Checklist templates (all versions; filter by equipment type/status)',
    access: { anyOf: ['inspection.manageTemplates', 'inspection.read'] },
    query: templateListQuery,
    handler: ({ query }) => svc.listTemplates(query),
  })
  .route({
    method: 'get',
    path: '/templates/:id',
    summary: 'One checklist template version',
    access: { anyOf: ['inspection.manageTemplates', 'inspection.read'] },
    params: idParams,
    handler: ({ params }) => svc.getTemplate(params.id),
  })
  .route({
    method: 'post',
    path: '/templates',
    summary: 'Create a draft template version for an equipment type',
    access: { permissions: ['inspection.manageTemplates'] },
    body: inspectionTemplateSchema,
    status: 201,
    handler: ({ body, ctx }) => svc.createTemplate(ctx, body),
  })
  .route({
    method: 'put',
    path: '/templates/:id',
    summary: 'Edit a DRAFT template version',
    access: { permissions: ['inspection.manageTemplates'] },
    params: idParams,
    body: inspectionTemplateSchema,
    handler: ({ params, body, ctx }) => svc.updateTemplate(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/templates/:id/publish',
    summary: 'Publish a draft (becomes ACTIVE; previous active version is retired)',
    access: { permissions: ['inspection.manageTemplates'] },
    params: idParams,
    handler: ({ params, ctx }) => svc.publishTemplate(ctx, params.id),
  })
  .route({
    method: 'post',
    path: '/templates/:id/new-version',
    summary: 'Start a new draft version from this version',
    access: { permissions: ['inspection.manageTemplates'] },
    params: idParams,
    status: 201,
    handler: ({ params, ctx }) => svc.newTemplateVersion(ctx, params.id),
  })
  .route({
    method: 'post',
    path: '/templates/:id/retire',
    summary: 'Retire the active version (no template for that equipment type until another is published)',
    access: { permissions: ['inspection.manageTemplates'] },
    params: idParams,
    body: reasonBody,
    handler: ({ params, body, ctx }) => svc.retireTemplate(ctx, params.id, body.reason),
  })
  .route({
    method: 'get',
    path: '/temporary-assets',
    summary: 'Temporary assets awaiting review (within scope)',
    access: { permissions: ['inspection.reviewTempAsset'] },
    handler: ({ auth }) => svc.listTemporaryAssets(auth),
  })
  .route({
    method: 'post',
    path: '/temporary-assets/:id/review',
    summary: 'Approve (optionally assign a permanent code) or reject a temporary asset',
    access: { permissions: ['inspection.reviewTempAsset'] },
    params: idParams,
    body: temporaryAssetDecisionSchema,
    handler: ({ params, body, ctx }) => svc.reviewTemporaryAsset(ctx, params.id, body),
  });

/** /inspection-reports (BRF §20). */
export const inspectionReportsRouter = new ApiRouter('/inspection-reports', 'Inspections & reports');

inspectionReportsRouter
  .route({
    method: 'get',
    path: '/',
    summary: 'Inspection reports within scope (filter by status, work order, visit)',
    access: { permissions: ['inspection.read'] },
    query: paginationQuery.extend({ status: z.string().max(200).optional(), workOrderId: objectId.optional(), visitId: objectId.optional() }),
    handler: ({ auth, query }) => svc.listReports(auth, query),
  })
  .route({
    method: 'get',
    path: '/:id',
    summary: 'Report with template snapshot, results, evidence, per-item issues and submission readiness',
    access: { permissions: ['inspection.read'] },
    params: idParams,
    handler: ({ auth, params }) => svc.getReport(auth, params.id),
  })
  .route({
    method: 'put',
    path: '/:id',
    summary: 'Save draft results (partial allowed; drafts only)',
    access: { permissions: ['inspection.create'] },
    params: idParams,
    body: reportDraftSchema,
    handler: ({ params, body, ctx }) => svc.saveDraft(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/attachments',
    summary: 'Upload evidence (multipart `files`; `data`={"itemKey":"…"} links it to a checklist item)',
    access: { permissions: ['inspection.create'] },
    params: idParams,
    middleware: [uploadMiddleware.array('files')],
    multipart: true,
    handler: async ({ req, params, ctx }) => {
      const meta = z.object({ itemKey: z.string().max(40).optional() }).parse(multipartJson(req));
      return svc.addReportAttachments(ctx, params.id, filesOf(req), meta.itemKey);
    },
  })
  .route({
    method: 'delete',
    path: '/:id/attachments/:attachmentId',
    summary: 'Remove evidence from a DRAFT (soft removal, audited)',
    access: { permissions: ['inspection.create'] },
    params: z.object({ id: objectId, attachmentId: objectId }),
    body: reasonBody,
    handler: ({ params, body, ctx }) => svc.removeReportAttachment(ctx, params.id, params.attachmentId, body.reason),
  })
  .route({
    method: 'post',
    path: '/:id/submit',
    summary: 'Submit for review — validates BR-006/007/008 and D-33; the revision becomes immutable',
    access: { permissions: ['inspection.submit'] },
    params: idParams,
    handler: ({ params, ctx }) => svc.submitReport(ctx, params.id),
  });
