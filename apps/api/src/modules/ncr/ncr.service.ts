import { Types, type ClientSession } from 'mongoose';
import { AUDIT_ACTIONS, NCR_OPEN_STATUSES, type NcrCreateInput, type NcrDetailDto, type NcrSummaryDto, type TemplateItem } from '@mv/shared';
import type { AuthContext, RequestContext } from '../../common/context';
import { conflict, forbidden, notFound, validationFailed } from '../../common/errors';
import { paged, parseSort } from '../../common/http/route';
import { audit } from '../../core/audit/audit.service';
import { nextReference } from '../../core/counters/counter.service';
import { notify } from '../../core/notifications/notification.service';
import { usersWithPermissionInScope } from '../../core/notifications/recipients';
import { inScope, withScope } from '../../core/scope/scope.service';
import { getSettingsGroup } from '../../core/settings/settings.service';
import { Attachment, toAttachmentDto } from '../../core/storage/attachment.model';
import { storeFiles, validateFiles, type IncomingFile } from '../../core/storage/upload.service';
import { availableActions, getDefinition, registerGuard, transition as wfTransition } from '../../core/workflow/workflow.engine';
import { withTransaction } from '../../db/transaction';
import { loadPrincipal } from '../auth/principal.service';
import { loadComplaintInScope } from '../complaints/complaint.service';
import { InspectionReport } from '../inspections/inspection.models';
import { Asset } from '../masters/master.models';
import { Role } from '../roles/role.model';
import { User } from '../users/user.model';
import { WorkOrder } from '../work-orders/work-order.model';
import { NCR_SCOPE, Ncr } from './ncr.model';

type Doc = Record<string, any>;
const oid = (v: unknown) => new Types.ObjectId(String(v));
const OPEN = NCR_OPEN_STATUSES as readonly string[];
const ACTION_FIELDS = ['containmentAction', 'rootCause', 'correctiveAction', 'disposition'] as const;

export async function loadNcrInScope(auth: AuthContext, id: string, session?: ClientSession) {
  const n = await Ncr.findById(id).session(session ?? null);
  if (!n || !inScope(auth, n.toObject(), NCR_SCOPE)) throw notFound('NCR');
  return n;
}

export async function canAccessNcr(auth: AuthContext, id: string) {
  if (!auth.permissions.has('ncr.read')) return false;
  const n = await Ncr.findById(id).select('organizationId regionId siteId ownerId raisedBy').lean();
  return Boolean(n && inScope(auth, n, NCR_SCOPE));
}

export function registerNcrGuards() {
  registerGuard('ownerSet', ({ record }) => (record.ownerId ? null : 'Assign an owner first.'));
  registerGuard('actorIsOwner', ({ record, ctx }) => (String(record.ownerId) === ctx.auth?.userId ? null : 'Only the NCR owner can do this.'));
  registerGuard('ncrActionsRecorded', ({ record }) => {
    const missing = ACTION_FIELDS.filter((f) => !record[f]);
    return missing.length ? `Record the ${missing.map((m) => m.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ')} first.` : null;
  });
  // D-08: the verifier must not be the owner (segregation of duties).
  registerGuard('notSelfVerification', ({ record, ctx }) => (String(record.ownerId) === ctx.auth?.userId ? 'The NCR owner cannot verify their own corrective action.' : null));
  // BR-014: verification needs evidence.
  registerGuard('verificationEvidencePresent', async ({ record, session }) => {
    const n = await Attachment.countDocuments({ ownerType: 'ncr', ownerId: record._id, context: 'verification', removedAt: null }).session(session ?? null);
    return n ? null : 'Attach verification evidence (photo or document) before verifying.';
  });
  // Complaint resolve (BR-016): NCRs must be verified/closed.
  registerGuard('ncrObligationsComplete', async ({ record, session }) => {
    const open = await Ncr.find({ complaintId: record._id, status: { $in: OPEN } }).select('ncrNo').session(session ?? null).lean<Doc[]>();
    return open.length ? `NCRs still open: ${open.map((o) => o.ncrNo).join(', ')}.` : null;
  });
}

async function validateOwner(ownerId: string) {
  const p = await loadPrincipal(ownerId);
  if (!p || p.user.status !== 'ACTIVE' || !p.permissions.has('ncr.update')) {
    throw validationFailed({ ownerId: 'Select an active user who can work on NCRs' });
  }
  return p.user;
}

