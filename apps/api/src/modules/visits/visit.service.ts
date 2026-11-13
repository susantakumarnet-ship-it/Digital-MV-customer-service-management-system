import { Types, type ClientSession } from 'mongoose';
import {
  AUDIT_ACTIONS,
  TIME_EVENT_TYPES,
  type EngineerSequenceDto,
  type GpsInput,
  type TimeCorrectionDto,
  type TimeDurations,
  type TimeEventDto,
  type TimeEventType,
  type VisitCreateInput,
  type VisitDetailDto,
  type VisitSummaryDto,
} from '@mv/shared';
import type { AuthContext, RequestContext } from '../../common/context';
import { AppError, conflict, forbidden, notFound, validationFailed } from '../../common/errors';
import { paged, parseSort } from '../../common/http/route';
import { audit } from '../../core/audit/audit.service';
import { nextReference } from '../../core/counters/counter.service';
import { notify } from '../../core/notifications/notification.service';
import { usersWithPermissionInScope } from '../../core/notifications/recipients';
import { inScope, withScope } from '../../core/scope/scope.service';
import { getSettingsGroup } from '../../core/settings/settings.service';
import { getDefinition, transition as wfTransition } from '../../core/workflow/workflow.engine';
import { withTransaction } from '../../db/transaction';
import { Complaint } from '../complaints/complaint.model';
import { User } from '../users/user.model';
import { WORK_ORDER_SCOPE, WorkOrder } from '../work-orders/work-order.model';
import { TimeCorrection, TimeEvent, VISIT_SCOPE, Visit } from './visit.models';
import { InspectionReport } from '../inspections/inspection.models';

type Doc = Record<string, any>;
const oid = (v: unknown) => new Types.ObjectId(String(v));
const ORDER = Object.fromEntries(TIME_EVENT_TYPES.map((t, i) => [t, i + 1])) as Record<TimeEventType, number>;
/** Visit status reached after each step (D-34). */
const STAGE_STATUS = ['PLANNED', 'TRAVEL_STARTED', 'ARRIVED', 'WORK_STARTED', 'WORK_ENDED', 'RETURN_TRAVEL', 'COMPLETED'];
const STAGE_ACTION = ['', 'startTravel', 'arriveSite', 'startWork', 'endWork', 'startReturn', 'arriveBase'];
const VISIT_FROM_WO = ['ACCEPTED', 'SCHEDULED', 'IN_PROGRESS', 'WORK_COMPLETED'];

// ---- Access ---------------------------------------------------------------------------------------

export async function loadVisitInScope(auth: AuthContext, id: string, session?: ClientSession) {
  const v = await Visit.findById(id).session(session ?? null);
  if (!v || !inScope(auth, v.toObject(), VISIT_SCOPE)) throw notFound('Visit');
  return v;
}

export async function canAccessVisit(auth: AuthContext, id: string) {
  if (!auth.permissions.has('visit.read')) return false;
  const v = await Visit.findById(id).select('organizationId regionId siteId engineerIds createdBy').lean();
  return Boolean(v && inScope(auth, v, VISIT_SCOPE));
}

// ---- Visits ---------------------------------------------------------------------------------------

