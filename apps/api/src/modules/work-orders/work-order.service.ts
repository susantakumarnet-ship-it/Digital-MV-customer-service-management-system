import { Types, type ClientSession } from 'mongoose';
import {
  AUDIT_ACTIONS,
  WORK_ORDER_CLOSED_STATUSES,
  WORK_ORDER_DONE_STATUSES,
  WORK_ORDER_EDITABLE_STATUSES,
  type CalendarItemDto,
  type EngineerWorkloadDto,
  type WorkOrderCreateInput,
  type WorkOrderDetailDto,
  type WorkOrderListQuery,
  type WorkOrderSummaryDto,
} from '@mv/shared';
import type { AuthContext, RequestContext } from '../../common/context';
import { escapeRegex } from '../../common/crypto';
import { conflict, forbidden, notFound, validationFailed } from '../../common/errors';
import { paged, parseSort } from '../../common/http/route';
import { audit, diff } from '../../core/audit/audit.service';
import { nextReference } from '../../core/counters/counter.service';
import { renderEmail, sendMail } from '../../core/mail/mail.service';
import { notify } from '../../core/notifications/notification.service';
import { inScope, withScope } from '../../core/scope/scope.service';
import { getSettingsGroup } from '../../core/settings/settings.service';
import { availableActions, getDefinition, transition as wfTransition } from '../../core/workflow/workflow.engine';
import { withTransaction } from '../../db/transaction';
import { env } from '../../config/env';
import { loadPrincipal } from '../auth/principal.service';
import { Complaint } from '../complaints/complaint.model';
import { loadComplaintInScope } from '../complaints/complaint.service';
import { Asset, EquipmentType, Priority, Site } from '../masters/master.models';
import { Role } from '../roles/role.model';
import { User } from '../users/user.model';
import { WORK_ORDER_SCOPE, WorkOrder } from './work-order.model';

type Doc = Record<string, any>;
const oid = (v: unknown) => new Types.ObjectId(String(v));
const DONE = WORK_ORDER_DONE_STATUSES as readonly string[];
const EDITABLE = WORK_ORDER_EDITABLE_STATUSES as readonly string[];
/** Co-assignees may still accept (acknowledge) once another engineer accepted or work has started. */
const ACKNOWLEDGE_IN = ['ACCEPTED', 'SCHEDULED', 'IN_PROGRESS', 'ON_HOLD', 'WORK_COMPLETED'];

export function isWorkOrderOverdue(w: Doc, now = new Date()) {
  return Boolean(w.dueAt && new Date(w.dueAt) < now && !DONE.includes(w.status));
}

// ---- Access -------------------------------------------------------------------------------------

export async function loadWorkOrderInScope(auth: AuthContext, id: string, session?: ClientSession) {
  const w = await WorkOrder.findById(id).session(session ?? null);
  if (!w || !inScope(auth, w.toObject(), WORK_ORDER_SCOPE)) throw notFound('Work order');
  return w;
}

/** Engineers are users holding workOrder.accept (default: Field Engineer / Technician role). */
async function engineerRoleIds() {
  return (await Role.find({ status: 'ACTIVE', permissions: 'workOrder.accept' }).select('_id').lean()).map((r) => r._id);
}

async function validateEngineers(ids: string[], session?: ClientSession) {
  const unique = [...new Set(ids)];
  const roleIds = await engineerRoleIds();
  const users = await User.find({ _id: { $in: unique }, status: 'ACTIVE', roleIds: { $in: roleIds } })
    .select('name email scope')
    .session(session ?? null)
    .lean<Doc[]>();
  if (users.length !== unique.length) {
    throw validationFailed({ assigneeIds: 'Select active field engineers/technicians only' });
  }
  return users;
}

async function validateSupervisor(id: string) {
  const p = await loadPrincipal(id);
  if (!p || p.user.status !== 'ACTIVE' || !p.permissions.has('workOrder.assign')) {
    throw validationFailed({ supervisorId: 'Select an active user who can assign work orders' });
  }
}

/** Keeps complaint.engineerIds in sync (personal access to the complaint for assigned engineers). */
async function syncComplaintEngineers(complaintId: unknown, session: ClientSession) {
  const wos = await WorkOrder.find({ complaintId, status: { $ne: 'CANCELLED' } }).select('assigneeIds').session(session).lean<Doc[]>();
  const ids = [...new Set(wos.flatMap((w) => (w.assigneeIds ?? []).map(String)))].map(oid);
  await Complaint.updateOne({ _id: complaintId }, { $set: { engineerIds: ids } }, { session });
}