async function validateLists(category?: string, severity?: string) {
  const s = await getSettingsGroup('ncr');
  const fields: Record<string, string> = {};
  if (category !== undefined && !s.categories.includes(category)) fields.category = 'Select a configured category';
  if (severity !== undefined && !s.severities.includes(severity)) fields.severity = 'Select a configured severity';
  if (Object.keys(fields).length) throw validationFailed(fields);
}

// ---- Create ---------------------------------------------------------------------------------------

export async function createNcr(ctx: RequestContext, input: NcrCreateInput, files: IncomingFile[]) {
  const auth = ctx.auth!;
  await validateLists(input.category, input.severity);
  if (input.ownerId && !auth.permissions.has('ncr.assign')) throw forbidden('You cannot assign NCR owners.');
  const owner = input.ownerId ? await validateOwner(input.ownerId) : null;
  const validated = await validateFiles(files);
  const saved = await withTransaction(async (session) => {
    const c = await loadComplaintInScope(auth, input.complaintId, session);
    let wo: Doc | null = null;
    if (input.workOrderId) {
      wo = await WorkOrder.findOne({ _id: input.workOrderId, complaintId: c._id }).session(session).lean<Doc>();
      if (!wo) throw validationFailed({ workOrderId: 'Select a work order of this complaint' });
    }
    if (input.assetId) {
      const a = await Asset.findById(input.assetId).session(session).lean<Doc>();
      if (!a || String(a.siteId) !== String(c.siteId)) throw validationFailed({ assetId: 'Select an asset at the complaint site' });
    }
    if (input.inspectionReportId) {
      const r = await InspectionReport.findOne({ _id: input.inspectionReportId, complaintId: c._id }).session(session).lean<Doc>();
      if (!r) throw validationFailed({ inspectionReportId: 'Select an inspection report of this complaint' });
      if (input.itemKey && !(r.templateItems as TemplateItem[]).some((i) => i.key === input.itemKey)) throw validationFailed({ itemKey: 'Unknown checklist item' });
    }
    const settings = await getSettingsGroup('ncr');
    const now = new Date();
    const ncrNo = await nextReference('ncr', session);
    const [n] = await Ncr.create(
      [
        {
          ncrNo,
          complaintId: c._id,
          complaintRef: c.referenceNo,
          workOrderId: wo?._id,
          workOrderNo: wo?.workOrderNo,
          assetId: input.assetId ?? c.assetId,
          inspectionReportId: input.inspectionReportId,
          itemKey: input.itemKey,
          organizationId: c.organizationId,
          regionId: c.regionId,
          siteId: c.siteId,
          siteName: c.snapshot?.siteName,
          category: input.category,
          severity: input.severity,
          title: input.title,
          description: input.description,
          raisedBy: auth.userId,
          raisedByName: auth.name,
          dueAt: input.dueAt ?? new Date(now.getTime() + settings.defaultDueDays * 86400_000),
          status: 'OPEN',
          statusHistory: [{ to: 'OPEN', action: 'create', by: auth.userId, byName: auth.name, at: now }],
        },
      ],
      { session },
    );
    if (validated.length) await storeFiles(ctx, validated, { type: 'ncr', id: n._id, context: 'evidence' }, { type: 'USER' }, session);
    await audit(ctx, { action: AUDIT_ACTIONS.CREATE, entityType: 'ncr', entityId: n._id, entityRef: ncrNo, after: { complaint: c.referenceNo, category: input.category, severity: input.severity } }, session);
    if (owner) {
      n.ownerId = owner._id as never;
      await wfTransition({ entity: 'ncr', record: n as never, action: 'assign', ctx, session, entityRef: ncrNo });
      await n.save({ session });
      await notifyOwner(n.toObject(), session);
    } else {
      const assigners = (await usersWithPermissionInScope('ncr.assign', n)).filter((u) => String(u._id) !== auth.userId);
      await notify({ recipientIds: assigners.map((u) => u._id), type: 'ncr.raised', title: `NCR raised: ${ncrNo}`, body: `${input.severity} — ${input.title}`, link: `/ncrs/${n._id}`, entityType: 'ncr', entityId: n._id, severity: input.severity === 'Critical' ? 'danger' : 'warning' }, session);
    }
    return n;
  });
  return getNcr(auth, String(saved._id));
}

