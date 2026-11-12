import type { Request } from 'express';
import multer from 'multer';
import { Types } from 'mongoose';
import { z } from 'zod';
import {
  AUDIT_ACTIONS,
  classificationSchema,
  complaintListQuery,
  complaintNoteSchema,
  complaintTransitionSchema,
  complaintUpdateSchema,
  customerResponseSchema,
  internalComplaintSchema,
  paginationQuery,
} from '@mv/shared';
import { badRequest } from '../../common/errors';
import { ApiRouter, idParams, paged } from '../../common/http/route';
import { AuditLog } from '../../core/audit/audit.model';
import { audit } from '../../core/audit/audit.service';
import { hashRequest, withIdempotency } from '../../core/idempotency/idempotency.service';
import { Role } from '../roles/role.model';
import { User } from '../users/user.model';
import { shouldMaskContact, toSummaries } from './complaint.dto';
import { Complaint } from './complaint.model';
import * as svc from './complaint.service';

/** Hard transport limits; the configurable policy (D-20) is enforced in validateFiles(). */
export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 50, fields: 30, fieldSize: 64 * 1024 },
});

/** Multipart requests carry the JSON payload in a `data` field. */
export function multipartJson(req: Request) {
  if (typeof req.body?.data === 'string') {
    try {
      return JSON.parse(req.body.data);
    } catch {
      throw badRequest('The "data" field must contain valid JSON');
    }
  }
  return req.body ?? {};
}

export function filesOf(req: Request) {
  return ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => ({ originalname: f.originalname, buffer: f.buffer, size: f.size }));
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formula injection and quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export const complaintsRouter = new ApiRouter('/complaints', 'Complaints');