function appLink(path: string) {
  return `${env().PUBLIC_APP_URL.replace(/\/$/, '')}${path}`;
}

async function notifyAssigned(w: Doc, engineers: Doc[], actorName: string) {
  if (!engineers.length) return;
  await notify({
    recipientIds: engineers.map((e) => e._id),
    type: 'workOrder.assigned',
    title: `Work order ${w.workOrderNo} assigned to you`,
    body: `${w.snapshot?.siteName ?? ''}: ${w.title}${w.plannedVisitAt ? ` — planned ${new Date(w.plannedVisitAt).toUTCString()}` : ''}`,
    link: `/work-orders/${w._id}`,
    entityType: 'workOrder',
    entityId: w._id,
    severity: 'info',
  });
  for (const e of engineers) {
    const mail = renderEmail({
      title: `Work order ${w.workOrderNo} assigned to you`,
      paragraphs: [
        `Hello ${e.name},`,
        `${actorName} has assigned you to work order ${w.workOrderNo} (complaint ${w.complaintRef}).`,
        `Site: ${w.snapshot?.siteName ?? ''}. Task: ${w.title}.`,
        w.plannedVisitAt ? `Planned visit: ${new Date(w.plannedVisitAt).toUTCString()}.` : 'The visit date has not been planned yet.',
        w.dueAt ? `Due: ${new Date(w.dueAt).toUTCString()}.` : '',
        w.shutdownRequired ? 'A shutdown is required — check the work order for details.' : '',
      ].filter(Boolean),
      action: { label: 'Open work order', url: appLink(`/work-orders/${w._id}`) },
    });
    await sendMail({ to: e.email, subject: `Assigned: ${w.workOrderNo} — ${w.title}`, ...mail });
  }
}

// ---- Create ---------------------------------------------------------------------------------------

const CREATE_FROM = ['UNDER_REVIEW', 'REOPENED', 'ASSIGNED', 'IN_PROGRESS'];

export async function createWorkOrder(ctx: RequestContext, complaintId: string, input: WorkOrderCreateInput) {
  const auth = ctx.auth!;
  const engineers = input.assigneeIds.length ? await validateEngineers(input.assigneeIds) : [];
  if (input.supervisorId && input.supervisorId !== auth.userId) await validateSupervisor(input.supervisorId);
  if (input.assigneeIds.length && !auth.permissions.has('workOrder.assign')) throw forbidden('You cannot assign engineers.');

  const created = await withTransaction(async (session, afterCommit) => {
    const c = await loadComplaintInScope(auth, complaintId, session);
    // BR-002: classification before assignment / work orders (checked first — the most useful message).
    if (!c.classifiedAt || !c.priorityId) throw conflict('Classify the complaint (request type and priority) before creating a work order.', 'NOT_CLASSIFIED');
    if (!CREATE_FROM.includes(c.status)) {
      throw conflict('Work orders can be created once the complaint is under review (and before it is resolved).', 'INVALID_STATE');
    }
    // BR-004 / D-03: multiple work orders per complaint only when configured.
    const wf = await getSettingsGroup('workflow');
    if (!wf.allowMultipleWorkOrdersPerComplaint) {
      const existing = await WorkOrder.countDocuments({ complaintId: c._id, status: { $ne: 'CANCELLED' } }).session(session);
      if (existing) throw conflict('This complaint already has a work order (multiple work orders are disabled in configuration).', 'SINGLE_WORK_ORDER');
    }
    if (input.priorityId) {
      const p = await Priority.findById(input.priorityId).session(session).lean<Doc>();
      if (!p || p.status !== 'ACTIVE') throw validationFailed({ priorityId: 'Select an active priority' });
    }

    const now = new Date();
    const workOrderNo = await nextReference('workOrder', session, now);
    const [w] = await WorkOrder.create(
      [
        {
          workOrderNo,
          complaintId: c._id,
          complaintRef: c.referenceNo,
          organizationId: c.organizationId,
          regionId: c.regionId,
          cityId: c.cityId,
          siteId: c.siteId,
          assetId: c.assetId,
          equipmentTypeId: c.equipmentTypeId,
          snapshot: {
            siteName: c.snapshot?.siteName,
            siteCode: c.snapshot?.siteCode,
            regionName: c.snapshot?.regionName,
            cityName: c.snapshot?.cityName,
            assetName: c.snapshot?.assetName,
          },
          title: input.title,
          description: input.description,
          workScope: input.workScope,
          priorityId: input.priorityId ?? c.priorityId,
          supervisorId: input.supervisorId ?? auth.userId,
          plannedVisitAt: input.plannedVisitAt ?? undefined,
          plannedEndAt: input.plannedEndAt ?? undefined,
          // Default due date: the complaint's SLA due date.
          dueAt: input.dueAt ?? c.dueAt ?? undefined,
          shutdownRequired: input.shutdownRequired,
          shutdownDetails: input.shutdownDetails,
          materialRequired: input.materialRequired,
          materialNotes: input.materialNotes,
          status: 'DRAFT',
          statusHistory: [{ to: 'DRAFT', action: 'create', by: auth.userId, byName: auth.name, at: now }],
          createdBy: auth.userId,
        },
      ],
      { session },
    );
    await audit(
      ctx,
      { action: AUDIT_ACTIONS.CREATE, entityType: 'workOrder', entityId: w._id, entityRef: workOrderNo, after: { complaint: c.referenceNo, title: input.title } },
      session,
    );
    await audit(ctx, { action: 'complaint.workOrderCreated', entityType: 'complaint', entityId: c._id, entityRef: c.referenceNo, after: { workOrderNo } }, session);

    if (engineers.length) {
      await applyAssignment(ctx, w, { assigneeIds: input.assigneeIds, leadEngineerId: input.leadEngineerId }, engineers, session);
      afterCommit(() => notifyAssigned(w.toObject(), engineers, auth.name));
    }
    return w;
  });
  return getWorkOrder(auth, String(created._id));
}