async function notifyOwner(n: Doc, session: ClientSession) {
  await notify(
    { recipientIds: [n.ownerId], type: 'ncr.assigned', title: `NCR assigned to you: ${n.ncrNo}`, body: `${n.severity} — ${n.title}${n.dueAt ? ` (due ${new Date(n.dueAt).toDateString()})` : ''}`, link: `/ncrs/${n._id}`, entityType: 'ncr', entityId: n._id, severity: 'warning' },
    session,
  );
}

// ---- Assign / actions / transitions ---------------------------------------------------------------

export async function assignNcr(ctx: RequestContext, id: string, input: { ownerId: string; dueAt?: Date; comment?: string }) {
  const auth = ctx.auth!;
  const owner = await validateOwner(input.ownerId);
  await withTransaction(async (session) => {
    const n = await loadNcrInScope(auth, id, session);
    if (!OPEN.includes(n.status)) throw conflict('Closed or verified NCRs cannot be reassigned.', 'INVALID_STATE');
    const before = { ownerId: n.ownerId ? String(n.ownerId) : null, dueAt: n.dueAt };
    n.ownerId = owner._id as never;
    if (input.dueAt) n.dueAt = input.dueAt;
    if (n.status === 'OPEN') await wfTransition({ entity: 'ncr', record: n as never, action: 'assign', ctx, session, entityRef: n.ncrNo, reason: input.comment });
    if (input.comment) n.comments.push({ text: input.comment, by: auth.userId, byName: auth.name, at: new Date() } as never);
    await n.save({ session });
    await audit(ctx, { action: 'ncr.ownerAssigned', entityType: 'ncr', entityId: n._id, entityRef: n.ncrNo, before, after: { ownerId: String(owner._id), owner: owner.name, dueAt: n.dueAt } }, session);
    await notifyOwner(n.toObject(), session);
  });
  return getNcr(auth, id);
}

export async function recordActions(ctx: RequestContext, id: string, input: Doc) {
  const auth = ctx.auth!;
  await withTransaction(async (session) => {
    const n = await loadNcrInScope(auth, id, session);
    if (String(n.ownerId) !== auth.userId) throw forbidden('Only the NCR owner can record actions.');
    if (!['ASSIGNED', 'ACTION_IN_PROGRESS', 'RETURNED'].includes(n.status)) throw conflict('Actions can be recorded while the NCR is with its owner.', 'INVALID_STATE');
    const changes: Record<string, { from?: string; to?: string }> = {};
    for (const f of [...ACTION_FIELDS, 'dueAt'] as const) {
      if (input[f] === undefined) continue;
      const from = n[f] instanceof Date ? (n[f] as Date).toISOString() : (n[f] as string | undefined);
      const to = input[f] instanceof Date ? (input[f] as Date).toISOString() : input[f];
      if (from !== to) {
        changes[f] = { from, to };
        (n as Doc)[f] = input[f];
      }
    }
    if (!Object.keys(changes).length) return;
    n.revisions.push({ at: new Date(), by: auth.userId, byName: auth.name, changes } as never);
    // Starting work moves the NCR to Action in Progress automatically.
    if (n.status === 'ASSIGNED' || n.status === 'RETURNED') await wfTransition({ entity: 'ncr', record: n as never, action: 'startAction', ctx, session, entityRef: n.ncrNo });
    await n.save({ session });
    await audit(ctx, { action: 'ncr.actionsRecorded', entityType: 'ncr', entityId: n._id, entityRef: n.ncrNo, after: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to])) }, session);
  });
  return getNcr(auth, id);
}

export async function updateNcr(ctx: RequestContext, id: string, input: Doc) {
  const auth = ctx.auth!;
  await validateLists(input.category, input.severity);
  await withTransaction(async (session) => {
    const n = await loadNcrInScope(auth, id, session);
    if (!OPEN.includes(n.status)) throw conflict('Verified or closed NCRs cannot be edited.', 'INVALID_STATE');
    if (!auth.permissions.has('ncr.assign') && String(n.raisedBy) !== auth.userId) throw forbidden('Only the person who raised the NCR or a supervisor can edit its details.');
    const before: Doc = {};
    const after: Doc = {};
    for (const k of ['category', 'severity', 'title', 'description', 'dueAt'] as const) {
      if (input[k] === undefined) continue;
      before[k] = n[k];
      (n as Doc)[k] = input[k] ?? undefined;
      after[k] = input[k];
    }
    await n.save({ session });
    await audit(ctx, { action: AUDIT_ACTIONS.UPDATE, entityType: 'ncr', entityId: n._id, entityRef: n.ncrNo, before, after, reason: input.reason }, session);
  });
  return getNcr(auth, id);
}

