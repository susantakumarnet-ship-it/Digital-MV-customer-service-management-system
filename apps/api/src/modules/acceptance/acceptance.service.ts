import { createHash, randomBytes } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import {
  NCR_OPEN_STATUSES,
  type AcceptanceDecisionInput,
  type AcceptanceRecordDto,
  type AcceptanceSummaryDto,
  type ClosureChecklistDto,
} from '@mv/shared';
import type { AuthContext, RequestContext } from '../../common/context';
import { AppError, conflict, forbidden, notFound, validationFailed } from '../../common/errors';
import { env } from '../../config/env';
import { audit } from '../../core/audit/audit.service';
import { notify } from '../../core/notifications/notification.service';
import { usersWithPermissionInScope } from '../../core/notifications/recipients';
import { getSettingsGroup } from '../../core/settings/settings.service';
import { getDefinition, registerGuard, transition as wfTransition } from '../../core/workflow/workflow.engine';
import { withTransaction } from '../../db/transaction';
import { Complaint } from '../complaints/complaint.model';
import { customerEmail, loadComplaintInScope, registerComplaintTransitionHook, transitionComplaint, type ComplaintTransitionHookArgs } from '../complaints/complaint.service';
import { InspectionReport } from '../inspections/inspection.models';
import { MaterialRequest } from '../materials/material.models';
import { Ncr } from '../ncr/ncr.model';
import { Role } from '../roles/role.model';
import { User } from '../users/user.model';
import { TimeCorrection, TimeEvent, Visit } from '../visits/visit.models';
import { computeDurations } from '../visits/visit.service';
import { WorkOrder } from '../work-orders/work-order.model';
import { AcceptanceToken, CustomerAcceptance } from './acceptance.models';

type Doc = Record<string, any>;
type ComplaintDocument = InstanceType<typeof Complaint>;

const OPEN_MATERIAL = ['SUBMITTED', 'CLARIFICATION_REQUIRED', 'APPROVED', 'PARTIALLY_ISSUED'];
const WO_DONE = ['APPROVED', 'CLOSED'];

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const linkFor = (token: string) => `${env().PUBLIC_APP_URL.replace(/\/$/, '')}/acceptance/${token}`;

// ---- Closure checklist (BRF §17, BR-016) ----------------------------------------------------------

export async function closureConditions(c: Doc, session?: ClientSession): Promise<ClosureChecklistDto['conditions']> {
  const s = session ?? null;
  const wos = await WorkOrder.find({ complaintId: c._id, status: { $ne: 'CANCELLED' } }).select('workOrderNo status').session(s).lean<Doc[]>();
  const woIds = wos.map((w) => w._id);
  const [openVisits, pendingCorrections, openMaterials, openNcrs] = await Promise.all([
    Visit.countDocuments({ complaintId: c._id, status: { $nin: ['COMPLETED', 'CANCELLED'] } }).session(s),
    TimeCorrection.countDocuments({ workOrderId: { $in: woIds }, status: 'PENDING' }).session(s),
    MaterialRequest.find({ complaintId: c._id, status: { $in: OPEN_MATERIAL } }).select('requestNo').session(s).lean<Doc[]>(),
    Ncr.find({ complaintId: c._id, status: { $in: NCR_OPEN_STATUSES } }).select('ncrNo').session(s).lean<Doc[]>(),
  ]);
  const notApproved = wos.filter((w) => !WO_DONE.includes(w.status));
  const acc = c.acceptance?.status;
  return [
    {
      key: 'workApproved',
      label: 'All work orders technically approved',
      met: wos.length > 0 && notApproved.length === 0,
      detail: !wos.length ? 'No work orders' : notApproved.length ? `Not approved: ${notApproved.map((w) => w.workOrderNo).join(', ')}` : undefined,
    },
    {
      key: 'timeLogsReviewed',
      label: 'Visits completed and time corrections decided',
      met: openVisits === 0 && pendingCorrections === 0,
      detail: [openVisits ? `${openVisits} visit(s) not completed` : '', pendingCorrections ? `${pendingCorrections} time correction(s) pending` : ''].filter(Boolean).join('; ') || undefined,
    },
    {
      key: 'materialsComplete',
      label: 'Material requests issued, returned or closed',
      met: openMaterials.length === 0,
      detail: openMaterials.length ? `Open: ${openMaterials.map((m) => m.requestNo).join(', ')}` : undefined,
    },
    {
      key: 'ncrsComplete',
      label: 'NCRs verified or closed',
      met: openNcrs.length === 0,
      detail: openNcrs.length ? `Open: ${openNcrs.map((n) => n.ncrNo).join(', ')}` : undefined,
    },
    {
      key: 'acceptanceRecorded',
      label: 'Customer acceptance recorded (or waived with reason)',
      met: acc === 'ACCEPTED' || acc === 'WAIVED',
      detail: acc === 'PENDING' ? 'Awaiting the customer' : acc === 'REJECTED' ? 'Customer requested further action' : !acc ? 'Not requested yet' : undefined,
    },
  ];
}