// ---- Assignment -----------------------------------------------------------------------------------

/**
 * Applies an assignment inside the caller's transaction: records history, transitions the work
 * order (DRAFT→ASSIGNED, or ACCEPTED/SCHEDULED→ASSIGNED when engineers change) and moves the
 * complaint to Assigned the first time (system transition guarded by BR-002).
 */
async function applyAssignment(
  ctx: RequestContext,
  w: Doc,
  input: { assigneeIds: string[]; leadEngineerId?: string; reason?: string },
  engineers: Doc[],
  session: ClientSession,
) {
  const auth = ctx.auth!;
  const before: string[] = (w.assigneeIds ?? []).map(String);
  const after = [...new Set(input.assigneeIds)];
  const added = after.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !after.includes(x));
  const now = new Date();

  w.assigneeIds = after.map(oid);
  w.leadEngineerId = oid(input.leadEngineerId ?? after[0]);
  // Acceptances by engineers who remain assigned are kept.
  w.acceptedBy = (w.acceptedBy ?? []).filter((a: Doc) => after.includes(String(a.userId)));
  w.assignmentHistory.push({
    at: now,
    by: auth.userId,
    byName: auth.name,
    added: added.map(oid),
    removed: removed.map(oid),
    assigneeIdsAfter: after.map(oid),
    leadEngineerId: w.leadEngineerId,
    reason: input.reason,
  });

  if (w.status === 'DRAFT') {
    await wfTransition({ entity: 'workOrder', record: w as never, action: 'assign', ctx, session, entityRef: w.workOrderNo });
    w.assignedAt = now;
  } else if ((w.status === 'ACCEPTED' || w.status === 'SCHEDULED') && (added.length || removed.length)) {
    await wfTransition({ entity: 'workOrder', record: w as never, action: 'reassign', ctx, session, system: true, reason: input.reason, entityRef: w.workOrderNo });
    w.acceptedBy = [];
    w.acceptedAt = undefined;
  }
  await w.save({ session });

  const names = new Map(engineers.map((e) => [String(e._id), e.name]));
  await audit(
    ctx,
    {
      action: 'workOrder.assignment',
      entityType: 'workOrder',
      entityId: w._id,
      entityRef: w.workOrderNo,
      before: { assignees: before },
      after: { assignees: after.map((id) => names.get(id) ?? id), lead: names.get(String(w.leadEngineerId)) },
      reason: input.reason,
    },
    session,
  );

  // First assignment moves the complaint to Assigned (system transition; guards intake/classification).
  const c = await Complaint.findById(w.complaintId).session(session);
  if (c && (c.status === 'UNDER_REVIEW' || c.status === 'REOPENED')) {
    await wfTransition({ entity: 'complaint', record: c as never, action: 'assign', ctx, session, system: true, entityRef: c.referenceNo });
    await c.save({ session });
  }
  await syncComplaintEngineers(w.complaintId, session);

  if (removed.length) {
    await notify(
      { recipientIds: removed, type: 'workOrder.unassigned', title: `You were removed from ${w.workOrderNo}`, body: input.reason ?? '', link: `/work-orders`, entityType: 'workOrder', entityId: w._id, severity: 'warning' },
      session,
    );
  }
  return { added, removed };
}