export async function transitionNcr(ctx: RequestContext, id: string, body: { action: string; reason?: string; comment?: string }) {
  const auth = ctx.auth!;
  await withTransaction(async (session) => {
    const n = await loadNcrInScope(auth, id, session);
    if (body.action === 'assign') throw conflict('Use the assign endpoint to choose an owner.', 'USE_ASSIGN');
    await wfTransition({ entity: 'ncr', record: n as never, action: body.action, ctx, reason: body.reason, session, entityRef: n.ncrNo });
    const now = new Date();
    if (body.action === 'submitForVerification') {
      n.revisions.push({ at: now, by: auth.userId, byName: auth.name, changes: { submitted: { to: 'Submitted for verification' } } } as never);
      const verifiers = (await usersWithPermissionInScope('ncr.verify', n)).filter((u) => String(u._id) !== String(n.ownerId));
      await notify({ recipientIds: verifiers.map((u) => u._id), type: 'ncr.submitted', title: `NCR ready for verification: ${n.ncrNo}`, body: n.title, link: `/ncrs/${n._id}`, entityType: 'ncr', entityId: n._id }, session);
    }
    if (body.action === 'return') {
      await notify({ recipientIds: [n.ownerId!], type: 'ncr.returned', title: `NCR returned: ${n.ncrNo}`, body: body.reason ?? '', link: `/ncrs/${n._id}`, entityType: 'ncr', entityId: n._id, severity: 'warning' }, session);
    }
    if (body.action === 'verify') {
      n.verification = { by: auth.userId, byName: auth.name, at: now, comment: body.comment ?? body.reason } as never;
      await notify({ recipientIds: [n.ownerId, n.raisedBy].filter((x): x is Types.ObjectId => Boolean(x)), type: 'ncr.verified', title: `NCR verified: ${n.ncrNo}`, body: body.comment ?? '', link: `/ncrs/${n._id}`, entityType: 'ncr', entityId: n._id, severity: 'success' }, session);
    }
    if (body.action === 'close') n.closedAt = now;
    await n.save({ session });
  });
  return getNcr(auth, id);
}

export async function addComment(ctx: RequestContext, id: string, text: string) {
  const auth = ctx.auth!;
  const n = await loadNcrInScope(auth, id);
  n.comments.push({ text, by: auth.userId, byName: auth.name, at: new Date() } as never);
  await n.save();
  await audit(ctx, { action: 'ncr.commented', entityType: 'ncr', entityId: n._id, entityRef: n.ncrNo });
  return getNcr(auth, id);
}

export async function addEvidence(ctx: RequestContext, id: string, files: IncomingFile[], kind: 'evidence' | 'verification') {
  const auth = ctx.auth!;
  const n0 = await loadNcrInScope(auth, id);
  if (kind === 'verification') {
    if (!auth.permissions.has('ncr.verify')) throw forbidden('Only verifiers can add verification evidence.');
    if (n0.status !== 'SUBMITTED_FOR_VERIFICATION') throw conflict('Verification evidence is added while the NCR awaits verification.', 'INVALID_STATE');
    if (String(n0.ownerId) === auth.userId) throw forbidden('The owner cannot provide verification evidence for their own action.');
  } else if (!OPEN.includes(n0.status)) {
    throw conflict('Evidence cannot be added to a verified or closed NCR.', 'INVALID_STATE');
  }
  const validated = await validateFiles(files);
  await withTransaction(async (session) => {
    await storeFiles(ctx, validated, { type: 'ncr', id: n0._id, context: kind }, { type: 'USER' }, session);
    await audit(ctx, { action: `ncr.${kind}Added`, entityType: 'ncr', entityId: n0._id, entityRef: n0.ncrNo, after: { files: validated.map((f) => f.originalName) } }, session);
  });
  return getNcr(auth, id);
}

// ---- Options (lists + owner candidates) ------------------------------------------------------------