export async function createVisit(ctx: RequestContext, workOrderId: string, input: VisitCreateInput) {
  const auth = ctx.auth!;
  const saved = await withTransaction(async (session) => {
    const w = await WorkOrder.findById(workOrderId).session(session);
    if (!w || !inScope(auth, w.toObject(), WORK_ORDER_SCOPE)) throw notFound('Work order');
    if (!VISIT_FROM_WO.includes(w.status)) {
      throw conflict('Visits can be created once the work order has been accepted (and until the report is submitted).', 'INVALID_STATE');
    }
    const assignees = w.assigneeIds.map(String);
    const isAssignee = assignees.includes(auth.userId);
    // BR-005: assigned engineers, or supervisors who can update field records.
    if (!isAssignee && !auth.permissions.has('workOrder.update')) throw forbidden('Only engineers assigned to this work order can create visits.');
    const engineerIds = [...new Set(input.engineerIds?.length ? input.engineerIds : [isAssignee ? auth.userId : String(w.leadEngineerId ?? assignees[0])])];
    const strangers = engineerIds.filter((e) => !assignees.includes(e));
    if (strangers.length) throw validationFailed({ engineerIds: 'Visit engineers must be assigned to the work order' });

    const visitNo = await nextReference('visit', session);
    const now = new Date();
    const [v] = await Visit.create(
      [
        {
          visitNo,
          workOrderId: w._id,
          workOrderNo: w.workOrderNo,
          complaintId: w.complaintId,
          complaintRef: w.complaintRef,
          organizationId: w.organizationId,
          regionId: w.regionId,
          siteId: w.siteId,
          siteName: w.snapshot?.siteName,
          engineerIds: engineerIds.map(oid),
          plannedAt: input.plannedAt ?? w.plannedVisitAt ?? undefined,
          purpose: input.purpose,
          attendees: input.attendees,
          notes: input.notes,
          status: 'PLANNED',
          statusHistory: [{ to: 'PLANNED', action: 'create', by: auth.userId, byName: auth.name, at: now }],
          createdBy: auth.userId,
        },
      ],
      { session },
    );
    await audit(ctx, { action: AUDIT_ACTIONS.CREATE, entityType: 'visit', entityId: v._id, entityRef: visitNo, after: { workOrder: w.workOrderNo, engineers: engineerIds.length } }, session);
    const others = engineerIds.filter((e) => e !== auth.userId);
    if (others.length) {
      await notify({ recipientIds: others, type: 'visit.created', title: `Visit ${visitNo} planned`, body: `${w.workOrderNo} — ${input.purpose}`, link: `/visits/${v._id}`, entityType: 'visit', entityId: v._id }, session);
    }
    return v;
  });
  return getVisit(auth, String(saved._id));
}

export async function updateVisit(ctx: RequestContext, id: string, input: Doc) {
  const auth = ctx.auth!;
  await withTransaction(async (session) => {
    const v = await loadVisitInScope(auth, id, session);
    if (['COMPLETED', 'CANCELLED'].includes(v.status)) throw conflict('This visit can no longer be edited.', 'INVALID_STATE');
    assertFieldActor(auth, v);
    const before = { plannedAt: v.plannedAt, purpose: v.purpose, attendees: v.attendees, notes: v.notes };
    for (const k of ['plannedAt', 'purpose', 'attendees', 'notes'] as const) if (input[k] !== undefined) (v as Doc)[k] = input[k] ?? undefined;
    await v.save({ session });
    await audit(ctx, { action: AUDIT_ACTIONS.UPDATE, entityType: 'visit', entityId: v._id, entityRef: v.visitNo, before, after: input }, session);
  });
  return getVisit(auth, id);
}

export async function cancelVisit(ctx: RequestContext, id: string, reason: string) {
  const auth = ctx.auth!;
  await withTransaction(async (session) => {
    const v = await loadVisitInScope(auth, id, session);
    assertFieldActor(auth, v);
    await wfTransition({ entity: 'visit', record: v as never, action: 'cancel', ctx, reason, session, entityRef: v.visitNo });
    v.cancelledAt = new Date();
    await v.save({ session });
  });
  return getVisit(auth, id);
}

/** BR-005: only the visit's engineers or authorised supervisors update field records. */
function assertFieldActor(auth: AuthContext, v: Doc) {
  const isEngineer = (v.engineerIds ?? []).map(String).includes(auth.userId);
  if (!isEngineer && !auth.permissions.has('workOrder.update')) throw forbidden('Only the engineers on this visit can update it.');
}

// ---- Time events ------------------------------------------------------------------------------------

function effective(e: Doc): Date {
  return e.correctedTimestamp ?? e.serverTimestamp;
}