export async function assignWorkOrder(
  ctx: RequestContext,
  id: string,
  input: { assigneeIds: string[]; leadEngineerId?: string; supervisorId?: string; plannedVisitAt?: Date | null; reason?: string },
) {
  const auth = ctx.auth!;
  const engineers = await validateEngineers(input.assigneeIds);
  if (input.supervisorId) await validateSupervisor(input.supervisorId);
  let addedEngineers: Doc[] = [];
  const saved = await withTransaction(async (session, afterCommit) => {
    const w = await loadWorkOrderInScope(auth, id, session);
    if (!EDITABLE.includes(w.status)) throw conflict('Engineers can no longer be changed for this work order.', 'INVALID_STATE');
    const changesAccepted = (w.status === 'ACCEPTED' || w.status === 'SCHEDULED') &&
      JSON.stringify([...w.assigneeIds.map(String)].sort()) !== JSON.stringify([...new Set(input.assigneeIds)].sort());
    if (changesAccepted && !input.reason) throw validationFailed({ reason: 'A reason is required to reassign accepted work' });
    if (input.supervisorId) w.supervisorId = oid(input.supervisorId) as never;
    if (input.plannedVisitAt !== undefined) w.plannedVisitAt = (input.plannedVisitAt ?? undefined) as never;
    const { added } = await applyAssignment(ctx, w, input, engineers, session);
    addedEngineers = engineers.filter((e) => added.includes(String(e._id)));
    afterCommit(() => notifyAssigned(w.toObject(), addedEngineers, auth.name));
    return w;
  });
  return getWorkOrder(auth, String(saved._id));
}

// ---- Update & transitions ---------------------------------------------------------------------

export async function updateWorkOrder(ctx: RequestContext, id: string, input: Doc) {
  const auth = ctx.auth!;
  const saved = await withTransaction(async (session) => {
    const w = await loadWorkOrderInScope(auth, id, session);
    if (!EDITABLE.includes(w.status)) throw conflict('This work order can no longer be edited.', 'INVALID_STATE');
    const before = w.toObject();
    const { reason, ...fields } = input;
    const dueChanged = fields.dueAt !== undefined && String(fields.dueAt ?? '') !== String(w.dueAt ?? '') && w.dueAt;
    if (dueChanged && !reason) throw validationFailed({ reason: 'A reason is required to change the due date' });
    if (fields.priorityId) {
      const p = await Priority.findById(fields.priorityId).session(session).lean<Doc>();
      if (!p || p.status !== 'ACTIVE') throw validationFailed({ priorityId: 'Select an active priority' });
    }
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      (w as Doc)[k] = v === null ? undefined : v;
    }
    // Cross-field rules against the merged record.
    if (w.shutdownRequired && !w.shutdownDetails) throw validationFailed({ shutdownDetails: 'Describe the shutdown required' });
    if (w.materialRequired && !w.materialNotes) throw validationFailed({ materialNotes: 'Describe the materials required' });
    if (w.plannedVisitAt && w.plannedEndAt && w.plannedEndAt < w.plannedVisitAt) throw validationFailed({ plannedEndAt: 'Planned end must be after the planned start' });
    w.updatedBy = oid(auth.userId) as never;
    await w.save({ session });
    const d = diff(before, w.toObject());
    if (d.changed.length) {
      await audit(ctx, { action: AUDIT_ACTIONS.UPDATE, entityType: 'workOrder', entityId: w._id, entityRef: w.workOrderNo, before: d.before, after: d.after, reason }, session);
    }
    if (d.changed.some((k) => ['plannedVisitAt', 'dueAt', 'shutdownRequired'].includes(k)) && w.assigneeIds.length) {
      await notify(
        { recipientIds: w.assigneeIds, type: 'workOrder.updated', title: `${w.workOrderNo} was updated`, body: `Changed: ${d.changed.join(', ')}`, link: `/work-orders/${w._id}`, entityType: 'workOrder', entityId: w._id },
        session,
      );
    }
    return w;
  });
  return getWorkOrder(auth, String(saved._id));
}