export async function closureChecklist(auth: AuthContext, id: string): Promise<ClosureChecklistDto> {
  const c = await loadComplaintInScope(auth, id);
  const conditions = await closureConditions(c.toObject());
  return { canClose: c.status === 'CUSTOMER_ACCEPTED' && conditions.every((x) => x.met), conditions };
}

export function registerAcceptanceGuards() {
  registerGuard('closureConditionsMet', async ({ record, session }) => {
    const unmet = (await closureConditions(record, session)).filter((x) => !x.met);
    return unmet.length ? `Closure conditions not met: ${unmet.map((u) => `${u.label}${u.detail ? ` (${u.detail})` : ''}`).join('; ')}.` : null;
  });
  // recordResolution (REOPENED → RESOLVED): the concern was addressed without new field work.
  registerGuard('resolutionAllowed', async ({ record, session }) => {
    const wos = await WorkOrder.find({ complaintId: record._id, status: { $ne: 'CANCELLED' } }).select('workOrderNo status').session(session ?? null).lean<Doc[]>();
    if (!wos.length) return 'There is no approved work to resolve against — start a review and create a work order instead.';
    const active = wos.filter((w) => !WO_DONE.includes(w.status));
    return active.length ? `Work orders still active: ${active.map((w) => w.workOrderNo).join(', ')}. They must be approved (or cancelled) first.` : null;
  });
}

// ---- Summary shown to the customer ---------------------------------------------------------------

