import { z } from 'zod';
import {
  adjustmentSchema,
  backorderSchema,
  balanceQuery,
  issueSchema,
  ledgerQuery,
  materialDecisionSchema,
  materialListQuery,
  materialRequestCreateSchema,
  materialRequestUpdateSchema,
  materialRevisionSchema,
  receiptSchema,
  reserveSchema,
  returnSchema,
  unreserveSchema,
} from '@mv/shared';
import { ApiRouter, idParams } from '../../common/http/route';
import { filesOf, multipartJson, uploadMiddleware } from '../complaints/complaints.routes';
import * as inventory from './inventory.service';
import * as svc from './material.service';

/** /material-requests (BRF §20, HO §9). */
export const materialRequestsRouter = new ApiRouter('/material-requests', 'Materials');

materialRequestsRouter
  .route({
    method: 'get',
    path: '/',
    summary: 'Material requests within scope (filters: status, work order, complaint, mine, urgency, store queue)',
    access: { permissions: ['material.read'] },
    query: materialListQuery,
    handler: ({ auth, query }) => svc.listRequests(auth, query),
  })
  .route({
    method: 'get',
    path: '/summary',
    summary: 'Material KPIs (pending approval, ready to issue, critical open…)',
    access: { permissions: ['material.read'] },
    handler: ({ auth }) => svc.materialSummary(auth),
  })
  .route({
    method: 'post',
    path: '/',
    summary: 'Raise a material request for a work order (assigned engineers); submitted immediately unless submit=false',
    access: { permissions: ['material.create'] },
    body: materialRequestCreateSchema,
    status: 201,
    handler: ({ body, ctx }) => svc.createRequest(ctx, body),
  })
  .route({
    method: 'get',
    path: '/:id',
    summary: 'Request detail with lines, decisions, stock transactions and handover evidence',
    access: { permissions: ['material.read'] },
    params: idParams,
    handler: ({ auth, params }) => svc.getRequest(auth, params.id),
  })
  .route({
    method: 'patch',
    path: '/:id',
    summary: 'Edit a draft / clarification-required request (requester); include clarificationReply when answering',
    access: { permissions: ['material.create'] },
    params: idParams,
    body: materialRequestUpdateSchema,
    handler: ({ params, body, ctx }) => svc.updateRequest(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/submit',
    summary: 'Submit (or resubmit after clarification)',
    access: { permissions: ['material.create'] },
    params: idParams,
    handler: ({ params, ctx }) => svc.submitRequest(ctx, params.id),
  })
  .route({
    method: 'post',
    path: '/:id/decision',
    summary: 'Supervisor: approve (optionally reduced quantities), reject or request clarification — never your own request',
    access: { permissions: ['material.approve'] },
    params: idParams,
    body: materialDecisionSchema,
    handler: ({ params, body, ctx }) => svc.decideRequest(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/revise-approval',
    summary: 'BR-013: revise a line\'s approved quantity after approval (reason required)',
    access: { permissions: ['material.approve'] },
    params: idParams,
    body: materialRevisionSchema,
    handler: ({ params, body, ctx }) => svc.reviseApproval(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/reserve',
    summary: 'Storekeeper: reserve stock in a warehouse for a line',
    access: { permissions: ['inventory.issue'] },
    params: idParams,
    body: reserveSchema,
    handler: ({ params, body, ctx }) => svc.reserve(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/unreserve',
    summary: 'Storekeeper: release a reservation (reason required)',
    access: { permissions: ['inventory.issue'] },
    params: idParams,
    body: unreserveSchema,
    handler: ({ params, body, ctx }) => svc.unreserve(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/issue',
    summary: 'Storekeeper: issue (full/partial) with batch/serials, recipient and handover evidence (multipart `data` + `files`)',
    description: 'Never more than approved minus already issued (BR-013 → 409 EXCEEDS_APPROVED); insufficient stock → 409 INSUFFICIENT_STOCK.',
    access: { permissions: ['inventory.issue'] },
    params: idParams,
    middleware: [uploadMiddleware.array('files')],
    multipart: true,
    handler: async ({ req, params, ctx }) => svc.issue(ctx, params.id, issueSchema.parse(multipartJson(req)), filesOf(req)),
  })
  .route({
    method: 'post',
    path: '/:id/backorder',
    summary: 'Storekeeper: record a backorder for a line',
    access: { permissions: ['inventory.issue'] },
    params: idParams,
    body: backorderSchema,
    handler: ({ params, body, ctx }) => svc.recordBackorder(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/return',
    summary: 'Storekeeper: accept returned material — good quantity back to stock, damaged/unusable recorded separately',
    access: { permissions: ['inventory.issue'] },
    params: idParams,
    body: returnSchema,
    handler: ({ params, body, ctx }) => svc.returnMaterial(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/close',
    summary: 'Close a fully handled request (no outstanding reservations)',
    access: { permissions: ['material.approve'] },
    params: idParams,
    body: z.object({ reason: z.string().trim().max(1000).optional() }),
    handler: ({ params, body, ctx }) => svc.closeRequest(ctx, params.id, body.reason),
  });

/** /inventory (BRF §20): balances, ledger, receipts, adjustments, reconciliation. */
export const inventoryRouter = new ApiRouter('/inventory', 'Inventory');

inventoryRouter
  .route({
    method: 'get',
    path: '/balances',
    summary: 'Stock balances per item × warehouse (on hand, reserved, available, low-stock flag)',
    access: { permissions: ['inventory.read'] },
    query: balanceQuery,
    handler: ({ query }) => inventory.listBalances(query),
  })
  .route({
    method: 'get',
    path: '/ledger',
    summary: 'Immutable stock transaction ledger',
    access: { permissions: ['inventory.read'] },
    query: ledgerQuery,
    handler: ({ query }) => inventory.listLedger(query),
  })
  .route({
    method: 'get',
    path: '/items/:id',
    summary: 'Stock of one catalogue item across warehouses',
    access: { permissions: ['inventory.read'] },
    params: idParams,
    handler: ({ params }) => inventory.itemStock(params.id),
  })
  .route({
    method: 'post',
    path: '/receipts',
    summary: 'Receive stock or record opening balances',
    access: { permissions: ['inventory.adjust'] },
    body: receiptSchema,
    status: 201,
    handler: ({ body, ctx }) => inventory.receiveStock(ctx, body),
  })
  .route({
    method: 'post',
    path: '/adjustments',
    summary: 'Stock adjustment (+/−) with mandatory reason',
    access: { permissions: ['inventory.adjust'] },
    body: adjustmentSchema,
    status: 201,
    handler: ({ body, ctx }) => inventory.adjustStock(ctx, body),
  })
  .route({
    method: 'get',
    path: '/reconcile',
    summary: 'Integrity check: recompute balances from the ledger and report any drift',
    access: { permissions: ['inventory.adjust'] },
    handler: () => inventory.reconcile(),
  });

