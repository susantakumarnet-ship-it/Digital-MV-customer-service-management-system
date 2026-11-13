import { z } from 'zod';
import {
  correctionListQuery,
  objectId,
  reasonBody,
  temporaryAssetSchema,
  timeCorrectionDecisionSchema,
  timeCorrectionRequestSchema,
  timeEventSchema,
  visitCreateSchema,
  visitListQuery,
  visitUpdateSchema,
} from '@mv/shared';
import { ApiRouter, idParams } from '../../common/http/route';
import { hashRequest, withIdempotency } from '../../core/idempotency/idempotency.service';
import * as inspections from '../inspections/inspection.service';
import * as svc from './visit.service';

export const visitsRouter = new ApiRouter('/visits', 'Site visits & time');

visitsRouter
  .route({
    method: 'get',
    path: '/',
    summary: 'Visits within scope (filters: work order, engineer, mine, status, planned range)',
    access: { permissions: ['visit.read'] },
    query: visitListQuery,
    handler: ({ auth, query }) => svc.listVisits(auth, query),
  })
  .route({
    method: 'get',
    path: '/:id',
    summary: 'Visit detail: engineers\' six-step sequences with durations, corrections, reports',
    access: { permissions: ['visit.read'] },
    params: idParams,
    handler: ({ auth, params }) => svc.getVisit(auth, params.id),
  })
  .route({
    method: 'patch',
    path: '/:id',
    summary: 'Update visit details (visit engineers or authorised supervisors — BR-005)',
    access: { permissions: ['visit.update'] },
    params: idParams,
    body: visitUpdateSchema,
    handler: ({ params, body, ctx }) => svc.updateVisit(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/cancel',
    summary: 'Cancel a planned visit (reason required)',
    access: { permissions: ['visit.update'] },
    params: idParams,
    body: reasonBody,
    handler: ({ params, body, ctx }) => svc.cancelVisit(ctx, params.id, body.reason),
  })
  .route({
    method: 'post',
    path: '/:id/time-events',
    summary: 'Record the NEXT of the six time events for the signed-in engineer (server timestamp; Idempotency-Key supported)',
    description: 'Out-of-order → 409 OUT_OF_ORDER (details.expected); duplicate → 409 DUPLICATE_EVENT; another open sequence → 409 ACTIVE_SEQUENCE_EXISTS.',
    access: { permissions: ['visit.recordTime'] },
    params: idParams,
    body: timeEventSchema,
    raw: true,
    handler: async ({ req, res, params, body, ctx, auth }) => {
      const r = await withIdempotency(req.get('idempotency-key') ?? undefined, `time:${auth.userId}`, hashRequest([params.id, body.eventType]), async () => ({
        status: 200,
        body: await svc.recordTimeEvent(ctx, params.id, body),
      }));
      res.status(r.status).json(r.body);
    },
  })
  .route({
    method: 'post',
    path: '/:id/time-corrections',
    summary: 'Request a correction of one of my time events (original kept; reason required)',
    access: { permissions: ['visit.requestCorrection'] },
    params: idParams,
    body: timeCorrectionRequestSchema,
    handler: ({ params, body, ctx }) => svc.requestCorrection(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/inspection-reports',
    summary: 'Create (or return the existing) inspection report for this visit from the active checklist template',
    access: { permissions: ['inspection.create'] },
    params: idParams,
    body: z.object({ assetId: objectId.optional() }),
    status: 201,
    handler: ({ params, body, ctx }) => inspections.createReport(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/temporary-assets',
    summary: 'Record a temporary asset found on site (pending supervisor review — MD-08)',
    access: { permissions: ['inspection.create'] },
    params: idParams,
    body: temporaryAssetSchema,
    status: 201,
    handler: ({ params, body, ctx }) => inspections.createTemporaryAsset(ctx, params.id, body),
  });

/** POST /work-orders/:id/visits (ENG-02). */
export const workOrderVisitsRouter = new ApiRouter('/work-orders', 'Site visits & time');
workOrderVisitsRouter.route({
  method: 'post',
  path: '/:id/visits',
  summary: 'Create a site visit for an accepted work order',
  access: { permissions: ['visit.create'] },
  params: idParams,
  body: visitCreateSchema,
  status: 201,
  handler: ({ params, body, ctx }) => svc.createVisit(ctx, params.id, body),
});

/** /time-corrections (BRF §20). */
export const timeCorrectionsRouter = new ApiRouter('/time-corrections', 'Site visits & time');
timeCorrectionsRouter
  .route({
    method: 'get',
    path: '/',
    summary: 'Time correction requests (default: pending) within scope',
    access: { anyOf: ['visit.approveCorrection', 'visit.requestCorrection'] },
    query: correctionListQuery,
    handler: ({ auth, query }) => svc.listCorrections(auth, query),
  })
  .route({
    method: 'post',
    path: '/:id/decision',
    summary: 'Approve or reject a time correction (not your own — segregation of duties)',
    access: { permissions: ['visit.approveCorrection'] },
    params: idParams,
    body: timeCorrectionDecisionSchema,
    handler: ({ params, body, ctx }) => svc.decideCorrection(ctx, params.id, body),
  });