export async function acceptanceSummary(c: Doc): Promise<AcceptanceSummaryDto> {
  const [def, wos, visits, reports] = await Promise.all([
    getDefinition('complaint'),
    WorkOrder.find({ complaintId: c._id, status: { $ne: 'CANCELLED' } }).sort({ createdAt: 1 }).select('workOrderNo title completedAt').lean<Doc[]>(),
    Visit.find({ complaintId: c._id, status: { $ne: 'CANCELLED' } }).select('_id').lean<Doc[]>(),
    InspectionReport.find({ complaintId: c._id, status: 'APPROVED' }).sort({ approvedAt: 1 }).select('workOrderNo templateName approvedAt results findings recommendations').lean<Doc[]>(),
  ]);
  const events = visits.length ? await TimeEvent.find({ visitId: { $in: visits.map((v) => v._id) } }).lean<Doc[]>() : [];
  const groups = new Map<string, Doc[]>();
  for (const e of events) {
    const k = `${e.visitId}:${e.userId}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  let onSite = 0;
  for (const g of groups.values()) {
    const d = computeDurations(g);
    onSite += (d.onSiteWaiting ?? 0) + (d.onSiteWork ?? 0);
  }
  const times = events.map((e) => new Date(e.correctedTimestamp ?? e.serverTimestamp).getTime()).sort((a, b) => a - b);
  const count = (r: Doc, v: string) => (r.results ?? []).filter((x: Doc) => x.result === v).length;
  return {
    complaint: {
      referenceNo: c.referenceNo,
      receivedAt: c.receivedAt,
      siteName: c.snapshot?.siteName,
      customerName: c.customerName,
      description: c.description,
      statusLabel: def.states.find((s) => s.key === c.status)?.label ?? c.status,
    },
    workOrders: wos.map((w) => ({ workOrderNo: w.workOrderNo, title: w.title, completedAt: w.completedAt ?? null })),
    serviceCompletion: {
      visits: visits.length,
      firstVisitAt: times.length ? new Date(times[0]).toISOString() : null,
      lastVisitAt: times.length ? new Date(times[times.length - 1]).toISOString() : null,
      onSiteMinutes: onSite,
    },
    approvedReports: reports.map((r) => ({
      workOrderNo: r.workOrderNo,
      template: r.templateName,
      approvedAt: r.approvedAt ?? null,
      summary: { pass: count(r, 'PASS'), fail: count(r, 'FAIL'), notChecked: count(r, 'NOT_CHECKED'), notApplicable: count(r, 'NOT_APPLICABLE') },
      findings: r.findings,
      recommendations: r.recommendations,
    })),
    documents: [],
  } as unknown as AcceptanceSummaryDto;
}

const toRecord = (r: Doc): AcceptanceRecordDto => ({
  id: String(r._id),
  decision: r.decision,
  method: r.method,
  decidedByName: r.decidedByName,
  comments: r.comments,
  rating: r.rating,
  feedback: r.feedback,
  decidedAt: r.decidedAt,
});

// ---- Tokens ----------------------------------------------------------------------------------------

async function supersedeTokens(complaintId: unknown, session: ClientSession) {
  await AcceptanceToken.updateMany({ complaintId, status: 'PENDING' }, { $set: { status: 'SUPERSEDED' } }, { session });
}

async function portalCustomers(organizationId: unknown) {
  const roles = await Role.find({ status: 'ACTIVE', permissions: 'acceptance.decide' }).select('_id').lean();
  if (!roles.length) return [];
  return User.find({ status: 'ACTIVE', organizationId, roleIds: { $in: roles.map((r) => r._id) } }).select('_id').lean();
}

async function issueToken(ctx: RequestContext, c: ComplaintDocument, session: ClientSession, afterCommit: (fn: () => unknown) => void, opts: { recipientEmail?: string; message?: string }) {
  await supersedeTokens(c._id, session);
  const wf = await getSettingsGroup('workflow');
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + wf.acceptanceTokenValidityDays * 86400_000);
  const recipientEmail = opts.recipientEmail ?? c.email;
  await AcceptanceToken.create([{ tokenHash: hashToken(token), complaintId: c._id, recipientEmail, expiresAt, requestedBy: ctx.auth?.userId, requestedByName: ctx.auth?.name }], { session });
  await audit(ctx, { action: 'acceptance.requested', entityType: 'complaint', entityId: c._id, entityRef: c.referenceNo, after: { recipientEmail, expiresAt } }, session);
  const customers = await portalCustomers(c.organizationId);
  await notify(
    { recipientIds: customers.map((u) => u._id), type: 'acceptance.requested', title: `Please confirm the service for ${c.referenceNo}`, body: 'Review the completed work and accept it or tell us what still needs doing.', link: `/complaints/${c._id}`, entityType: 'complaint', entityId: c._id, severity: 'warning' },
    session,
  );
  const snapshot = { ...c.toObject(), email: recipientEmail };
  afterCommit(() =>
    customerEmail(
      snapshot,
      `Please confirm the service for complaint ${c.referenceNo}`,
      [
        `The work on your complaint ${c.referenceNo} has been completed and approved by our quality team.`,
        ...(opts.message ? [opts.message] : []),
        'Please review the service summary and either accept it or tell us what still needs to be done. Opening the link does not count as acceptance.',
        `The link can be used once and expires on ${expiresAt.toUTCString()}.`,
      ],
      { label: 'Review and respond', url: linkFor(token) },
    ),
  );
  return token;
}

/** Re-sends a fresh link while acceptance is pending (e.g. the earlier link expired). */
export async function resendAcceptance(ctx: RequestContext, id: string, input: { recipientEmail?: string; message?: string }) {
  const auth = ctx.auth!;
  await withTransaction(async (session, afterCommit) => {
    const c = await loadComplaintInScope(auth, id, session);
    if (c.status !== 'CUSTOMER_ACCEPTANCE_PENDING') throw conflict('A new link can only be sent while customer acceptance is pending.', 'INVALID_STATE');
    await issueToken(ctx, c, session, afterCommit, input);
  });
  return acceptanceForComplaint(auth, id);
}

export async function requestAcceptance(ctx: RequestContext, id: string, input: { recipientEmail?: string; message?: string }) {
  await transitionComplaint(ctx, id, { action: 'requestAcceptance', extra: input });
  return acceptanceForComplaint(ctx.auth!, id);
}

// ---- Decision ---------------------------------------------------------------------------------------

async function recordDecision(
  ctx: RequestContext,
  c: ComplaintDocument,
  input: AcceptanceDecisionInput,
  who: { method: 'TOKEN' | 'PORTAL'; name: string; customerUserId?: string; tokenId?: unknown; recipientEmail?: string },
  session: ClientSession,
  afterCommit: (fn: () => unknown) => void,
) {
  if (c.status !== 'CUSTOMER_ACCEPTANCE_PENDING') throw conflict('This complaint is not awaiting customer acceptance.', 'NOT_PENDING');
  const accept = input.decision === 'ACCEPT';
  const via = who.method === 'TOKEN' ? 'secure link' : 'customer portal';
  await wfTransition({
    entity: 'complaint',
    record: c as never,
    action: accept ? 'customerAccept' : 'customerReject',
    ctx,
    session,
    system: true,
    entityRef: c.referenceNo,
    reason: accept ? `Accepted by ${who.name} via ${via}` : `${who.name} (via ${via}): ${input.comments}`,
  });
  const now = new Date();
  const [rec] = await CustomerAcceptance.create(
    [
      {
        complaintId: c._id,
        complaintRef: c.referenceNo,
        organizationId: c.organizationId,
        decision: input.decision,
        method: who.method,
        comments: input.comments,
        rating: input.rating,
        feedback: input.feedback,
        decidedByName: who.name,
        customerUserId: who.customerUserId,
        tokenId: who.tokenId,
        recipientEmail: who.recipientEmail,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        decidedAt: now,
      },
    ],
    { session },
  );
  c.acceptance = { status: accept ? 'ACCEPTED' : 'REJECTED', requestedAt: c.acceptance?.requestedAt, decidedAt: now, method: who.method, recordId: rec._id } as never;
  await supersedeTokens(c._id, session);
  await c.save({ session });
  await audit(
    ctx,
    { action: accept ? 'acceptance.accepted' : 'acceptance.rejected', entityType: 'complaint', entityId: c._id, entityRef: c.referenceNo, actorName: ctx.auth ? undefined : `${who.name} (customer link)`, after: { method: who.method, rating: input.rating }, reason: input.comments },
    session,
  );
  const staff = await usersWithPermissionInScope('complaint.close', c);
  await notify(
    {
      recipientIds: staff.map((u) => u._id),
      type: accept ? 'acceptance.accepted' : 'acceptance.rejected',
      title: accept ? `Customer accepted ${c.referenceNo}` : `Customer requested further action on ${c.referenceNo}`,
      body: accept ? `${who.name} accepted the service${input.rating ? ` (rating ${input.rating}/5)` : ''}. The complaint can now be closed.` : (input.comments ?? '').slice(0, 200),
      link: `/complaints/${c._id}`,
      entityType: 'complaint',
      entityId: c._id,
      severity: accept ? 'success' : 'danger',
    },
    session,
  );
  const snapshot = c.toObject();
  afterCommit(() =>
    customerEmail(
      snapshot,
      accept ? `Thank you — service accepted for ${c.referenceNo}` : `We have reopened complaint ${c.referenceNo}`,
      accept
        ? ['Thank you for confirming the service. We will now close your complaint and send you a final confirmation.']
        : ['Thank you for your feedback. Your complaint has been reopened and our team will contact you about the remaining work.', `Your comments: ${input.comments}`],
    ),
  );
}

async function findToken(token: string, session?: ClientSession) {
  if (!token || token.length < 20 || token.length > 100) throw notFound('Acceptance link');
  const t = await AcceptanceToken.findOne({ tokenHash: hashToken(token) }).session(session ?? null);
  if (!t) throw new AppError(404, 'LINK_INVALID', 'This acceptance link is not valid.');
  return t;
}

function assertUsable(t: Doc) {
  if (t.status === 'SUPERSEDED') throw new AppError(410, 'LINK_SUPERSEDED', 'This link has been replaced by a newer one. Please use the most recent email we sent you.');
  if (t.status === 'PENDING' && new Date(t.expiresAt) < new Date()) throw new AppError(410, 'LINK_EXPIRED', 'This link has expired. Please contact us and we will send a new one.');
}

/** GET by token: shows the summary. Never records acceptance (BR-015). */
export async function viewByToken(token: string) {
  const t = await findToken(token);
  assertUsable(t);
  const c = await Complaint.findById(t.complaintId).lean<Doc>();
  if (!c) throw notFound('Complaint');
  if (t.status === 'PENDING' && !t.viewedAt) await AcceptanceToken.updateOne({ _id: t._id }, { $set: { viewedAt: new Date() } });
  const summary = await acceptanceSummary(c);
  let decided: AcceptanceSummaryDto['decided'] = null;
  if (t.status === 'USED') {
    const r = await CustomerAcceptance.findOne({ tokenId: t._id }).lean<Doc>();
    decided = r ? { decision: r.decision, at: r.decidedAt } : null;
  }
  return { ...summary, expiresAt: t.expiresAt.toISOString(), decided };
}

export async function decideByToken(ctx: RequestContext, token: string, input: AcceptanceDecisionInput) {
  if (!input.signerName) throw validationFailed({ signerName: 'Enter your name' });
  await withTransaction(async (session, afterCommit) => {
    const t0 = await findToken(token, session);
    assertUsable(t0);
    if (t0.status === 'USED') throw conflict('A response has already been recorded with this link.', 'LINK_USED');
    // Single use: claim the token atomically.
    const t = await AcceptanceToken.findOneAndUpdate(
      { _id: t0._id, status: 'PENDING', expiresAt: { $gt: new Date() } },
      { $set: { status: 'USED', usedAt: new Date() } },
      { new: true, session },
    );
    if (!t) throw conflict('A response has already been recorded with this link.', 'LINK_USED');
    const c = await Complaint.findById(t.complaintId).session(session);
    if (!c) throw notFound('Complaint');
    await recordDecision(ctx, c, input, { method: 'TOKEN', name: input.signerName!, tokenId: t._id, recipientEmail: t.recipientEmail }, session, afterCommit);
  });
  return viewByToken(token).catch(() => ({ decided: { decision: input.decision, at: new Date().toISOString() } }));
}

/** Customer portal decision (D-12): bound to the customer's own organisation. */
export async function decideInPortal(ctx: RequestContext, id: string, input: AcceptanceDecisionInput) {
  const auth = ctx.auth!;
  await withTransaction(async (session, afterCommit) => {
    const c = await loadComplaintInScope(auth, id, session);
    if (!auth.organizationId || auth.organizationId !== String(c.organizationId)) {
      throw forbidden('Only a user of the customer organisation can accept or reject the service.', 'NOT_CUSTOMER');
    }
    await recordDecision(ctx, c, input, { method: 'PORTAL', name: input.signerName || auth.name, customerUserId: auth.userId }, session, afterCommit);
  });
  return acceptanceForComplaint(auth, id);
}

export async function acceptanceForComplaint(auth: AuthContext, id: string) {
  const c = (await loadComplaintInScope(auth, id)).toObject() as Doc;
  const [records, pending] = await Promise.all([
    CustomerAcceptance.find({ complaintId: c._id }).sort({ decidedAt: -1 }).lean<Doc[]>(),
    AcceptanceToken.findOne({ complaintId: c._id, status: 'PENDING' }).sort({ createdAt: -1 }).lean<Doc>(),
  ]);
  const isCustomer = Boolean(auth.organizationId && auth.organizationId === String(c.organizationId));
  const staff = auth.permissions.has('acceptance.read') || auth.permissions.has('acceptance.request');
  return {
    status: c.acceptance?.status ?? null,
    requestedAt: c.acceptance?.requestedAt ?? null,
    decidedAt: c.acceptance?.decidedAt ?? null,
    summary: await acceptanceSummary(c),
    records: records.map(toRecord),
    pendingLink:
      staff && pending
        ? { recipientEmail: pending.recipientEmail, expiresAt: pending.expiresAt, viewedAt: pending.viewedAt ?? null, expired: new Date(pending.expiresAt) < new Date() }
        : null,
    canDecide: isCustomer && auth.permissions.has('acceptance.decide') && c.status === 'CUSTOMER_ACCEPTANCE_PENDING',
    canRequest: auth.permissions.has('acceptance.request') && c.status === 'RESOLVED',
    canResend: auth.permissions.has('acceptance.request') && c.status === 'CUSTOMER_ACCEPTANCE_PENDING',
    canWaive: auth.permissions.has('complaint.waiveAcceptance') && ['RESOLVED', 'CUSTOMER_ACCEPTANCE_PENDING'].includes(c.status),
  };
}

// ---- Side effects of complaint transitions -------------------------------------------------------

async function onComplaintTransition({ ctx, complaint: c, action, body, session, afterCommit }: ComplaintTransitionHookArgs) {
  const now = new Date();
  const extra = (body.extra ?? {}) as { recipientEmail?: string; message?: string };
  switch (action) {
    case 'resolve':
    case 'recordResolution':
      c.resolvedAt = now;
      break;
    case 'requestAcceptance':
      c.acceptance = { status: 'PENDING', requestedAt: now } as never;
      await issueToken(ctx, c, session, afterCommit, extra);
      break;
    case 'waiveAcceptance': {
      await supersedeTokens(c._id, session);
      const [rec] = await CustomerAcceptance.create(
        [{ complaintId: c._id, complaintRef: c.referenceNo, organizationId: c.organizationId, decision: 'WAIVED', method: 'WAIVER', comments: body.reason, decidedByName: ctx.auth!.name, ip: ctx.ip, userAgent: ctx.userAgent, decidedAt: now }],
        { session },
      );
      c.acceptance = { status: 'WAIVED', requestedAt: c.acceptance?.requestedAt, decidedAt: now, method: 'WAIVER', recordId: rec._id } as never;
      await audit(ctx, { action: 'acceptance.waived', entityType: 'complaint', entityId: c._id, entityRef: c.referenceNo, reason: body.reason }, session);
      break;
    }
    case 'reopen':
      await supersedeTokens(c._id, session);
      c.acceptance = undefined as never;
      c.closedAt = undefined as never;
      break;
    case 'close': {
      c.closedAt = now;
      // Approved work orders close with their complaint.
      const wos = await WorkOrder.find({ complaintId: c._id, status: 'APPROVED' }).session(session);
      for (const w of wos) {
        await wfTransition({ entity: 'workOrder', record: w as never, action: 'close', ctx, session, system: true, entityRef: w.workOrderNo, reason: `Complaint ${c.referenceNo} closed` });
        await w.save({ session });
      }
      const snapshot = c.toObject();
      afterCommit(() =>
        customerEmail(snapshot, `Complaint ${c.referenceNo} closed`, [
          `Your complaint ${c.referenceNo} has now been closed.`,
          'Thank you for your patience. If the problem returns, please contact us quoting this reference.',
        ]),
      );
      break;
    }
  }
}

export function registerAcceptanceHooks() {
  registerComplaintTransitionHook('acceptance', onComplaintTransition);
}