export async function transitionWorkOrder(ctx: RequestContext, id: string, body: { action: string; reason?: string }) {
  const auth = ctx.auth!;
  const saved = await withTransaction(async (session) => {
    const w = await loadWorkOrderInScope(auth, id, session);
    const now = new Date();
    if (body.action === 'accept') {
      const isAssignee = w.assigneeIds.map(String).includes(auth.userId);
      const already = w.acceptedBy.some((a) => String(a.userId) === auth.userId);
      // Co-assignees acknowledging accepted or in-progress work: record acceptance without a status change.
      if (isAssignee && !already && ACKNOWLEDGE_IN.includes(w.status)) {
        if (!auth.permissions.has('workOrder.accept')) throw forbidden();
        w.acceptedBy.push({ userId: auth.userId, at: now } as never);
        await w.save({ session });
        await audit(ctx, { action: 'workOrder.acknowledged', entityType: 'workOrder', entityId: w._id, entityRef: w.workOrderNo }, session);
        return w;
      }
      if (already) throw conflict('You have already accepted this work order.', 'ALREADY_ACCEPTED');
    }
    await wfTransition({ entity: 'workOrder', record: w as never, action: body.action, ctx, reason: body.reason, session, entityRef: w.workOrderNo });
    if (body.action === 'accept') {
      w.acceptedBy.push({ userId: auth.userId, at: now } as never);
      w.acceptedAt = now;
      if (w.supervisorId) {
        await notify(
          { recipientIds: [w.supervisorId], type: 'workOrder.accepted', title: `${auth.name} accepted ${w.workOrderNo}`, link: `/work-orders/${w._id}`, entityType: 'workOrder', entityId: w._id, severity: 'success' },
          session,
        );
      }
    }
    if (body.action === 'cancel') {
      w.cancelledAt = now;
      if (w.assigneeIds.length) {
        await notify(
          { recipientIds: w.assigneeIds, type: 'workOrder.cancelled', title: `${w.workOrderNo} was cancelled`, body: body.reason ?? '', link: `/work-orders/${w._id}`, entityType: 'workOrder', entityId: w._id, severity: 'warning' },
          session,
        );
      }
    }
    w.updatedBy = oid(auth.userId) as never;
    await w.save({ session });
    if (body.action === 'cancel') await syncComplaintEngineers(w.complaintId, session);
    return w;
  });
  return getWorkOrder(auth, String(saved._id));
}

// ---- Read models -------------------------------------------------------------------------------

async function userMap(ids: unknown[]) {
  const users = await User.find({ _id: { $in: [...new Set(ids.filter(Boolean).map(String))] } }).select('name').lean<Doc[]>();
  return new Map(users.map((u) => [String(u._id), u.name as string]));
}

export async function toWorkOrderSummaries(rows: Doc[]): Promise<WorkOrderSummaryDto[]> {
  const def = await getDefinition('workOrder');
  const states = new Map(def.states.map((s) => [s.key, s]));
  const users = await userMap(rows.flatMap((r) => [...(r.assigneeIds ?? []), r.supervisorId]));
  const priorities = new Map(
    (await Priority.find({ _id: { $in: rows.map((r) => r.priorityId).filter(Boolean) } }).select('name code tone rank').lean<Doc[]>()).map((p) => [String(p._id), p]),
  );
  const now = new Date();
  return rows.map((w) => {
    const st = states.get(w.status);
    const pr = w.priorityId ? priorities.get(String(w.priorityId)) : undefined;
    const accepted = new Set((w.acceptedBy ?? []).map((a: Doc) => String(a.userId)));
    return {
      id: String(w._id),
      workOrderNo: w.workOrderNo,
      title: w.title,
      status: w.status,
      statusLabel: st?.label ?? w.status,
      statusTone: st?.tone ?? 'neutral',
      complaint: { id: String(w.complaintId), referenceNo: w.complaintRef },
      site: { id: String(w.siteId), name: w.snapshot?.siteName, code: w.snapshot?.siteCode },
      region: { id: String(w.regionId), name: w.snapshot?.regionName },
      priority: pr ? { id: String(pr._id), name: pr.name, code: pr.code, tone: pr.tone, rank: pr.rank } : undefined,
      supervisor: w.supervisorId ? { id: String(w.supervisorId), name: users.get(String(w.supervisorId)) ?? 'Unknown' } : null,
      assignees: (w.assigneeIds ?? []).map((a: unknown) => ({
        id: String(a),
        name: users.get(String(a)) ?? 'Unknown',
        accepted: accepted.has(String(a)),
        lead: String(a) === String(w.leadEngineerId),
      })),
      plannedVisitAt: w.plannedVisitAt ?? null,
      plannedEndAt: w.plannedEndAt ?? null,
      dueAt: w.dueAt ?? null,
      overdue: isWorkOrderOverdue(w, now),
      shutdownRequired: Boolean(w.shutdownRequired),
      materialRequired: Boolean(w.materialRequired),
      createdAt: w.createdAt,
    } as WorkOrderSummaryDto;
  });
}

