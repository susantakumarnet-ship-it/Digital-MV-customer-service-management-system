import { Types } from 'mongoose';
import { z } from 'zod';
import { objectId, paginationQuery } from '@mv/shared';
import { escapeRegex } from '../../common/crypto';
import { notFound } from '../../common/errors';
import { ApiRouter, idParams, paged } from '../../common/http/route';
import { AuditLog } from '../../core/audit/audit.model';

const auditQuery = paginationQuery.extend({
  entityType: z.string().trim().max(60).optional(),
  entityId: objectId.optional(),
  actorId: objectId.optional(),
  action: z.string().trim().max(80).optional(),
  outcome: z.enum(['SUCCESS', 'FAILURE']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

function toDto(r: Record<string, any>, includePayload: boolean) {
  return {
    id: String(r._id),
    timestamp: r.timestamp,
    actorId: r.actorId ? String(r.actorId) : null,
    actorName: r.actorName ?? null,
    actorRoles: r.actorRoles ?? [],
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId ? String(r.entityId) : null,
    entityRef: r.entityRef ?? null,
    outcome: r.outcome,
    reason: r.reason ?? null,
    ip: r.ip ?? null,
    userAgent: r.userAgent ?? null,
    requestId: r.requestId ?? null,
    // Payloads are redacted at write time; list view omits them to keep responses bounded.
    ...(includePayload ? { before: r.before ?? null, after: r.after ?? null, meta: r.meta ?? null } : {}),
  };
}

export const auditRouter = new ApiRouter('/audit-logs', 'Audit');

auditRouter
  .route({
    method: 'get',
    path: '/',
    summary: 'Search audit history',
    access: { permissions: ['audit.read'] },
    query: auditQuery,
    handler: async ({ query }) => {
      const filter: Record<string, unknown> = {};
      if (query.entityType) filter.entityType = query.entityType;
      if (query.entityId) filter.entityId = new Types.ObjectId(query.entityId);
      if (query.actorId) filter.actorId = new Types.ObjectId(query.actorId);
      if (query.action) filter.action = { $regex: '^' + escapeRegex(query.action) };
      if (query.outcome) filter.outcome = query.outcome;
      if (query.from || query.to) filter.timestamp = { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) };
      if (query.q) {
        const rx = new RegExp(escapeRegex(query.q), 'i');
        filter.$or = [{ entityRef: rx }, { actorName: rx }, { reason: rx }];
      }
      const [rows, total] = await Promise.all([
        AuditLog.find(filter).sort({ timestamp: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
        AuditLog.countDocuments(filter),
      ]);
      return paged(rows.map((r) => toDto(r, false)), total, query.page, query.limit);
    },
  })
  .route({
    method: 'get',
    path: '/entity-types',
    summary: 'Distinct entity types present in the audit log (for filters)',
    access: { permissions: ['audit.read'] },
    handler: async () => (await AuditLog.distinct('entityType')).sort(),
  })
  .route({
    method: 'get',
    path: '/:id',
    summary: 'One audit entry with redacted before/after values',
    access: { permissions: ['audit.read'] },
    params: idParams,
    handler: async ({ params }) => {
      const r = await AuditLog.findById(params.id).lean();
      if (!r) throw notFound('Audit entry');
      return toDto(r, true);
    },
  });
