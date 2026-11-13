import { Types, type ClientSession } from 'mongoose';
import type {
  ReviewActionDto,
  ReviewActionInput,
  ReviewContextDto,
  ReviewQueueItemDto,
  RevisionComparisonDto,
  TimeLogFlag,
  TemplateItem,
} from '@mv/shared';
import type { AuthContext, RequestContext } from '../../common/context';
import { conflict, forbidden, notFound, validationFailed } from '../../common/errors';
import { paged } from '../../common/http/route';
import { audit } from '../../core/audit/audit.service';
import { notify } from '../../core/notifications/notification.service';
import { usersWithPermissionInScope } from '../../core/notifications/recipients';
import { withScope } from '../../core/scope/scope.service';
import { getSettingsGroup } from '../../core/settings/settings.service';
import { Attachment } from '../../core/storage/attachment.model';
import { getDefinition, registerGuard, transition as wfTransition } from '../../core/workflow/workflow.engine';
import { withTransaction } from '../../db/transaction';
import { Complaint } from '../complaints/complaint.model';
import { InspectionReport, REPORT_SCOPE } from '../inspections/inspection.models';
import { getReport, loadReportInScope } from '../inspections/inspection.service';
import { Priority } from '../masters/master.models';
import { TimeEvent } from '../visits/visit.models';
import { getVisit } from '../visits/visit.service';
import { WorkOrder } from '../work-orders/work-order.model';
import { ReviewAction } from './review.model';

type Doc = Record<string, any>;
const oid = (v: unknown) => new Types.ObjectId(String(v));
const PENDING = ['SUBMITTED', 'UNDER_REVIEW'];

// ---- Rules -------------------------------------------------------------------------------------------

/** BR-012: authors (submitter and the visit's engineers) cannot review their own report. */
export async function selfReviewReason(auth: AuthContext, report: Doc): Promise<string | null> {
  const wf = await getSettingsGroup('workflow');
  if (wf.allowSelfApproval) return null;
  const authors = new Set([...(report.assigneeIds ?? []).map(String), String(report.submittedBy ?? '')]);
  return authors.has(auth.userId) ? 'You cannot review a report you authored or worked on (segregation of duties).' : null;
}

async function approvalsFor(reportId: unknown, session?: ClientSession) {
  return ReviewAction.find({ reportId, action: 'approve' }).sort({ actionAt: 1 }).session(session ?? null).lean<Doc[]>();
}

export function registerReviewGuards() {
  registerGuard('notSelfApproval', async ({ record, ctx }) => (ctx.auth ? selfReviewReason(ctx.auth, record) : 'Not authenticated'));
  // D-17: the final approval is only allowed once all earlier levels are approved by other reviewers.
  registerGuard('approvalLevelsComplete', async ({ record, session }) => {
    const levels = (await getSettingsGroup('workflow')).inspectionApprovalLevels;
    const prior = (await approvalsFor(record._id, session)).length;
    return prior + 1 >= levels ? null : `This report needs ${levels} approval levels; ${prior} recorded so far.`;
  });
}

// ---- Queue ---------------------------------------------------------------------------------------------