export async function getWorkOrder(auth: AuthContext, id: string): Promise<WorkOrderDetailDto> {
  const w = (await loadWorkOrderInScope(auth, id)).toObject() as Doc;
  const [summary] = await toWorkOrderSummaries([w]);
  const def = await getDefinition('workOrder');
  const labels = new Map(def.states.map((s) => [s.key, s.label]));
  const users = await userMap(w.assignmentHistory.flatMap((h: Doc) => [...(h.added ?? []), ...(h.removed ?? []), h.leadEngineerId]));
  const [complaint, asset, eqType] = await Promise.all([
    Complaint.findById(w.complaintId).select('status customerName description').lean<Doc>(),
    w.assetId ? Asset.findById(w.assetId).select('name code').lean<Doc>() : null,
    w.equipmentTypeId ? EquipmentType.findById(w.equipmentTypeId).select('name code').lean<Doc>() : null,
  ]);
  const cDef = await getDefinition('complaint');
  const actions = await availableActions('workOrder', w as never, { auth });
  const isAssignee = (w.assigneeIds ?? []).map(String).includes(auth.userId);
  const accepted = (w.acceptedBy ?? []).some((a: Doc) => String(a.userId) === auth.userId);
  const lbl = (id: unknown) => ({ id: String(id), name: users.get(String(id)) ?? 'Unknown' });
  return {
    ...summary,
    description: w.description,
    workScope: w.workScope,
    shutdownDetails: w.shutdownDetails,
    materialNotes: w.materialNotes,
    asset: w.assetId ? { id: String(w.assetId), name: asset?.name ?? w.snapshot?.assetName ?? '', code: asset?.code } : null,
    equipmentType: eqType ? { id: String(eqType._id), name: eqType.name, code: eqType.code } : null,
    complaintDetail: {
      status: complaint?.status,
      statusLabel: cDef.states.find((s) => s.key === complaint?.status)?.label ?? complaint?.status,
      customerName: complaint?.customerName,
      description: complaint?.description,
    },
    assignmentHistory: w.assignmentHistory
      .map((h: Doc) => ({
        at: h.at,
        byName: h.byName,
        added: (h.added ?? []).map(lbl),
        removed: (h.removed ?? []).map(lbl),
        leadEngineer: h.leadEngineerId ? lbl(h.leadEngineerId) : null,
        reason: h.reason,
      }))
      .reverse(),
    statusHistory: (w.statusHistory ?? []).map((h: Doc) => ({ from: h.from, to: h.to, toLabel: labels.get(h.to) ?? h.to, action: h.action, byName: h.byName, at: h.at, reason: h.reason })),
    // Engineers only see "accept" when they are assigned; the engine adds the permission check.
    availableActions: actions.filter((a) => a.action !== 'accept' || (isAssignee && !accepted)),
    permissions: {
      canEdit: auth.permissions.has('workOrder.update') && EDITABLE.includes(w.status),
      canAssign: auth.permissions.has('workOrder.assign') && EDITABLE.includes(w.status),
      canAccept: auth.permissions.has('workOrder.accept') && isAssignee && !accepted && (w.status === 'ASSIGNED' || ACKNOWLEDGE_IN.includes(w.status)),
    },
    updatedAt: w.updatedAt,
  } as WorkOrderDetailDto;
}