/** Configured lists (D-08) for anyone who works NCRs; owner candidates only for assigners. */
export async function ncrOptions(auth: AuthContext, q: { complaintId?: string }) {
  const s = await getSettingsGroup('ncr');
  let owners: { id: string; name: string }[] | undefined;
  if (auth.permissions.has('ncr.assign')) {
    let location: Doc = {};
    if (q.complaintId) {
      const c = await loadComplaintInScope(auth, q.complaintId);
      location = { organizationId: c.organizationId, regionId: c.regionId, siteId: c.siteId };
    }
    const users = q.complaintId
      ? await usersWithPermissionInScope('ncr.update', location)
      : await (async () => {
          const roles = await Role.find({ status: 'ACTIVE', permissions: 'ncr.update' }).select('_id').lean();
          return User.find({ status: 'ACTIVE', roleIds: { $in: roles.map((r) => r._id) } }).select('_id name').lean<Doc[]>();
        })();
    owners = (users as Doc[]).map((u) => ({ id: String(u._id), name: u.name })).sort((a, b) => a.name.localeCompare(b.name));
  }
  return { categories: s.categories, severities: s.severities, defaultDueDays: s.defaultDueDays, owners };
}

// ---- Read ----------------------------------------------------------------------------------------

async function summaries(rows: Doc[]): Promise<NcrSummaryDto[]> {
  const def = await getDefinition('ncr');
  const users = new Map((await User.find({ _id: { $in: rows.flatMap((r) => [r.ownerId, r.raisedBy]).filter(Boolean) } }).select('name').lean<Doc[]>()).map((u) => [String(u._id), u.name]));
  const now = new Date();
  return rows.map((n) => {
    const st = def.states.find((s) => s.key === n.status);
    return {
      id: String(n._id),
      ncrNo: n.ncrNo,
      title: n.title,
      status: n.status,
      statusLabel: st?.label ?? n.status,
      statusTone: st?.tone ?? 'neutral',
      category: n.category,
      severity: n.severity,
      complaint: { id: String(n.complaintId), referenceNo: n.complaintRef },
      workOrder: n.workOrderId ? { id: String(n.workOrderId), workOrderNo: n.workOrderNo } : null,
      site: { id: String(n.siteId), name: n.siteName },
      owner: n.ownerId ? { id: String(n.ownerId), name: users.get(String(n.ownerId)) ?? 'Unknown' } : null,
      raisedBy: { id: String(n.raisedBy), name: users.get(String(n.raisedBy)) ?? n.raisedByName },
      dueAt: n.dueAt ?? null,
      overdue: Boolean(n.dueAt && new Date(n.dueAt) < now && OPEN.includes(n.status)),
      createdAt: n.createdAt,
    };
  });
}

export async function listNcrs(auth: AuthContext, q: { page: number; limit: number; sort?: string; status?: string; complaintId?: string; workOrderId?: string; ownerId?: string; mine?: string; severity?: string; category?: string; overdue?: string; q?: string }) {
  const f: Doc = {};
  if (q.status) f.status = q.status === 'OPEN' ? { $in: OPEN } : { $in: q.status.split(',') };
  if (q.complaintId) f.complaintId = oid(q.complaintId);
  if (q.workOrderId) f.workOrderId = oid(q.workOrderId);
  if (q.ownerId) f.ownerId = oid(q.ownerId);
  if (q.mine === 'true') f.ownerId = oid(auth.userId);
  if (q.severity) f.severity = q.severity;
  if (q.category) f.category = q.category;
  if (q.overdue === 'true') {
    f.dueAt = { $lt: new Date() };
    f.status = { $in: OPEN };
  }
  if (q.q) {
    const rx = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    f.$or = [{ ncrNo: rx }, { title: rx }, { complaintRef: rx }, { workOrderNo: rx }];
  }
  const scoped = withScope(f, auth, NCR_SCOPE);
  const sort = parseSort(q.sort, ['createdAt', 'dueAt', 'ncrNo', 'severity'], { createdAt: -1 });
  const [rows, total] = await Promise.all([Ncr.find(scoped).sort(sort).skip((q.page - 1) * q.limit).limit(q.limit).lean<Doc[]>(), Ncr.countDocuments(scoped)]);
  return paged(await summaries(rows), total, q.page, q.limit);
}

