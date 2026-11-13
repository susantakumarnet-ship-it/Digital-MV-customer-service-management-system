import { z } from 'zod';
import {
  calendarQuery,
  objectId,
  workOrderAssignmentSchema,
  workOrderCreateSchema,
  workOrderListQuery,
  workOrderTransitionSchema,
  workOrderUpdateSchema,
} from '@mv/shared';
import { ApiRouter, idParams } from '../../common/http/route';
import * as svc from './work-order.service';

export const workOrdersRouter = new ApiRouter('/work-orders', 'Work orders');

workOrdersRouter
  .route({
    method: 'get',
    path: '/',
    summary: 'Work-order list (filters, search, pagination) within the caller\'s scope; assignees always see their own',
    access: { permissions: ['workOrder.read'] },
    query: workOrderListQuery,
    handler: ({ auth, query }) => svc.listWorkOrders(auth, query),
  })
  .route({
    method: 'get',
    path: '/summary',
    summary: 'Work-order KPIs for dashboards (scoped)',
    access: { permissions: ['workOrder.read'] },
    handler: ({ auth }) => svc.workOrderSummary(auth),
  })
  .route({
    method: 'get',
    path: '/calendar',
    summary: 'Assignment board calendar feed: planned visits overlapping [from, to] (max 92 days) + optional unplanned list',
    access: { permissions: ['workOrder.read'] },
    query: calendarQuery,
    handler: ({ auth, query }) => svc.calendar(auth, query),
  })
  .route({
    method: 'get',
    path: '/workload',
    summary: 'Engineer workload (active, overdue, planned in range, due in 7 days); `siteId` marks engineers whose scope covers the site',
    access: { permissions: ['workOrder.assign'] },
    query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), siteId: objectId.optional() }),
    handler: ({ auth, query }) => svc.workload(auth, query),
  })
  .route({
    method: 'get',
    path: '/:id',
    summary: 'Work-order detail with assignment & status history and available actions',
    access: { permissions: ['workOrder.read'] },
    params: idParams,
    handler: ({ auth, params }) => svc.getWorkOrder(auth, params.id),
  })
  .route({
    method: 'patch',
    path: '/:id',
    summary: 'Update planning fields (until work starts). Changing the due date requires a reason.',
    access: { permissions: ['workOrder.update'] },
    params: idParams,
    body: workOrderUpdateSchema,
    handler: ({ params, body, ctx }) => svc.updateWorkOrder(ctx, params.id, body),
  })
  .route({
    method: 'patch',
    path: '/:id/assignment',
    summary: 'Assign or reassign engineers (history kept; reassigning accepted work requires a reason and re-acceptance)',
    access: { permissions: ['workOrder.assign'] },
    params: idParams,
    body: workOrderAssignmentSchema,
    handler: ({ params, body, ctx }) => svc.assignWorkOrder(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/transitions',
    summary: 'Workflow action: accept (assigned engineer), schedule, hold, resume, cancel',
    access: { permissions: ['workOrder.read'] },
    params: idParams,
    body: workOrderTransitionSchema,
    handler: ({ params, body, ctx }) => svc.transitionWorkOrder(ctx, params.id, body),
  });

/** POST /complaints/:id/work-orders (HO §9) lives on the complaints path. */
export const complaintWorkOrdersRouter = new ApiRouter('/complaints', 'Work orders');
complaintWorkOrdersRouter
  .route({
    method: 'post',
    path: '/:id/work-orders',
    summary: 'Create a work order for a classified complaint (optionally assigning engineers immediately)',
    access: { permissions: ['workOrder.create'] },
    params: idParams,
    body: workOrderCreateSchema,
    status: 201,
    handler: ({ params, body, ctx }) => svc.createWorkOrder(ctx, params.id, body),
  })
  .route({
    method: 'get',
    path: '/:id/work-orders',
    summary: 'Work orders raised against a complaint',
    access: { permissions: ['workOrder.read'] },
    params: idParams,
    handler: ({ auth, params }) => svc.listWorkOrders(auth, { complaintId: params.id, page: 1, limit: 100 } as never),
  });

/** GET /engineer/work-orders (HO §9): the signed-in engineer's assigned jobs. */
export const engineerRouter = new ApiRouter('/engineer', 'Work orders');
engineerRouter.route({
  method: 'get',
  path: '/work-orders',
  summary: 'My assigned work orders',
  access: { permissions: ['workOrder.read', 'workOrder.accept'] },
  query: workOrderListQuery,
  handler: ({ auth, query }) => svc.listWorkOrders(auth, { ...query, mine: 'true' }),
});