export function buildWorkOrderFilter(auth: AuthContext, q: Partial<WorkOrderListQuery>) {
  const f: Doc = {};
  if (q.status) {
    f.status = q.status === 'ACTIVE' ? { $nin: WORK_ORDER_CLOSED_STATUSES } : { $in: q.status.split(',').map((s) => s.trim()) };
  }
  for (const k of ['supervisorId', 'complaintId', 'siteId', 'regionId', 'priorityId'] as const) if (q[k]) f[k] = oid(q[k]);
  if (q.assigneeId) f.assigneeIds = oid(q.assigneeId);
  if (q.mine === 'true') f.assigneeIds = oid(auth.userId);
  if (q.unassigned === 'true') f.assigneeIds = { $size: 0 };
  if (q.plannedFrom || q.plannedTo) f.plannedVisitAt = { ...(q.plannedFrom ? { $gte: q.plannedFrom } : {}), ...(q.plannedTo ? { $lte: q.plannedTo } : {}) };
  if (q.dueFrom || q.dueTo) f.dueAt = { ...(q.dueFrom ? { $gte: q.dueFrom } : {}), ...(q.dueTo ? { $lte: q.dueTo } : {}) };
  const and: Doc[] = [f];
  if (q.overdue === 'true') and.push({ dueAt: { $lt: new Date() }, status: { $nin: WORK_ORDER_DONE_STATUSES } });
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    and.push({ $or: [{ workOrderNo: rx }, { complaintRef: rx }, { title: rx }, { 'snapshot.siteName': rx }] });
  }
  return withScope(and.length === 1 ? f : { $and: and }, auth, WORK_ORDER_SCOPE);
}

export async function listWorkOrders(auth: AuthContext, q: WorkOrderListQuery) {
  const filter = buildWorkOrderFilter(auth, q);
  const sort = parseSort(q.sort, ['createdAt', 'workOrderNo', 'plannedVisitAt', 'dueAt', 'status'], { createdAt: -1 });
  const [rows, total] = await Promise.all([
    WorkOrder.find(filter).sort(sort).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    WorkOrder.countDocuments(filter),
  ]);
  return paged(await toWorkOrderSummaries(rows), total, q.page, q.limit);
}

/** Calendar feed for the assignment board (planned visits overlapping [from, to]). */
export async function calendar(auth: AuthContext, q: { from: Date; to: Date; assigneeId?: string; regionId?: string; includeUnplanned?: string }) {
  const base: Doc = { status: { $nin: WORK_ORDER_CLOSED_STATUSES } };
  if (q.assigneeId) base.assigneeIds = oid(q.assigneeId);
  if (q.regionId) base.regionId = oid(q.regionId);
  const planned = await WorkOrder.find(
    withScope(
      {
        ...base,
        plannedVisitAt: { $lt: q.to },
        $or: [{ plannedEndAt: { $gte: q.from } }, { plannedEndAt: null, plannedVisitAt: { $gte: q.from } }],
      },
      auth,
      WORK_ORDER_SCOPE,
    ),
  )
    .sort({ plannedVisitAt: 1 })
    .limit(1000)
    .lean();
  const unplanned = q.includeUnplanned === 'true'
    ? await WorkOrder.find(withScope({ ...base, plannedVisitAt: null }, auth, WORK_ORDER_SCOPE)).sort({ dueAt: 1 }).limit(200).lean()
    : [];
  const toItem = (s: WorkOrderSummaryDto): CalendarItemDto => ({
    id: s.id,
    workOrderNo: s.workOrderNo,
    title: s.title,
    start: (s.plannedVisitAt as string | null) ?? null,
    end: (s.plannedEndAt as string | null) ?? null,
    dueAt: s.dueAt,
    status: s.status,
    statusLabel: s.statusLabel,
    statusTone: s.statusTone,
    priorityTone: s.priority?.tone,
    siteName: s.site?.name,
    assignees: s.assignees.map((a) => ({ id: a.id, name: a.name })),
    overdue: s.overdue,
  });
  return {
    items: (await toWorkOrderSummaries(planned)).map(toItem),
    unplanned: (await toWorkOrderSummaries(unplanned)).map(toItem),
  };
}