export async function reviewQueue(auth: AuthContext, q: { page: number; limit: number; status: string; mineOnly?: string; q?: string }) {
  const f: Doc = {};
  if (q.status === 'PENDING') f.status = { $in: PENDING };
  else if (q.status !== 'ALL') f.status = q.status;
  if (q.q) {
    const rx = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    f.$or = [{ workOrderNo: rx }, { complaintRef: rx }, { visitNo: rx }, { siteName: rx }];
  }
  if (q.mineOnly === 'true') f._id = { $in: (await ReviewAction.distinct('reportId', { reviewerId: oid(auth.userId) })) };
  const scoped = withScope(f, auth, REPORT_SCOPE);
  const [rows, total, def, wf] = await Promise.all([
    InspectionReport.find(scoped).sort({ submittedAt: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean<Doc[]>(),
    InspectionReport.countDocuments(scoped),
    getDefinition('inspectionReport'),
    getSettingsGroup('workflow'),
  ]);
  const approvals = await ReviewAction.aggregate<{ _id: unknown; n: number }>([
    { $match: { reportId: { $in: rows.map((r) => r._id) }, action: 'approve' } },
    { $group: { _id: '$reportId', n: { $sum: 1 } } },
  ]);
  const byReport = new Map(approvals.map((a) => [String(a._id), a.n]));
  const wos = new Map((await WorkOrder.find({ _id: { $in: rows.map((r) => r.workOrderId) } }).select('title').lean<Doc[]>()).map((w) => [String(w._id), w.title]));
  const now = Date.now();
  const data: ReviewQueueItemDto[] = rows.map((r) => {
    const st = def.states.find((s) => s.key === r.status);
    const authors = new Set([...(r.assigneeIds ?? []).map(String), String(r.submittedBy ?? '')]);
    return {
      id: String(r._id),
      revisionNo: r.revisionNo,
      status: r.status,
      statusLabel: st?.label ?? r.status,
      statusTone: st?.tone ?? 'neutral',
      workOrder: { id: String(r.workOrderId), workOrderNo: r.workOrderNo, title: wos.get(String(r.workOrderId)) ?? '' },
      complaint: { id: String(r.complaintId), referenceNo: r.complaintRef },
      visit: { id: String(r.visitId), visitNo: r.visitNo },
      siteName: r.siteName,
      template: `${r.templateName} v${r.templateVersion}`,
      submittedAt: r.submittedAt ?? null,
      submittedByName: r.submittedByName,
      approvalsSoFar: byReport.get(String(r._id)) ?? 0,
      approvalLevels: wf.inspectionApprovalLevels,
      isOwn: !wf.allowSelfApproval && authors.has(auth.userId),
      summary: {
        fail: (r.results ?? []).filter((x: Doc) => x.result === 'FAIL').length,
        notChecked: (r.results ?? []).filter((x: Doc) => x.result === 'NOT_CHECKED').length,
      },
      waitingHours: r.submittedAt && PENDING.includes(r.status) ? Math.round((now - new Date(r.submittedAt).getTime()) / 3600_000) : null,
    };
  });
  return paged(data, total, q.page, q.limit);
}

/** Exact reviewer KPIs within scope (dashboard). */
export async function reviewSummary(auth: AuthContext) {
  const now = new Date();
  const weekStart = new Date(now.getTime() - 7 * 86400_000);
  const count = (f: Doc) => InspectionReport.countDocuments(withScope(f, auth, REPORT_SCOPE));
  const [pending, underReview, waitingOver24h, waitingOver48h, approvedThisWeek, approvedTotal] = await Promise.all([
    count({ status: { $in: PENDING } }),
    count({ status: 'UNDER_REVIEW' }),
    count({ status: { $in: PENDING }, submittedAt: { $lt: new Date(now.getTime() - 24 * 3600_000) } }),
    count({ status: { $in: PENDING }, submittedAt: { $lt: new Date(now.getTime() - 48 * 3600_000) } }),
    count({ status: 'APPROVED', approvedAt: { $gte: weekStart } }),
    count({ status: 'APPROVED' }),
  ]);
  return { pending, underReview, waitingOver24h, waitingOver48h, approvedThisWeek, approvedTotal };
}

// ---- Time-log flags (REV-05) -----------------------------------------------------------------------

export async function timeLogFlags(visitId: unknown, sequences: ReviewContextDto['sequences'], corrections: ReviewContextDto['corrections']): Promise<TimeLogFlag[]> {
  const wf = await getSettingsGroup('workflow');
  const flags: TimeLogFlag[] = [];
  const raw = await TimeEvent.find({ visitId }).lean<Doc[]>();
  for (const s of sequences) {
    const name = s.engineer.name;
    const have = new Set(s.events.map((e) => e.eventType));
    if (!s.events.length) {
      flags.push({ severity: 'warning', engineer: name, code: 'MISSING_EVENTS', message: `${name} recorded no time on this visit.` });
      continue;
    }
    const missingWork = ['ARRIVE_SITE', 'START_WORK', 'END_WORK'].filter((t) => !have.has(t as never));
    if (missingWork.length) flags.push({ severity: 'danger', engineer: name, code: 'MISSING_EVENTS', message: `${name} is missing ${missingWork.join(', ')}.` });
    else if (!s.complete) flags.push({ severity: 'warning', engineer: name, code: 'MISSING_EVENTS', message: `${name} has not recorded return travel / arrival at base yet.` });
    const d = s.durations;
    for (const [label, v] of [['Travel to site', d.travelToSite], ['Return travel', d.returnTravel]] as const) {
      if (v !== null && v > wf.timeFlagMaxTravelMinutes) flags.push({ severity: 'warning', engineer: name, code: 'LONG_TRAVEL', message: `${label} for ${name} was ${v} min (limit ${wf.timeFlagMaxTravelMinutes}).` });
    }
    if (d.onSiteWork !== null && d.onSiteWork > wf.timeFlagMaxWorkMinutes) flags.push({ severity: 'warning', engineer: name, code: 'LONG_WORK', message: `On-site work for ${name} was ${d.onSiteWork} min (limit ${wf.timeFlagMaxWorkMinutes}).` });
    if (d.onSiteWork !== null && d.onSiteWork < wf.timeFlagMinWorkMinutes) flags.push({ severity: 'warning', engineer: name, code: 'SHORT_WORK', message: `On-site work for ${name} was only ${d.onSiteWork} min.` });
    for (const e of raw.filter((x) => String(x.userId) === s.engineer.id && x.clientTimestamp)) {
      const skew = Math.abs(new Date(e.clientTimestamp).getTime() - new Date(e.serverTimestamp).getTime()) / 60000;
      if (skew > 10) {
        flags.push({ severity: 'warning', engineer: name, code: 'CLOCK_SKEW', message: `${name}'s device clock differed from server time by ${Math.round(skew)} min at ${e.eventType}.` });
        break;
      }
    }
    if (s.events.some((e) => e.corrected)) flags.push({ severity: 'warning', engineer: name, code: 'CORRECTED', message: `${name} has approved time corrections — review the original times.` });
  }
  const pending = corrections.filter((c) => c.status === 'PENDING');
  if (pending.length) flags.push({ severity: 'danger', code: 'PENDING_CORRECTION', message: `${pending.length} time correction(s) still awaiting a decision.` });
  return flags;
}

// ---- Context --------------------------------------------------------------------------------------------

function actionDto(a: Doc): ReviewActionDto {
  return {
    id: String(a._id),
    revisionNo: a.revisionNo,
    action: a.action,
    level: a.level,
    reviewerName: a.reviewerName,
    comments: a.comments,
    itemFeedback: (a.itemFeedback ?? []).map((f: Doc) => ({ itemKey: f.itemKey, comment: f.comment })),
    actionAt: a.actionAt,
  };
}

export async function reviewContext(auth: AuthContext, reportId: string): Promise<ReviewContextDto> {
  const report = await getReport(auth, reportId);
  const raw = (await InspectionReport.findById(reportId).lean<Doc>())!;
  const visit = await getVisit(auth, String(raw.visitId)).catch(() => null);
  if (!visit) throw notFound('Visit');
  const [wo, complaint, revisions, history, approvals, woDef, cDef, rDef, wf] = await Promise.all([
    WorkOrder.findById(raw.workOrderId).lean<Doc>(),
    Complaint.findById(raw.complaintId).lean<Doc>(),
    InspectionReport.find({ visitId: raw.visitId }).sort({ revisionNo: 1 }).select('revisionNo status submittedAt').lean<Doc[]>(),
    ReviewAction.find({ visitId: raw.visitId }).sort({ actionAt: 1 }).lean<Doc[]>(),
    approvalsFor(raw._id),
    getDefinition('workOrder'),
    getDefinition('complaint'),
    getDefinition('inspectionReport'),
    getSettingsGroup('workflow'),
  ]);
  const priority = complaint?.priorityId ? await Priority.findById(complaint.priorityId).select('name').lean<Doc>() : null;
  const label = (def: typeof woDef, key: string) => def.states.find((s) => s.key === key)?.label ?? key;
  const selfReason = await selfReviewReason(auth, raw);
  const pending = PENDING.includes(raw.status);
  const alreadyApproved = approvals.some((a) => String(a.reviewerId) === auth.userId);
  const can = auth.permissions;
  let reasonIfNot: string | undefined;
  if (!pending) reasonIfNot = `This revision is ${label(rDef, raw.status).toLowerCase()} and cannot be reviewed.`;
  else if (selfReason) reasonIfNot = selfReason;
  else if (alreadyApproved) reasonIfNot = 'You have already approved this revision; another reviewer must approve the next level.';
  const feedbackSource = raw.previousRevisionId
    ? history.find((h) => h.action === 'return' && String(h.reportId) === String(raw.previousRevisionId))
    : null;
  return {
    report,
    complaint: {
      id: String(complaint?._id),
      referenceNo: complaint?.referenceNo,
      status: complaint?.status,
      statusLabel: label(cDef, complaint?.status),
      customerName: complaint?.customerName,
      description: complaint?.description,
      priority: priority?.name,
    },
    workOrder: {
      id: String(wo?._id),
      workOrderNo: wo?.workOrderNo,
      title: wo?.title,
      status: wo?.status,
      statusLabel: label(woDef, wo?.status),
      description: wo?.description,
      shutdownRequired: Boolean(wo?.shutdownRequired),
      materialRequired: Boolean(wo?.materialRequired),
    },
    visit: { id: visit.id, visitNo: visit.visitNo, status: visit.status, statusLabel: visit.statusLabel, purpose: visit.purpose, timezone: visit.timezone },
    sequences: visit.sequences,
    corrections: visit.corrections,
    timeFlags: await timeLogFlags(raw.visitId, visit.sequences, visit.corrections),
    revisions: revisions.map((r) => ({ id: String(r._id), revisionNo: r.revisionNo, status: r.status, statusLabel: label(rDef, r.status), submittedAt: r.submittedAt ?? null })),
    reviewHistory: history.map(actionDto),
    feedbackFromPreviousReview: feedbackSource ? actionDto(feedbackSource) : null,
    ncrs: [], // Phase 8
    approval: { levels: wf.inspectionApprovalLevels, approvalsSoFar: approvals.length, approvedBy: approvals.map((a) => a.reviewerName) },
    permissions: {
      canStartReview: raw.status === 'SUBMITTED' && can.has('inspection.approve') && !selfReason,
      canApprove: pending && can.has('inspection.approve') && !selfReason && !alreadyApproved,
      canReturn: pending && can.has('inspection.return') && !selfReason,
      reasonIfNot,
    },
  };
}

// ---- Actions -------------------------------------------------------------------------------------------

export async function performReviewAction(ctx: RequestContext, reportId: string, input: ReviewActionInput) {
  const auth = ctx.auth!;
  const result = await withTransaction(async (session) => {
    const r = await loadReportInScope(auth, reportId, session);
    if (!PENDING.includes(r.status)) throw conflict('Only submitted reports can be reviewed.', 'INVALID_STATE');
    const self = await selfReviewReason(auth, r.toObject());
    if (self) throw forbidden(self, 'SELF_APPROVAL');
    const keys = new Set(r.templateItems.map((i) => i.key));
    const badKey = input.itemFeedback.find((f) => !keys.has(f.itemKey));
    if (badKey) throw validationFailed({ itemFeedback: `Unknown checklist item "${badKey.itemKey}"` });
    const now = new Date();
    const ref = `${r.visitNo} r${r.revisionNo}`;
    const base = {
      reportId: r._id,
      revisionNo: r.revisionNo,
      visitId: r.visitId,
      workOrderId: r.workOrderId,
      reviewerId: auth.userId,
      reviewerName: auth.name,
      reviewerRoles: auth.roles.map((x) => x.key ?? x.name),
      actionAt: now,
      organizationId: r.organizationId,
      regionId: r.regionId,
      siteId: r.siteId,
    };

    if (input.action === 'startReview') {
      await wfTransition({ entity: 'inspectionReport', record: r as never, action: 'startReview', ctx, session, entityRef: ref });
      await r.save({ session });
      await ReviewAction.create([{ ...base, action: 'startReview', comments: input.comments }], { session });
      return { report: r, outcome: 'started' as const };
    }

    if (input.action === 'return') {
      if (r.status === 'SUBMITTED') {
        await wfTransition({ entity: 'inspectionReport', record: r as never, action: 'startReview', ctx, session, entityRef: ref });
      }
      await wfTransition({ entity: 'inspectionReport', record: r as never, action: 'return', ctx, reason: input.comments, session, entityRef: ref });
      r.returnedAt = now;
      await ReviewAction.create([{ ...base, action: 'return', comments: input.comments, itemFeedback: input.itemFeedback }], { session });

      // New DRAFT revision carrying the previous answers and evidence (BR-009: the old one stays intact).
      const [next] = await InspectionReport.create(
        [
          {
            ...pick(r.toObject(), [
              'visitId', 'visitNo', 'workOrderId', 'workOrderNo', 'complaintId', 'complaintRef', 'organizationId', 'regionId', 'siteId', 'siteName',
              'assetId', 'equipmentTypeId', 'assigneeIds', 'templateId', 'templateName', 'templateVersion', 'templateItems', 'results', 'findings', 'recommendations',
            ]),
            revisionNo: r.revisionNo + 1,
            previousRevisionId: r._id,
            status: 'DRAFT',
            statusHistory: [{ to: 'DRAFT', action: 'revise', by: auth.userId, byName: auth.name, at: now, reason: `Returned for correction: ${input.comments}` }],
            createdBy: auth.userId,
            createdByName: `${auth.name} (returned for correction)`,
          },
        ],
        { session },
      );
      const evidence = await Attachment.find({ ownerType: 'inspectionReport', ownerId: r._id, removedAt: null }).select('+storageKey').session(session).lean<Doc[]>();
      if (evidence.length) {
        await Attachment.insertMany(
          evidence.map(({ _id, createdAt: _c, updatedAt: _u, ...a }) => ({ ...a, ownerId: next._id })),
          { session },
        );
      }
      await wfTransition({ entity: 'inspectionReport', record: r as never, action: 'supersede', ctx, session, system: true, entityRef: ref });
      r.supersededById = next._id as never;
      await r.save({ session });

      const w = await WorkOrder.findById(r.workOrderId).session(session);
      if (w && w.status === 'SUBMITTED') {
        await wfTransition({ entity: 'workOrder', record: w as never, action: 'returnForCorrection', ctx, session, system: true, entityRef: w.workOrderNo, reason: input.comments });
        await w.save({ session });
      }
      const c = await Complaint.findById(r.complaintId).session(session);
      if (c && c.status === 'SUBMITTED_FOR_REVIEW') {
        await wfTransition({ entity: 'complaint', record: c as never, action: 'returnForCorrection', ctx, session, system: true, entityRef: c.referenceNo, reason: input.comments });
        await c.save({ session });
      }
      await notify(
        {
          recipientIds: r.assigneeIds,
          type: 'inspectionReport.returned',
          title: `Report returned for correction: ${r.workOrderNo}`,
          body: input.comments!.slice(0, 200),
          link: `/inspection-reports/${next._id}`,
          entityType: 'inspectionReport',
          entityId: next._id,
          severity: 'warning',
        },
        session,
      );
      return { report: next, outcome: 'returned' as const };
    }

    // approve
    const wf = await getSettingsGroup('workflow');
    const approvals = await approvalsFor(r._id, session);
    if (approvals.some((a) => String(a.reviewerId) === auth.userId)) {
      throw conflict('You have already approved this revision; another reviewer must approve the next level.', 'ALREADY_APPROVED_BY_YOU');
    }
    if (r.status === 'SUBMITTED') {
      await wfTransition({ entity: 'inspectionReport', record: r as never, action: 'startReview', ctx, session, entityRef: ref });
    }
    const level = approvals.length + 1;
    if (level < wf.inspectionApprovalLevels) {
      // Intermediate level: record the approval, keep the report under review for the next reviewer.
      await r.save({ session });
      await ReviewAction.create([{ ...base, action: 'approve', level, comments: input.comments }], { session });
      await audit(ctx, { action: 'inspectionReport.levelApproved', entityType: 'inspectionReport', entityId: r._id, entityRef: ref, after: { level, of: wf.inspectionApprovalLevels }, reason: input.comments }, session);
      const nextReviewers = (await usersWithPermissionInScope('inspection.approve', r)).filter(
        (u) => String(u._id) !== auth.userId && !approvals.some((a) => String(a.reviewerId) === String(u._id)),
      );
      await notify(
        { recipientIds: nextReviewers.map((u) => u._id), type: 'inspectionReport.nextLevel', title: `Level ${level + 1} approval needed: ${r.workOrderNo}`, link: `/reviews/${r._id}`, entityType: 'inspectionReport', entityId: r._id },
        session,
      );
      return { report: r, outcome: 'levelApproved' as const };
    }
    await wfTransition({ entity: 'inspectionReport', record: r as never, action: 'approve', ctx, reason: input.comments, session, entityRef: ref });
    r.approvedAt = now;
    r.approvedBy = auth.userId as never;
    await r.save({ session });
    await ReviewAction.create([{ ...base, action: 'approve', level, comments: input.comments }], { session });

    // Work order → Approved when none of its reports is still open.
    const w = await WorkOrder.findById(r.workOrderId).session(session);
    if (w && w.status === 'SUBMITTED') {
      const open = await InspectionReport.countDocuments({ workOrderId: w._id, status: { $in: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW'] } }).session(session);
      if (!open) {
        await wfTransition({ entity: 'workOrder', record: w as never, action: 'approve', ctx, session, system: true, entityRef: w.workOrderNo });
        await w.save({ session });
      }
    }
    // Complaint → Approved when every active work order is approved.
    const c = await Complaint.findById(r.complaintId).session(session);
    if (c && c.status === 'SUBMITTED_FOR_REVIEW') {
      const notApproved = await WorkOrder.countDocuments({ complaintId: c._id, status: { $nin: ['APPROVED', 'CLOSED', 'CANCELLED'] } }).session(session);
      if (!notApproved) {
        await wfTransition({ entity: 'complaint', record: c as never, action: 'approve', ctx, session, system: true, entityRef: c.referenceNo });
        await c.save({ session });
      }
    }
    const recipients = [...r.assigneeIds, ...(w?.supervisorId ? [w.supervisorId] : [])];
    await notify(
      { recipientIds: recipients, type: 'inspectionReport.approved', title: `Report approved: ${r.workOrderNo}`, body: input.comments ?? '', link: `/inspection-reports/${r._id}`, entityType: 'inspectionReport', entityId: r._id, severity: 'success' },
      session,
    );
    return { report: r, outcome: 'approved' as const };
  });
  return { outcome: result.outcome, reportId: String(result.report._id), context: await reviewContext(auth, String(result.report._id)).catch(() => null) };
}

function pick(o: Doc, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}

// ---- Revisions -----------------------------------------------------------------------------------------

export async function listRevisions(auth: AuthContext, reportId: string) {
  const r = await loadReportInScope(auth, reportId);
  const def = await getDefinition('inspectionReport');
  const rows = await InspectionReport.find({ visitId: r.visitId }).sort({ revisionNo: 1 }).select('revisionNo status submittedAt submittedByName approvedAt').lean<Doc[]>();
  return rows.map((x) => ({
    id: String(x._id),
    revisionNo: x.revisionNo,
    status: x.status,
    statusLabel: def.states.find((s) => s.key === x.status)?.label ?? x.status,
    submittedAt: x.submittedAt ?? null,
    submittedByName: x.submittedByName,
    approvedAt: x.approvedAt ?? null,
  }));
}

/** REV-04: item-by-item comparison of two revisions of the same visit's report. */
export async function compareRevisions(auth: AuthContext, fromId: string, toId: string): Promise<RevisionComparisonDto> {
  const a = (await loadReportInScope(auth, fromId)).toObject() as Doc;
  const b = (await loadReportInScope(auth, toId)).toObject() as Doc;
  if (String(a.visitId) !== String(b.visitId)) throw validationFailed({ with: 'Both revisions must belong to the same report' });
  const [evA, evB, returned] = await Promise.all([
    Attachment.find({ ownerType: 'inspectionReport', ownerId: a._id, removedAt: null }).select('context sha256').lean<Doc[]>(),
    Attachment.find({ ownerType: 'inspectionReport', ownerId: b._id, removedAt: null }).select('context sha256').lean<Doc[]>(),
    ReviewAction.findOne({ reportId: a._id, action: 'return' }).lean<Doc>(),
  ]);
  const resA = new Map((a.results ?? []).map((x: Doc) => [x.itemKey, x]));
  const resB = new Map((b.results ?? []).map((x: Doc) => [x.itemKey, x]));
  const feedback = new Map(((returned?.itemFeedback ?? []) as Doc[]).map((f) => [f.itemKey, f.comment]));
  const side = (res: Doc | undefined, ev: Doc[], key: string) => ({
    result: res?.result ?? null,
    remarks: res?.remarks,
    reason: res?.reason,
    evidence: ev.filter((e) => e.context === key).length,
  });
  const items = (b.templateItems as TemplateItem[]).map((it) => {
    const from = side(resA.get(it.key) as Doc | undefined, evA, it.key);
    const to = side(resB.get(it.key) as Doc | undefined, evB, it.key);
    const shaA = evA.filter((e) => e.context === it.key).map((e) => e.sha256).sort().join();
    const shaB = evB.filter((e) => e.context === it.key).map((e) => e.sha256).sort().join();
    const changed = from.result !== to.result || (from.remarks ?? '') !== (to.remarks ?? '') || (from.reason ?? '') !== (to.reason ?? '') || shaA !== shaB;
    return { key: it.key, description: it.description, changed, from, to, feedback: feedback.get(it.key) };
  });
  return {
    from: { id: String(a._id), revisionNo: a.revisionNo, status: a.status },
    to: { id: String(b._id), revisionNo: b.revisionNo, status: b.status },
    items,
    findingsChanged: (a.findings ?? '') !== (b.findings ?? ''),
    recommendationsChanged: (a.recommendations ?? '') !== (b.recommendations ?? ''),
    from_findings: a.findings,
    to_findings: b.findings,
    from_recommendations: a.recommendations,
    to_recommendations: b.recommendations,
  };
}