export function computeDurations(events: Doc[]): TimeDurations {
  const at = (t: TimeEventType) => {
    const e = events.find((x) => x.eventType === t);
    return e ? new Date(effective(e)).getTime() : null;
  };
  const mins = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round((b - a) / 60000));
  return {
    travelToSite: mins(at('START_TRAVEL'), at('ARRIVE_SITE')),
    onSiteWaiting: mins(at('ARRIVE_SITE'), at('START_WORK')),
    onSiteWork: mins(at('START_WORK'), at('END_WORK')),
    returnTravel: mins(at('START_RETURN'), at('ARRIVE_BASE')),
    totalElapsed: mins(at('START_TRAVEL'), at('ARRIVE_BASE')),
  };
}

function nextEventFor(events: Doc[]): TimeEventType | null {
  const done = events.length;
  return done >= TIME_EVENT_TYPES.length ? null : TIME_EVENT_TYPES[done];
}

/**
 * Records the next time event for the signed-in engineer (TIME-01..05). The server sets the
 * timestamp. Duplicates and out-of-order events are rejected; the unique index makes concurrent
 * duplicates impossible.
 */
export async function recordTimeEvent(
  ctx: RequestContext,
  visitId: string,
  input: { eventType: TimeEventType; clientTimestamp?: Date; gps?: GpsInput; note?: string },
) {
  const auth = ctx.auth!;
  try {
    await withTransaction(async (session) => {
      const v = await loadVisitInScope(auth, visitId, session);
      if (!(v.engineerIds ?? []).map(String).includes(auth.userId)) throw forbidden('Only engineers taking part in this visit can record time.');
      if (v.status === 'CANCELLED') throw conflict('This visit was cancelled.', 'INVALID_STATE');
      const w = await WorkOrder.findById(v.workOrderId).session(session);
      if (!w) throw notFound('Work order');
      if (w.status === 'ON_HOLD') throw conflict('The work order is on hold.', 'WORK_ORDER_ON_HOLD');
      if (!w.acceptedBy.some((a) => String(a.userId) === auth.userId)) {
        throw conflict('Accept the work order before recording time.', 'NOT_ACCEPTED');
      }

      const mine = await TimeEvent.find({ visitId: v._id, userId: auth.userId }).sort({ sequence: 1 }).session(session).lean<Doc[]>();
      const expected = nextEventFor(mine);
      if (!expected) throw conflict('Your six time events for this visit are already complete.', 'SEQUENCE_COMPLETE');
      if (mine.some((e) => e.eventType === input.eventType)) throw conflict(`"${input.eventType}" has already been recorded for this visit.`, 'DUPLICATE_EVENT');
      if (input.eventType !== expected) {
        throw new AppError(409, 'OUT_OF_ORDER', `The next event must be "${expected}".`, undefined, { expected });
      }

      // TIME-04: one active sequence per engineer, unless concurrency is enabled.
      if (input.eventType === 'START_TRAVEL') {
        const wf = await getSettingsGroup('workflow');
        if (!wf.allowConcurrentTimeSequences) {
          const open = await TimeEvent.aggregate<{ _id: unknown; n: number; types: string[] }>([
            { $match: { userId: oid(auth.userId), visitId: { $ne: v._id } } },
            { $group: { _id: '$visitId', n: { $sum: 1 }, types: { $push: '$eventType' } } },
            { $match: { types: 'START_TRAVEL', n: { $lt: 6 } } },
          ]).session(session);
          if (open.length) {
            const other = await Visit.findById(open[0]._id).select('visitNo status').session(session).lean<Doc>();
            if (other && other.status !== 'CANCELLED') {
              throw conflict(`You still have an active time sequence on visit ${other.visitNo}. Arrive at base there first.`, 'ACTIVE_SEQUENCE_EXISTS');
            }
          }
        }
      }

      const now = new Date();
      await TimeEvent.create(
        [
          {
            visitId: v._id,
            workOrderId: v.workOrderId,
            userId: auth.userId,
            eventType: input.eventType,
            sequence: ORDER[input.eventType],
            serverTimestamp: now,
            clientTimestamp: input.clientTimestamp,
            gps: input.gps,
            note: input.note,
            recordedByName: auth.name,
            ip: ctx.ip,
          },
        ],
        { session },
      );
      await audit(
        ctx,
        {
          action: 'timeEvent.recorded',
          entityType: 'visit',
          entityId: v._id,
          entityRef: v.visitNo,
          after: { eventType: input.eventType, serverTimestamp: now.toISOString(), gps: Boolean(input.gps) },
          meta: input.clientTimestamp ? { clientSkewSeconds: Math.round((input.clientTimestamp.getTime() - now.getTime()) / 1000) } : undefined,
        },
        session,
      );

      // First START_TRAVEL on this work order → work order & complaint In Progress.
      if (input.eventType === 'START_TRAVEL') {
        if (!v.startedAt) v.startedAt = now;
        if (w.status === 'ACCEPTED' || w.status === 'SCHEDULED') {
          await wfTransition({ entity: 'workOrder', record: w as never, action: 'start', ctx, session, system: true, entityRef: w.workOrderNo });
          await w.save({ session });
        }
        const c = await Complaint.findById(w.complaintId).session(session);
        if (c && c.status === 'ASSIGNED') {
          await wfTransition({ entity: 'complaint', record: c as never, action: 'startWork', ctx, session, system: true, entityRef: c.referenceNo });
          await c.save({ session });
        }
      }
      await advanceVisitStatus(ctx, v, session);
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('This time event has already been recorded.', 'DUPLICATE_EVENT');
    throw err;
  }
  return getVisit(auth, visitId);
}

/** D-34: visit status = furthest step reached by any engineer; Completed when all who started are back. */
async function advanceVisitStatus(ctx: RequestContext, v: Doc, session: ClientSession) {
  const events = await TimeEvent.find({ visitId: v._id }).session(session).lean<Doc[]>();
  const byUser = new Map<string, number>();
  for (const e of events) byUser.set(String(e.userId), Math.max(byUser.get(String(e.userId)) ?? 0, e.sequence));
  let target = Math.max(0, ...byUser.values());
  if (target === 6 && [...byUser.values()].some((n) => n < 6)) target = 5;
  let current = STAGE_STATUS.indexOf(v.status);
  while (current >= 0 && current < target) {
    current += 1;
    await wfTransition({ entity: 'visit', record: v as never, action: STAGE_ACTION[current], ctx, session, system: true, entityRef: v.visitNo });
  }
  if (v.status === 'COMPLETED' && !v.completedAt) v.completedAt = new Date();
  await v.save({ session });
}

// ---- Time corrections -------------------------------------------------------------------------------

export async function requestCorrection(ctx: RequestContext, visitId: string, input: { timeEventId: string; proposedTimestamp: Date; reason: string }) {
  const auth = ctx.auth!;
  await withTransaction(async (session) => {
    const v = await loadVisitInScope(auth, visitId, session);
    const e = await TimeEvent.findOne({ _id: input.timeEventId, visitId: v._id }).session(session);
    if (!e) throw notFound('Time event');
    // The engineer raises corrections for their own events (TIME-07).
    if (String(e.userId) !== auth.userId) throw forbidden('You can only request corrections for your own time events.');
    if (await TimeCorrection.exists({ timeEventId: e._id, status: 'PENDING' }).session(session)) {
      throw conflict('A correction for this event is already awaiting review.', 'CORRECTION_PENDING');
    }
    await assertFitsSequence(e, input.proposedTimestamp, session);
    const [c] = await TimeCorrection.create(
      [
        {
          timeEventId: e._id,
          visitId: v._id,
          workOrderId: v.workOrderId,
          engineerId: e.userId,
          eventType: e.eventType,
          originalTimestamp: effective(e.toObject()),
          proposedTimestamp: input.proposedTimestamp,
          reason: input.reason,
          requestedBy: auth.userId,
          requestedByName: auth.name,
          organizationId: v.organizationId,
          regionId: v.regionId,
          siteId: v.siteId,
        },
      ],
      { session },
    );
    await audit(
      ctx,
      {
        action: 'timeCorrection.requested',
        entityType: 'visit',
        entityId: v._id,
        entityRef: v.visitNo,
        before: { [e.eventType]: effective(e.toObject()) },
        after: { [e.eventType]: input.proposedTimestamp },
        reason: input.reason,
        meta: { correctionId: String(c._id) },
      },
      session,
    );
    const approvers = (await usersWithPermissionInScope('visit.approveCorrection', v)).filter((u) => String(u._id) !== auth.userId);
    await notify(
      { recipientIds: approvers.map((u) => u._id), type: 'timeCorrection.requested', title: `Time correction requested on ${v.visitNo}`, body: `${auth.name}: ${e.eventType} — ${input.reason}`, link: `/visits/${v._id}`, entityType: 'visit', entityId: v._id, severity: 'warning' },
      session,
    );
  });
  return getVisit(auth, visitId);
}

/** The corrected time must keep the six events in order and not be in the future. */
async function assertFitsSequence(e: Doc, proposed: Date, session: ClientSession) {
  if (proposed.getTime() > Date.now() + 60_000) throw validationFailed({ proposedTimestamp: 'The corrected time cannot be in the future' });
  const siblings = await TimeEvent.find({ visitId: e.visitId, userId: e.userId }).session(session).lean<Doc[]>();
  const prev = siblings.find((s) => s.sequence === e.sequence - 1);
  const next = siblings.find((s) => s.sequence === e.sequence + 1);
  if (prev && proposed <= new Date(effective(prev))) throw validationFailed({ proposedTimestamp: `Must be after ${prev.eventType} (${new Date(effective(prev)).toISOString()})` });
  if (next && proposed >= new Date(effective(next))) throw validationFailed({ proposedTimestamp: `Must be before ${next.eventType} (${new Date(effective(next)).toISOString()})` });
}

export async function decideCorrection(ctx: RequestContext, correctionId: string, input: { decision: 'APPROVE' | 'REJECT'; comment?: string }) {
  const auth = ctx.auth!;
  const result = await withTransaction(async (session) => {
    const c = await TimeCorrection.findById(correctionId).session(session);
    if (!c || !inScope(auth, c.toObject(), { organization: 'organizationId', region: 'regionId', site: 'siteId' })) throw notFound('Time correction');
    if (c.status !== 'PENDING') throw conflict('This correction has already been decided.', 'ALREADY_DECIDED');
    // D-35: segregation of duties.
    if (String(c.engineerId) === auth.userId || String(c.requestedBy) === auth.userId) {
      throw forbidden('You cannot decide a correction to your own time or one you requested.', 'SELF_APPROVAL');
    }
    const e = await TimeEvent.findById(c.timeEventId).session(session);
    if (!e) throw notFound('Time event');
    const now = new Date();
    if (input.decision === 'APPROVE') {
      await assertFitsSequence(e.toObject(), c.proposedTimestamp, session);
      e.correctedTimestamp = c.proposedTimestamp;
      e.correctionId = c._id as never;
      await e.save({ session });
    }
    c.status = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    c.reviewerId = auth.userId as never;
    c.reviewerName = auth.name;
    c.decidedAt = now;
    c.decisionComment = input.comment;
    await c.save({ session });
    const v = await Visit.findById(c.visitId).session(session).lean<Doc>();
    await audit(
      ctx,
      {
        action: input.decision === 'APPROVE' ? 'timeCorrection.approved' : 'timeCorrection.rejected',
        entityType: 'visit',
        entityId: c.visitId,
        entityRef: v?.visitNo,
        before: { [c.eventType]: c.originalTimestamp },
        after: input.decision === 'APPROVE' ? { [c.eventType]: c.proposedTimestamp } : undefined,
        reason: input.comment,
        meta: { correctionId: String(c._id) },
      },
      session,
    );
    await notify(
      {
        recipientIds: [c.requestedBy],
        type: input.decision === 'APPROVE' ? 'timeCorrection.approved' : 'timeCorrection.rejected',
        title: `Time correction ${input.decision === 'APPROVE' ? 'approved' : 'rejected'} (${v?.visitNo})`,
        body: input.comment ?? '',
        link: `/visits/${c.visitId}`,
        entityType: 'visit',
        entityId: c.visitId,
        severity: input.decision === 'APPROVE' ? 'success' : 'warning',
      },
      session,
    );
    return c;
  });
  return toCorrectionDtos([result.toObject()]).then((r) => r[0]);
}

export async function listCorrections(auth: AuthContext, q: { page: number; limit: number; status: string; visitId?: string; mine?: string }) {
  const f: Doc = {};
  if (q.status !== 'ALL') f.status = q.status;
  if (q.visitId) f.visitId = oid(q.visitId);
  if (q.mine === 'true') f.requestedBy = oid(auth.userId);
  const scoped = withScope(f, auth, { organization: 'organizationId', region: 'regionId', site: 'siteId', personal: ['requestedBy', 'engineerId'] });
  const [rows, total] = await Promise.all([
    TimeCorrection.find(scoped).sort({ createdAt: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean<Doc[]>(),
    TimeCorrection.countDocuments(scoped),
  ]);
  return paged(await toCorrectionDtos(rows), total, q.page, q.limit);
}

async function toCorrectionDtos(rows: Doc[]): Promise<TimeCorrectionDto[]> {
  const users = new Map(
    (await User.find({ _id: { $in: rows.map((r) => r.engineerId) } }).select('name').lean<Doc[]>()).map((u) => [String(u._id), u.name]),
  );
  return rows.map((c) => ({
    id: String(c._id),
    visitId: String(c.visitId),
    timeEventId: String(c.timeEventId),
    eventType: c.eventType,
    engineer: { id: String(c.engineerId), name: users.get(String(c.engineerId)) ?? 'Unknown' },
    originalTimestamp: c.originalTimestamp,
    proposedTimestamp: c.proposedTimestamp,
    reason: c.reason,
    status: c.status,
    requestedByName: c.requestedByName,
    requestedAt: c.createdAt,
    reviewerName: c.reviewerName,
    decidedAt: c.decidedAt,
    decisionComment: c.decisionComment,
  }));
}

// ---- Read models -----------------------------------------------------------------------------------

async function toSummaries(rows: Doc[]): Promise<VisitSummaryDto[]> {
  const def = await getDefinition('visit');
  const states = new Map(def.states.map((s) => [s.key, s]));
  const users = new Map(
    (await User.find({ _id: { $in: rows.flatMap((r) => r.engineerIds ?? []) } }).select('name').lean<Doc[]>()).map((u) => [String(u._id), u.name]),
  );
  const wos = new Map((await WorkOrder.find({ _id: { $in: rows.map((r) => r.workOrderId) } }).select('title').lean<Doc[]>()).map((w) => [String(w._id), w.title]));
  return rows.map((v) => ({
    id: String(v._id),
    visitNo: v.visitNo,
    status: v.status,
    statusLabel: states.get(v.status)?.label ?? v.status,
    statusTone: states.get(v.status)?.tone ?? 'neutral',
    workOrder: { id: String(v.workOrderId), workOrderNo: v.workOrderNo, title: wos.get(String(v.workOrderId)) ?? '' },
    complaint: { id: String(v.complaintId), referenceNo: v.complaintRef },
    site: { id: String(v.siteId), name: v.siteName },
    plannedAt: v.plannedAt ?? null,
    purpose: v.purpose,
    engineers: (v.engineerIds ?? []).map((e: unknown) => ({ id: String(e), name: users.get(String(e)) ?? 'Unknown' })),
    startedAt: v.startedAt ?? null,
    completedAt: v.completedAt ?? null,
  }));
}

export async function listVisits(auth: AuthContext, q: { page: number; limit: number; sort?: string; workOrderId?: string; engineerId?: string; mine?: string; status?: string; from?: Date; to?: Date }) {
  const f: Doc = {};
  if (q.workOrderId) f.workOrderId = oid(q.workOrderId);
  if (q.engineerId) f.engineerIds = oid(q.engineerId);
  if (q.mine === 'true') f.engineerIds = oid(auth.userId);
  if (q.status) f.status = { $in: q.status.split(',') };
  if (q.from || q.to) {
    // Visits without a planned time fall back to their creation time, so they still appear in date views.
    const range = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    f.$or = [{ plannedAt: range }, { plannedAt: null, createdAt: range }];
  }
  const scoped = withScope(f, auth, VISIT_SCOPE);
  const sort = parseSort(q.sort, ['plannedAt', 'createdAt', 'visitNo', 'status'], { createdAt: -1 });
  const [rows, total] = await Promise.all([
    Visit.find(scoped).sort(sort).skip((q.page - 1) * q.limit).limit(q.limit).lean<Doc[]>(),
    Visit.countDocuments(scoped),
  ]);
  return paged(await toSummaries(rows), total, q.page, q.limit);
}

export async function getVisit(auth: AuthContext, id: string): Promise<VisitDetailDto> {
  const v = (await loadVisitInScope(auth, id)).toObject() as Doc;
  const [summary] = await toSummaries([v]);
  const [events, corrections, reports, general] = await Promise.all([
    TimeEvent.find({ visitId: v._id }).sort({ sequence: 1 }).lean<Doc[]>(),
    TimeCorrection.find({ visitId: v._id }).sort({ createdAt: -1 }).lean<Doc[]>(),
    InspectionReport.find({ visitId: v._id }).sort({ revisionNo: 1 }).select('revisionNo status submittedAt').lean<Doc[]>(),
    getSettingsGroup('general'),
  ]);
  const reportDef = await getDefinition('inspectionReport');
  const pending = new Map(corrections.filter((c) => c.status === 'PENDING').map((c) => [String(c.timeEventId), c]));
  const toEvent = (e: Doc): TimeEventDto => ({
    id: String(e._id),
    eventType: e.eventType,
    sequence: e.sequence,
    serverTimestamp: e.serverTimestamp,
    effectiveTimestamp: effective(e) as unknown as string,
    corrected: Boolean(e.correctedTimestamp),
    clientTimestamp: e.clientTimestamp ?? null,
    gps: e.gps?.latitude !== undefined ? e.gps : null,
    note: e.note,
    pendingCorrection: pending.has(String(e._id)) ? { id: String(pending.get(String(e._id))!._id), proposedTimestamp: pending.get(String(e._id))!.proposedTimestamp } : null,
  });
  const sequences: EngineerSequenceDto[] = summary.engineers.map((eng) => {
    const mine = events.filter((e) => String(e.userId) === eng.id);
    return { engineer: eng, events: mine.map(toEvent), nextEvent: nextEventFor(mine), complete: mine.length === 6, durations: computeDurations(mine) };
  });
  const isEngineer = summary.engineers.some((e) => e.id === auth.userId);
  const p = auth.permissions;
  const open = !['COMPLETED', 'CANCELLED'].includes(v.status);
  return {
    ...summary,
    attendees: v.attendees,
    notes: v.notes,
    sequences,
    mySequence: sequences.find((s) => s.engineer.id === auth.userId) ?? null,
    corrections: await toCorrectionDtos(corrections),
    inspectionReports: reports.map((r) => ({
      id: String(r._id),
      revisionNo: r.revisionNo,
      status: r.status,
      statusLabel: reportDef.states.find((s) => s.key === r.status)?.label ?? r.status,
      submittedAt: r.submittedAt ?? null,
    })),
    permissions: {
      canRecordTime: isEngineer && p.has('visit.recordTime') && v.status !== 'CANCELLED',
      canRequestCorrection: isEngineer && p.has('visit.requestCorrection'),
      canApproveCorrections: p.has('visit.approveCorrection'),
      canEdit: open && (isEngineer || p.has('workOrder.update')) && p.has('visit.update'),
      canCancel: v.status === 'PLANNED' && (isEngineer || p.has('workOrder.update')) && p.has('visit.update'),
      canInspect: isEngineer && p.has('inspection.create') && v.status !== 'CANCELLED',
    },
    timezone: general.timezone,
    createdAt: v.createdAt,
  };
}