export async function getNcr(auth: AuthContext, id: string): Promise<NcrDetailDto> {
  const n = (await loadNcrInScope(auth, id)).toObject() as Doc;
  const [summary] = await summaries([n]);
  const [def, files, asset, report] = await Promise.all([
    getDefinition('ncr'),
    Attachment.find({ ownerType: 'ncr', ownerId: n._id, removedAt: null }).sort({ createdAt: 1 }).lean<Doc[]>(),
    n.assetId ? Asset.findById(n.assetId).select('name code').lean<Doc>() : null,
    n.inspectionReportId ? InspectionReport.findById(n.inspectionReportId).select('templateItems').lean<Doc>() : null,
  ]);
  const p = auth.permissions;
  const isOwner = String(n.ownerId) === auth.userId;
  const open = OPEN.includes(n.status);
  const actions = (await availableActions('ncr', n as never, { auth })).filter((a) => a.action !== 'assign');
  return {
    ...summary,
    description: n.description,
    asset: asset ? { id: String(asset._id), name: asset.name, code: asset.code } : null,
    inspection: n.inspectionReportId
      ? { reportId: String(n.inspectionReportId), itemKey: n.itemKey, itemDescription: (report?.templateItems as TemplateItem[] | undefined)?.find((i) => i.key === n.itemKey)?.description }
      : null,
    containmentAction: n.containmentAction,
    rootCause: n.rootCause,
    correctiveAction: n.correctiveAction,
    disposition: n.disposition,
    verification: n.verification?.at ? { byName: n.verification.byName, at: n.verification.at, comment: n.verification.comment } : null,
    evidence: files.filter((f) => f.context !== 'verification').map((f) => toAttachmentDto(f) as never),
    verificationEvidence: files.filter((f) => f.context === 'verification').map((f) => toAttachmentDto(f) as never),
    comments: (n.comments ?? []).map((c: Doc) => ({ id: String(c._id), text: c.text, byName: c.byName, at: c.at })),
    revisions: (n.revisions ?? []).map((r: Doc) => ({ at: r.at, byName: r.byName, changes: r.changes })),
    statusHistory: (n.statusHistory ?? []).map((h: Doc) => ({ from: h.from, to: h.to, toLabel: def.states.find((s) => s.key === h.to)?.label ?? h.to, action: h.action, byName: h.byName, at: h.at, reason: h.reason })),
    availableActions: actions,
    permissions: {
      canEditActions: isOwner && p.has('ncr.update') && ['ASSIGNED', 'ACTION_IN_PROGRESS', 'RETURNED'].includes(n.status),
      canEditDetails: open && (p.has('ncr.assign') || String(n.raisedBy) === auth.userId),
      canAssign: open && p.has('ncr.assign'),
      canVerify: n.status === 'SUBMITTED_FOR_VERIFICATION' && p.has('ncr.verify') && !isOwner,
      canComment: p.has('ncr.read'),
      canUploadEvidence: open && (p.has('ncr.create') || isOwner),
      canUploadVerification: n.status === 'SUBMITTED_FOR_VERIFICATION' && p.has('ncr.verify') && !isOwner,
      reasonIfNotVerify: n.status === 'SUBMITTED_FOR_VERIFICATION' && isOwner ? 'You own this NCR, so another reviewer must verify it.' : undefined,
    },
    updatedAt: undefined as never,
  } as NcrDetailDto;
}

export async function ncrSummary(auth: AuthContext) {
  const scope = withScope({}, auth, NCR_SCOPE);
  const by = await Ncr.aggregate<{ _id: string; n: number }>([{ $match: scope }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const s = Object.fromEntries(by.map((b) => [b._id, b.n]));
  const [overdue, mine, bySeverity] = await Promise.all([
    Ncr.countDocuments({ $and: [scope, { status: { $in: OPEN }, dueAt: { $lt: new Date() } }] }),
    Ncr.countDocuments({ $and: [scope, { status: { $in: OPEN }, ownerId: oid(auth.userId) }] }),
    Ncr.aggregate<{ _id: string; n: number }>([{ $match: { $and: [scope, { status: { $in: OPEN } }] } }, { $group: { _id: '$severity', n: { $sum: 1 } } }]),
  ]);
  const def = await getDefinition('ncr');
  return {
    open: OPEN.reduce((a, k) => a + (s[k] ?? 0), 0),
    awaitingVerification: s.SUBMITTED_FOR_VERIFICATION ?? 0,
    overdue,
    assignedToMe: mine,
    closed: s.CLOSED ?? 0,
    statuses: def.states.filter((st) => s[st.key]).map((st) => ({ key: st.key, label: st.label, tone: st.tone, count: s[st.key] })),
    bySeverity: bySeverity.map((b) => ({ severity: b._id, count: b.n })),
  };
}