/** Engineer workload (SUP-03): active, overdue, planned in range, due within 7 days. */
export async function workload(auth: AuthContext, q: { from?: Date; to?: Date; siteId?: string }): Promise<EngineerWorkloadDto[]> {
  const roleIds = await engineerRoleIds();
  const engineers = await User.find({ status: 'ACTIVE', roleIds: { $in: roleIds } }).select('name email scope').sort({ name: 1 }).lean<Doc[]>();
  const now = new Date();
  const from = q.from ?? new Date(now.getTime() - now.getUTCDay() * 86400_000);
  const to = q.to ?? new Date(from.getTime() + 7 * 86400_000);
  const ids = engineers.map((e) => e._id);
  const active = { assigneeIds: { $in: ids }, status: { $nin: WORK_ORDER_CLOSED_STATUSES } };
  const counts = await WorkOrder.aggregate<{ _id: unknown; active: number; overdue: number; planned: number; dueSoon: number }>([
    { $match: active },
    { $unwind: '$assigneeIds' },
    { $match: { assigneeIds: { $in: ids } } },
    {
      $group: {
        _id: '$assigneeIds',
        active: { $sum: 1 },
        overdue: { $sum: { $cond: [{ $and: [{ $lt: ['$dueAt', now] }, { $gt: ['$dueAt', null] }, { $not: [{ $in: ['$status', [...WORK_ORDER_DONE_STATUSES]] }] }] }, 1, 0] } },
        planned: { $sum: { $cond: [{ $and: [{ $gte: ['$plannedVisitAt', from] }, { $lt: ['$plannedVisitAt', to] }] }, 1, 0] } },
        dueSoon: { $sum: { $cond: [{ $and: [{ $gte: ['$dueAt', now] }, { $lt: ['$dueAt', new Date(now.getTime() + 7 * 86400_000)] }] }, 1, 0] } },
      },
    },
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c]));
  let site: Doc | null = null;
  if (q.siteId) site = await Site.findById(q.siteId).select('organizationId regionId').lean<Doc>();
  return engineers.map((e) => {
    const c = byId.get(String(e._id));
    const eligible = !site
      ? true
      : Boolean(
          e.scope?.global ||
            (e.scope?.organizationIds ?? []).map(String).includes(String(site.organizationId)) ||
            (e.scope?.regionIds ?? []).map(String).includes(String(site.regionId)) ||
            (e.scope?.siteIds ?? []).map(String).includes(String(site._id)),
        );
    return {
      id: String(e._id),
      name: e.name,
      email: e.email,
      eligible,
      activeWorkOrders: c?.active ?? 0,
      overdue: c?.overdue ?? 0,
      plannedInRange: c?.planned ?? 0,
      dueNext7Days: c?.dueSoon ?? 0,
    };
  });
}

export async function workOrderSummary(auth: AuthContext) {
  const scope = withScope({}, auth, WORK_ORDER_SCOPE);
  const now = new Date();
  const [byStatus, overdue, unassigned, byEngineer] = await Promise.all([
    WorkOrder.aggregate<{ _id: string; n: number }>([{ $match: scope }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    WorkOrder.countDocuments({ $and: [scope, { dueAt: { $lt: now }, status: { $nin: WORK_ORDER_DONE_STATUSES } }] }),
    WorkOrder.countDocuments({ $and: [scope, { status: 'DRAFT' }] }),
    WorkOrder.aggregate<{ _id: unknown; n: number }>([
      { $match: { $and: [scope, { status: { $nin: WORK_ORDER_CLOSED_STATUSES } }] } },
      { $unwind: '$assigneeIds' },
      { $group: { _id: '$assigneeIds', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 15 },
    ]),
  ]);
  const def = await getDefinition('workOrder');
  const status = Object.fromEntries(byStatus.map((s) => [s._id, s.n]));
  const total = byStatus.reduce((a, s) => a + s.n, 0);
  const closed = (WORK_ORDER_CLOSED_STATUSES as readonly string[]).reduce((a, k) => a + (status[k] ?? 0), 0);
  const names = await userMap(byEngineer.map((b) => b._id));
  return {
    total,
    open: total - closed,
    unassigned,
    awaitingAcceptance: status.ASSIGNED ?? 0,
    inProgress: status.IN_PROGRESS ?? 0,
    overdue,
    statuses: def.states.filter((s) => status[s.key]).map((s) => ({ key: s.key, label: s.label, tone: s.tone, count: status[s.key] })),
    byEngineer: byEngineer.map((b) => ({ engineer: names.get(String(b._id)) ?? 'Unknown', count: b.n })),
  };
}
