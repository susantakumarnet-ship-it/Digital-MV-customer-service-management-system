import { z } from 'zod';
import { objectId, reviewActionSchema, reviewQueueQuery } from '@mv/shared';
import { forbidden } from '../../common/errors';
import { ApiRouter, idParams } from '../../common/http/route';
import * as svc from './review.service';

/** /reviews (BRF §20): reviewer queue and the full review context. */
export const reviewsRouter = new ApiRouter('/reviews', 'Review & approval');

reviewsRouter
  .route({
    method: 'get',
    path: '/',
    summary: 'Review queue (default: submitted + under review) within scope; own reports are flagged',
    access: { anyOf: ['inspection.approve', 'inspection.return'] },
    query: reviewQueueQuery,
    handler: ({ auth, query }) => svc.reviewQueue(auth, query),
  })
  .route({
    method: 'get',
    path: '/summary',
    summary: 'Reviewer KPIs within scope: pending, under review, waiting > 24 h / 48 h, approved this week / total',
    access: { anyOf: ['inspection.approve', 'inspection.return', 'inspection.read'] },
    handler: ({ auth }) => svc.reviewSummary(auth),
  })
  .route({
    method: 'get',
    path: '/:id',
    summary: 'Review context for a report revision: checklist, evidence, six-step time log + flags, corrections, history, revisions',
    access: { permissions: ['inspection.read'] },
    params: idParams,
    handler: ({ auth, params }) => svc.reviewContext(auth, params.id),
  });

/** Review actions and revision history on /inspection-reports (HO §9). */
export const reportReviewRouter = new ApiRouter('/inspection-reports', 'Review & approval');

reportReviewRouter
  .route({
    method: 'post',
    path: '/:id/review-actions',
    summary: 'Start review, approve (comments optional; multi-level aware) or return for correction (comments + per-item feedback)',
    description: 'Returning creates the next DRAFT revision for the engineers; the returned revision is kept (superseded). Self-review is refused (BR-012).',
    access: { anyOf: ['inspection.approve', 'inspection.return'] },
    params: idParams,
    body: reviewActionSchema,
    handler: ({ params, body, ctx, auth }) => {
      if (body.action === 'return' && !auth.permissions.has('inspection.return')) throw forbidden();
      if (body.action !== 'return' && !auth.permissions.has('inspection.approve')) throw forbidden();
      return svc.performReviewAction(ctx, params.id, body);
    },
  })
  .route({
    method: 'get',
    path: '/:id/revisions',
    summary: 'All revisions of this visit\'s report',
    access: { permissions: ['inspection.read'] },
    params: idParams,
    handler: ({ auth, params }) => svc.listRevisions(auth, params.id),
  })
  .route({
    method: 'get',
    path: '/:id/compare',
    summary: 'Compare this revision with another revision of the same report (item-by-item)',
    access: { permissions: ['inspection.read'] },
    params: idParams,
    query: z.object({ with: objectId }),
    handler: ({ auth, params, query }) => svc.compareRevisions(auth, query.with, params.id),
  });