complaintsRouter
  .route({
    method: 'get',
    path: '/',
    summary: 'Complaint queue (filters, search, pagination) within the caller\'s data scope',
    access: { permissions: ['complaint.read'] },
    query: complaintListQuery,
    handler: ({ auth, query }) => svc.listComplaints(auth, query),
  })
  .route({
    method: 'get',
    path: '/summary',
    summary: 'Complaint KPIs for dashboards (scoped)',
    access: { permissions: ['complaint.read'] },
    handler: ({ auth }) => svc.complaintSummary(auth),
  })
  .route({
    method: 'get',
    path: '/export',
    summary: 'Export the filtered complaint list as CSV (max 10,000 rows, audited)',
    access: { permissions: ['complaint.read', 'complaint.export'] },
    query: complaintListQuery.omit({ page: true, limit: true }),
    raw: true,
    handler: async ({ auth, query, res, ctx }) => {
      const filter = svc.buildListFilter(auth, { ...query, page: 1, limit: 1 });
      const rows = await Complaint.find(filter).sort({ receivedAt: -1 }).limit(10_000).lean();
      const summaries = await toSummaries(rows);
      const mask = shouldMaskContact(auth);
      const header = ['Reference', 'Received (UTC)', 'Status', 'Source', 'Customer', 'Organization', 'Contact', 'Mobile', 'Email', 'Region', 'City', 'Site', 'Request type', 'Priority', 'Due (UTC)', 'Overdue', 'Supervisor', 'Duplicate of', 'Description'];
      const lines = [header.map(csvCell).join(',')];
      rows.forEach((c, i) => {
        const s = summaries[i];
        lines.push(
          [
            c.referenceNo, c.receivedAt, s.statusLabel, c.source, c.customerName, s.organizationName, c.contactPerson,
            mask ? '(masked)' : c.mobile, mask ? '(masked)' : c.email, c.snapshot?.regionName, c.snapshot?.cityName, c.snapshot?.siteName,
            s.requestType?.name, s.priority?.name, c.dueAt, s.overdue ? 'Yes' : 'No', s.supervisor?.name, s.duplicateOf?.referenceNo, c.description,
          ]
            .map(csvCell)
            .join(','),
        );
      });
      await audit(ctx, { action: AUDIT_ACTIONS.EXPORT, entityType: 'complaint', meta: { format: 'csv', rows: rows.length, filters: query } });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="complaints-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send('﻿' + lines.join('\r\n'));
    },
  })
  .route({
    method: 'get',
    path: '/options/:resource',
    summary: 'Dropdown options for complaint forms, limited to the caller\'s data scope (sites/assets and the regions/cities containing them)',
    access: { anyOf: ['complaint.create', 'complaint.read'] },
    params: z.object({ resource: z.enum(['regions', 'cities', 'sites', 'assets', 'equipmentTypes', 'requestTypes', 'priorities']) }),
    query: z.object({ parentField: z.string().max(40).optional(), parentId: z.string().regex(/^[a-f\d]{24}$/i).optional() }),
    handler: ({ auth, params, query }) => svc.scopedOptions(auth, params.resource, query),
  })
  .route({
    method: 'get',
    path: '/reviewers',
    summary: 'Active users who can review complaints (for supervisor assignment)',
    access: { permissions: ['complaint.classify'] },
    handler: async () => {
      const roles = await Role.find({ status: 'ACTIVE', permissions: 'complaint.classify' }).select('_id').lean();
      const users = await User.find({ status: 'ACTIVE', roleIds: { $in: roles.map((r) => r._id) } }).select('name email').sort({ name: 1 }).lean();
      return users.map((u) => ({ id: String(u._id), name: u.name, email: u.email }));
    },
  })
  .route({
    method: 'post',
    path: '/',
    summary: 'Register a complaint internally (staff) or via the customer portal. Multipart: `data` JSON + `files`.',
    description: 'Send an `Idempotency-Key` header to make retries safe.',
    access: { permissions: ['complaint.create'] },
    middleware: [uploadMiddleware.array('files')],
    multipart: true,
    status: 201,
    handler: async ({ req, res, ctx, auth }) => {
      const input = internalComplaintSchema.parse(multipartJson(req));
      const files = filesOf(req);
      const isStaff = auth.permissions.has('complaint.update');
      const key = req.get('idempotency-key') ?? undefined;
      const r = await withIdempotency(key, `complaints.create:${auth.userId}`, hashRequest([input, ...files.map((f) => f.buffer)]), async () => {
        const c = await svc.createComplaint(ctx, input, {
          source: isStaff ? input.source : 'CUSTOMER_PORTAL',
          receivedAt: isStaff ? input.receivedAt : undefined,
          consent: { accepted: true, version: 'internal' },
          files,
        });
        return { status: 201, body: await svc.getComplaint(auth, String(c._id)) };
      });
      res.status(r.status).json(r.body);
    },
    raw: true,
  })
  .route({
    method: 'get',
    path: '/:id',
    summary: 'Complaint detail (internal notes only with complaint.readInternal; contact masked for read-only roles)',
    access: { permissions: ['complaint.read'] },
    params: idParams,
    handler: ({ auth, params }) => svc.getComplaint(auth, params.id),
  })
  .route({
    method: 'patch',
    path: '/:id',
    summary: 'Edit intake details (allowed until the complaint is assigned)',
    access: { permissions: ['complaint.update'] },
    params: idParams,
    body: complaintUpdateSchema,
    handler: ({ params, body, ctx }) => svc.updateIntake(ctx, params.id, body),
  })
  .route({
    method: 'put',
    path: '/:id/classification',
    summary: 'Review & classify: request type, priority (sets SLA due date), category, supervisor',
    access: { permissions: ['complaint.classify'] },
    params: idParams,
    body: classificationSchema,
    handler: ({ params, body, ctx }) => svc.classifyComplaint(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/transitions',
    summary: 'Perform a workflow action (startReview, requestInfo, infoReceived, markDuplicate, reject, cancel, …)',
    description: 'The workflow engine checks the action\'s own permission, current state, mandatory reason and business guards.',
    access: { permissions: ['complaint.read'] },
    params: idParams,
    body: complaintTransitionSchema,
    handler: ({ params, body, ctx }) => svc.transitionComplaint(ctx, params.id, body),
  })
  .route({
    method: 'post',
    path: '/:id/notes',
    summary: 'Add an internal note (never shown to customers)',
    access: { permissions: ['complaint.update', 'complaint.readInternal'] },
    params: idParams,
    body: complaintNoteSchema,
    handler: ({ params, body, ctx }) => svc.addNote(ctx, params.id, body.text),
  })
  .route({
    method: 'post',
    path: '/:id/attachments',
    summary: 'Add attachments (multipart `files`; staff may set `data`={"context":"internal"})',
    access: { permissions: ['complaint.read'] },
    params: idParams,
    middleware: [uploadMiddleware.array('files')],
    multipart: true,
    handler: async ({ req, params, ctx }) => {
      const meta = z.object({ context: z.enum(['intake', 'internal']).default('intake') }).parse(multipartJson(req));
      return svc.addAttachments(ctx, params.id, filesOf(req), meta.context);
    },
  })
  .route({
    method: 'post',
    path: '/:id/customer-response',
    summary: 'Customer portal: answer a request for information (multipart `data` + optional `files`)',
    access: { permissions: ['complaint.read', 'acceptance.decide'] },
    params: idParams,
    middleware: [uploadMiddleware.array('files')],
    multipart: true,
    handler: async ({ req, params, ctx }) => {
      const body = customerResponseSchema.parse(multipartJson(req));
      return svc.customerRespond(ctx, params.id, body.message, filesOf(req));
    },
  })
  .route({
    method: 'get',
    path: '/:id/possible-duplicates',
    summary: 'Recent open complaints for the same site (same asset/email flagged)',
    access: { permissions: ['complaint.duplicate'] },
    params: idParams,
    handler: ({ auth, params }) => svc.possibleDuplicates(auth, params.id),
  })
  .route({
    method: 'get',
    path: '/:id/activity',
    summary: 'Audit trail for this complaint',
    access: { permissions: ['complaint.read', 'complaint.readInternal'] },
    params: idParams,
    query: paginationQuery,
    handler: async ({ auth, params, query }) => {
      const c = await svc.loadComplaintInScope(auth, params.id);
      const filter = { entityType: 'complaint', entityId: new Types.ObjectId(String(c._id)) };
      const [rows, total] = await Promise.all([
        AuditLog.find(filter).sort({ timestamp: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
        AuditLog.countDocuments(filter),
      ]);
      return paged(
        rows.map((r) => ({ id: String(r._id), timestamp: r.timestamp, actorName: r.actorName ?? 'System', action: r.action, reason: r.reason ?? null, before: r.before ?? null, after: r.after ?? null })),
        total,
        query.page,
        query.limit,
      );
    },
  });

