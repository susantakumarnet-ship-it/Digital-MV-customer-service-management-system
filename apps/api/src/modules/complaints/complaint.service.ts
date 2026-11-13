import { Types, type ClientSession } from 'mongoose';
import {
  AUDIT_ACTIONS,
  COMPLAINT_CLOSED_STATUSES,
  type ClassificationInput,
  type ComplaintListQuery,
  type ComplaintSource,
} from '@mv/shared';
import type { AuthContext, RequestContext } from '../../common/context';
import { escapeRegex } from '../../common/crypto';
import { badRequest, conflict, forbidden, notFound, validationFailed } from '../../common/errors';
import { paged, parseSort } from '../../common/http/route';
import { audit, diff } from '../../core/audit/audit.service';
import { nextReference } from '../../core/counters/counter.service';
import { renderEmail, sendMail } from '../../core/mail/mail.service';
import { notify } from '../../core/notifications/notification.service';
import { usersWithPermissionInScope } from '../../core/notifications/recipients';
import { inScope, withScope } from '../../core/scope/scope.service';
import { getSettings } from '../../core/settings/settings.service';
import { attachmentUsage, storeFiles, validateFiles, type IncomingFile } from '../../core/storage/upload.service';
import { transition as wfTransition } from '../../core/workflow/workflow.engine';
import { withTransaction } from '../../db/transaction';
import { Priority, Site } from '../masters/master.models';
import { masterOptions } from '../masters/masters.service';
import { getDefinition } from '../../core/workflow/workflow.engine';
import { loadPrincipal } from '../auth/principal.service';
import { toDetail, toSummaries } from './complaint.dto';
import { resolveLocation } from './complaint.location';
import { COMPLAINT_SCOPE, Complaint } from './complaint.model';

type Doc = Record<string, any>;
const EDITABLE = ['NEW', 'UNDER_REVIEW', 'AWAITING_CUSTOMER_INFO', 'REOPENED'];

// ---- Access ----------------------------------------------------------------------------------------

export async function loadComplaintInScope(auth: AuthContext, id: string, session?: ClientSession) {
  const c = await Complaint.findById(id).session(session ?? null);
  // Out-of-scope records are reported as not found (no existence leak / IDOR).
  if (!c || !inScope(auth, c.toObject(), COMPLAINT_SCOPE)) throw notFound('Complaint');
  return c;
}

export async function canAccessComplaint(auth: AuthContext, id: string) {
  if (!auth.permissions.has('complaint.read')) return false;
  const c = await Complaint.findById(id).select('organizationId regionId siteId supervisorId createdBy').lean();
  return Boolean(c && inScope(auth, c, COMPLAINT_SCOPE));
}

// ---- Intake ----------------------------------------------------------------------------------------

export interface IntakeData {
  customerName: string;
  organizationName?: string;
  contactPerson?: string;
  mobile: string;
  email: string;
  regionId: string;
  cityId: string;
  siteId: string;
  assetId?: string;
  equipmentTypeId?: string;
  requestTypeId: string;
  suggestedPriorityId?: string;
  description: string;
}

export async function createComplaint(
  ctx: RequestContext,
  data: IntakeData,
  opts: {
    source: ComplaintSource;
    receivedAt?: Date;
    consent: { accepted: boolean; version?: string };
    files?: IncomingFile[];
  },
) {
  const location = await resolveLocation(data);
  const auth = ctx.auth;
  if (auth && !inScope(auth, { organizationId: location.organizationId, regionId: location.regionId, siteId: location.siteId }, COMPLAINT_SCOPE)) {
    throw forbidden('You can only register complaints for sites within your access scope.');
  }
  const validated = await validateFiles(opts.files ?? []);
  const now = new Date();

  const created = await withTransaction(async (session, afterCommit) => {
    const referenceNo = await nextReference('complaint', session, now);
    const [c] = await Complaint.create(
      [
        {
          referenceNo,
          source: opts.source,
          status: 'NEW',
          statusHistory: [{ to: 'NEW', action: 'submit', by: auth?.userId, byName: auth?.name ?? data.customerName, at: now }],
          customerName: data.customerName,
          organizationName: data.organizationName,
          contactPerson: data.contactPerson,
          mobile: data.mobile,
          email: data.email,
          organizationId: location.organizationId,
          regionId: location.regionId,
          cityId: location.cityId,
          siteId: location.siteId,
          assetId: location.assetId,
          equipmentTypeId: location.equipmentTypeId,
          snapshot: location.snapshot,
          requestTypeId: data.requestTypeId,
          suggestedPriorityId: data.suggestedPriorityId,
          description: data.description,
          receivedAt: opts.receivedAt ?? now,
          consent: { accepted: opts.consent.accepted, version: opts.consent.version, at: now, ip: ctx.ip },
          submittedIp: ctx.ip,
          createdBy: auth?.userId,
        },
      ],
      { session },
    );
    if (validated.length) {
      await storeFiles(ctx, validated, { type: 'complaint', id: c._id, context: 'intake' }, { type: auth ? 'USER' : 'PUBLIC', name: auth?.name ?? data.customerName }, session);
    }
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.CREATE,
        entityType: 'complaint',
        entityId: c._id,
        entityRef: referenceNo,
        after: { source: opts.source, siteId: String(location.siteId), requestTypeId: data.requestTypeId, attachments: validated.length },
        actorName: auth?.name ?? `Public: ${data.customerName}`,
      },
      session,
    );
    const supervisors = await usersWithPermissionInScope('complaint.classify', location);
    await notify(
      {
        recipientIds: supervisors.map((u) => u._id),
        type: 'complaint.submitted',
        title: `New complaint ${referenceNo}`,
        body: `${location.snapshot.siteName}: ${data.description.slice(0, 140)}`,
        link: `/complaints/${c._id}`,
        entityType: 'complaint',
        entityId: c._id,
        severity: 'info',
      },
      session,
    );
    afterCommit(() => sendAcknowledgement(c.toObject()));
    return c;
  });
  return created;
}

async function sendAcknowledgement(c: Doc) {
  const s = await getSettings();
  const mail = renderEmail({
    title: `We have received your complaint ${c.referenceNo}`,
    paragraphs: [
      `Dear ${c.customerName},`,
      `Thank you for contacting us. Your complaint has been registered with reference ${c.referenceNo} on ${new Date(c.receivedAt).toUTCString()}.`,
      `Site: ${c.snapshot?.siteName ?? ''}.`,
      'Our service team will review it and contact you. Please quote the reference number in any correspondence.',
      s.general.supportEmail || s.general.supportPhone
        ? `Contact: ${[s.general.supportEmail, s.general.supportPhone].filter(Boolean).join(' / ')}`
        : '',
    ].filter(Boolean),
  });
  await sendMail({ to: c.email, subject: `Complaint received: ${c.referenceNo}`, ...mail });
}

/**
 * Accidental duplicate detection for the public form (PUB-06): only reports an earlier reference
 * when the SAME email reported the SAME site recently, so nothing leaks about other people's complaints.
 */
export async function findOwnRecentComplaint(email: string, siteId: string) {
  const s = await getSettings();
  const since = new Date(Date.now() - s.workflow.duplicateLookbackDays * 86400_000);
  return Complaint.findOne({
    email: email.toLowerCase(),
    siteId: new Types.ObjectId(siteId),
    receivedAt: { $gte: since },
    status: { $nin: COMPLAINT_CLOSED_STATUSES },
  })
    .sort({ receivedAt: -1 })
    .select('referenceNo')
    .lean();
}

/** Possible duplicates for reviewers: same site (and asset when known), recent, still open. */
export async function possibleDuplicates(auth: AuthContext, id: string) {
  const c = await loadComplaintInScope(auth, id);
  const s = await getSettings();
  const since = new Date(c.receivedAt.getTime() - s.workflow.duplicateLookbackDays * 86400_000);
  const filter: Doc = {
    _id: { $ne: c._id },
    siteId: c.siteId,
    receivedAt: { $gte: since },
    status: { $nin: ['DUPLICATE', 'REJECTED', 'CANCELLED'] },
  };
  const rows = await Complaint.find(withScope(filter, auth, COMPLAINT_SCOPE)).sort({ receivedAt: -1 }).limit(10).lean();
  const summaries = await toSummaries(rows);
  return summaries.map((s2, i) => ({
    ...s2,
    sameAsset: Boolean(c.assetId && rows[i].assetId && String(rows[i].assetId) === String(c.assetId)),
    sameEmail: rows[i].email === c.email,
  }));
}

// ---- Queries ---------------------------------------------------------------------------------------

export function buildListFilter(auth: AuthContext, q: ComplaintListQuery) {
  const f: Doc = {};
  if (q.status) {
    if (q.status === 'OPEN') f.status = { $nin: COMPLAINT_CLOSED_STATUSES };
    else f.status = { $in: q.status.split(',').map((s) => s.trim()).filter(Boolean) };
  }
  for (const k of ['priorityId', 'requestTypeId', 'regionId', 'cityId', 'siteId', 'organizationId', 'supervisorId'] as const) {
    if (q[k]) f[k] = new Types.ObjectId(q[k]);
  }
  if (q.source) f.source = q.source;
  if (q.unclassified === 'true') f.classifiedAt = null;
  if (q.receivedFrom || q.receivedTo) f.receivedAt = { ...(q.receivedFrom ? { $gte: q.receivedFrom } : {}), ...(q.receivedTo ? { $lte: q.receivedTo } : {}) };
  if (q.dueFrom || q.dueTo) f.dueAt = { ...(q.dueFrom ? { $gte: q.dueFrom } : {}), ...(q.dueTo ? { $lte: q.dueTo } : {}) };
  const and: Doc[] = [f];
  if (q.overdue === 'true') {
    and.push({ dueAt: { $lt: new Date() }, resolvedAt: null, status: { $nin: COMPLAINT_CLOSED_STATUSES } });
  }
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    and.push({ $or: [{ referenceNo: rx }, { customerName: rx }, { organizationName: rx }, { 'snapshot.siteName': rx }, { description: rx }, { email: rx }] });
  }
  return withScope(and.length === 1 ? f : { $and: and }, auth, COMPLAINT_SCOPE);
}

const SORTABLE = ['receivedAt', 'referenceNo', 'dueAt', 'status', 'customerName', 'updatedAt'];

export async function listComplaints(auth: AuthContext, q: ComplaintListQuery) {
  const filter = buildListFilter(auth, q);
  const sort = parseSort(q.sort, SORTABLE, { receivedAt: -1 });
  const [rows, total] = await Promise.all([
    Complaint.find(filter).sort(sort).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
    Complaint.countDocuments(filter),
  ]);
  return paged(await toSummaries(rows), total, q.page, q.limit);
}

export async function getComplaint(auth: AuthContext, id: string) {
  const c = await loadComplaintInScope(auth, id);
  return toDetail(c.toObject(), auth);
}

// ---- Updates ---------------------------------------------------------------------------------------

export async function updateIntake(ctx: RequestContext, id: string, input: Doc) {
  const auth = ctx.auth!;
  const saved = await withTransaction(async (session) => {
    const c = await loadComplaintInScope(auth, id, session);
    if (!EDITABLE.includes(c.status)) throw conflict('Complaint details can no longer be edited at this stage.', 'COMPLAINT_LOCKED');
    const before = c.toObject();
    const { reason, ...fields } = input;
    if (fields.siteId || fields.assetId !== undefined || fields.equipmentTypeId !== undefined) {
      const site = fields.siteId ? await Site.findById(fields.siteId).session(session).lean<Doc>() : null;
      const loc = await resolveLocation(
        {
          regionId: String(site?.regionId ?? c.regionId),
          cityId: String(site?.cityId ?? c.cityId),
          siteId: String(fields.siteId ?? c.siteId),
          assetId: fields.assetId === '' || fields.assetId === null ? undefined : (fields.assetId ?? (fields.siteId ? undefined : c.assetId?.toString())),
          equipmentTypeId: fields.equipmentTypeId === '' || fields.equipmentTypeId === null ? undefined : (fields.equipmentTypeId ?? undefined),
        },
        session,
      );
      if (!inScope(auth, { organizationId: loc.organizationId, regionId: loc.regionId, siteId: loc.siteId }, COMPLAINT_SCOPE)) {
        throw forbidden('The new site is outside your access scope.');
      }
      Object.assign(c, {
        organizationId: loc.organizationId,
        regionId: loc.regionId,
        cityId: loc.cityId,
        siteId: loc.siteId,
        assetId: loc.assetId,
        equipmentTypeId: loc.equipmentTypeId,
        snapshot: loc.snapshot,
      });
    }
    for (const k of ['customerName', 'organizationName', 'contactPerson', 'mobile', 'email', 'description'] as const) {
      if (fields[k] !== undefined) (c as Doc)[k] = fields[k];
    }
    c.updatedBy = new Types.ObjectId(auth.userId) as never;
    await c.save({ session });
    const d = diff(before, c.toObject());
    if (d.changed.length) {
      await audit(ctx, { action: AUDIT_ACTIONS.UPDATE, entityType: 'complaint', entityId: c._id, entityRef: c.referenceNo, before: d.before, after: d.after, reason }, session);
    }
    return c;
  });
  // Build the response after commit so it reflects committed data (e.g. new attachments).
  return toDetail(saved.toObject(), auth);
}

export async function classifyComplaint(ctx: RequestContext, id: string, input: ClassificationInput) {
  const auth = ctx.auth!;
  const saved = await withTransaction(async (session) => {
    const c = await loadComplaintInScope(auth, id, session);
    if (!EDITABLE.includes(c.status)) throw conflict('This complaint can no longer be classified.', 'COMPLAINT_LOCKED');
    const before = c.toObject();

    const priority = await Priority.findById(input.priorityId).session(session).lean<Doc>();
    if (!priority || priority.status !== 'ACTIVE') throw validationFailed({ priorityId: 'Select an active priority' });
    await resolveLocation(
      {
        regionId: String(c.regionId),
        cityId: String(c.cityId),
        siteId: String(c.siteId),
        assetId: input.assetId ?? c.assetId?.toString(),
        equipmentTypeId: input.equipmentTypeId ?? c.equipmentTypeId?.toString(),
        requestTypeId: input.requestTypeId,
      },
      session,
    );

    const supervisorId = input.supervisorId ?? auth.userId;
    if (supervisorId !== auth.userId) {
      const sup = await loadPrincipal(supervisorId);
      if (!sup || sup.user.status !== 'ACTIVE' || !sup.permissions.has('complaint.classify')) {
        throw validationFailed({ supervisorId: 'Select an active user who can review complaints' });
      }
    }

    // Classifying a NEW (or reopened) complaint starts the review (workflow transition, audited).
    if (c.status === 'NEW' || c.status === 'REOPENED') {
      await wfTransition({ entity: 'complaint', record: c as never, action: 'startReview', ctx, session, entityRef: c.referenceNo });
    }
    const now = new Date();
    c.requestTypeId = new Types.ObjectId(input.requestTypeId) as never;
    c.priorityId = priority._id as never;
    c.category = input.category;
    if (input.assetId) c.assetId = new Types.ObjectId(input.assetId) as never;
    if (input.equipmentTypeId) c.equipmentTypeId = new Types.ObjectId(input.equipmentTypeId) as never;
    c.supervisorId = new Types.ObjectId(supervisorId) as never;
    c.classifiedAt = now;
    c.classifiedBy = new Types.ObjectId(auth.userId) as never;
    c.classifiedByName = auth.name;
    c.classificationNotes = input.notes;
    c.acknowledgedAt ??= now;
    // SLA due date from the priority's resolution target (CFG-02, SUP-03).
    c.dueAt = priority.slaResolveHours ? new Date(c.receivedAt.getTime() + priority.slaResolveHours * 3600_000) : undefined;
    c.updatedBy = new Types.ObjectId(auth.userId) as never;
    await c.save({ session });

    const d = diff(before, c.toObject());
    await audit(ctx, { action: 'complaint.classified', entityType: 'complaint', entityId: c._id, entityRef: c.referenceNo, before: d.before, after: d.after }, session);
    if (supervisorId !== auth.userId) {
      await notify(
        { recipientIds: [supervisorId], type: 'complaint.assignedSupervisor', title: `Complaint ${c.referenceNo} assigned to you`, body: `Priority ${priority.name}.`, link: `/complaints/${c._id}`, entityType: 'complaint', entityId: c._id },
        session,
      );
    }
    return c;
  });
  // Build the response after commit so it reflects committed data (e.g. new attachments).
  return toDetail(saved.toObject(), auth);
}

/**
 * Side effects owned by later modules (acceptance, closure, NCR) run inside the same transaction as
 * the transition. Registered by name at startup so repeated app creation (tests) never duplicates.
 */
export interface ComplaintTransitionHookArgs {
  ctx: RequestContext;
  complaint: InstanceType<typeof Complaint>;
  action: string;
  from: string;
  body: { action: string; reason?: string; extra?: Record<string, unknown> };
  session: ClientSession;
  afterCommit: (fn: () => unknown) => void;
}
const transitionHooks = new Map<string, (a: ComplaintTransitionHookArgs) => Promise<void>>();
export function registerComplaintTransitionHook(name: string, fn: (a: ComplaintTransitionHookArgs) => Promise<void>) {
  transitionHooks.set(name, fn);
}

export async function transitionComplaint(
  ctx: RequestContext,
  id: string,
  body: { action: string; reason?: string; duplicateOfId?: string; messageToCustomer?: string; extra?: Record<string, unknown> },
) {
  const auth = ctx.auth!;
  const result = await withTransaction(async (session, afterCommit) => {
    const c = await loadComplaintInScope(auth, id, session);
    const from = c.status;
    const r = await wfTransition({
      entity: 'complaint',
      record: c as never,
      action: body.action,
      ctx,
      reason: body.reason,
      payload: { duplicateOfId: body.duplicateOfId },
      session,
      entityRef: c.referenceNo,
    });
    for (const hook of transitionHooks.values()) await hook({ ctx, complaint: c, action: body.action, from, body, session, afterCommit });
    const now = new Date();
    if (from === 'NEW' && !c.acknowledgedAt) c.acknowledgedAt = now;

    if (body.action === 'markDuplicate') {
      const master = await Complaint.findById(body.duplicateOfId).session(session);
      c.duplicateOfId = master!._id as never;
      master!.linkedDuplicateIds = [...(master!.linkedDuplicateIds ?? []), c._id] as never;
      await master!.save({ session });
      await audit(ctx, { action: 'complaint.duplicateLinked', entityType: 'complaint', entityId: master!._id, entityRef: master!.referenceNo, after: { duplicate: c.referenceNo } }, session);
      afterCommit(() =>
        customerEmail(c.toObject(), `Update on complaint ${c.referenceNo}`, [
          `Your complaint ${c.referenceNo} concerns an issue that is already being handled under reference ${master!.referenceNo}.`,
          'We will keep you informed under that reference. No further action is needed from you.',
        ]),
      );
    }
    if (body.action === 'requestInfo') {
      const text = body.messageToCustomer?.trim() || body.reason!;
      c.customerMessages.push({ direction: 'TO_CUSTOMER', text, by: auth.userId, byName: auth.name, at: now } as never);
      const customers = await usersWithPermissionInScope('acceptance.decide', { organizationId: c.organizationId });
      await notify(
        { recipientIds: customers.map((u) => u._id), type: 'complaint.infoRequested', title: `Information requested for ${c.referenceNo}`, body: text.slice(0, 200), link: `/complaints/${c._id}`, entityType: 'complaint', entityId: c._id, severity: 'warning' },
        session,
      );
      afterCommit(() =>
        customerEmail(c.toObject(), `Information needed for complaint ${c.referenceNo}`, [
          'To continue with your complaint we need some more information:',
          text,
          'Customer portal users can reply in the portal. Otherwise please reply to our support contact quoting your reference number.',
        ]),
      );
    }
    if (body.action === 'reject' || body.action === 'cancel') {
      afterCommit(() =>
        customerEmail(c.toObject(), `Update on complaint ${c.referenceNo}`, [
          `Your complaint ${c.referenceNo} has been ${body.action === 'reject' ? 'closed without further action' : 'cancelled'}.`,
          `Reason: ${body.reason}`,
        ]),
      );
    }
    c.updatedBy = new Types.ObjectId(auth.userId) as never;
    await c.save({ session });
    return { complaint: c, transition: r };
  });
  return toDetail(result.complaint.toObject(), auth);
}

export async function customerEmail(c: Doc, subject: string, paragraphs: string[], action?: { label: string; url: string }) {
  const mail = renderEmail({ title: subject, paragraphs: [`Dear ${c.customerName},`, ...paragraphs], action });
  await sendMail({ to: c.email, subject, ...mail });
}

export async function addNote(ctx: RequestContext, id: string, text: string) {
  const auth = ctx.auth!;
  const saved = await withTransaction(async (session) => {
    const c = await loadComplaintInScope(auth, id, session);
    c.internalNotes.push({ text, by: auth.userId, byName: auth.name, at: new Date() } as never);
    await c.save({ session });
    await audit(ctx, { action: 'complaint.noteAdded', entityType: 'complaint', entityId: c._id, entityRef: c.referenceNo }, session);
    return c;
  });
  // Build the response after commit so it reflects committed data (e.g. new attachments).
  return toDetail(saved.toObject(), auth);
}

/** Portal customer replies to a request for information (D-31). */
export async function customerRespond(ctx: RequestContext, id: string, message: string, files: IncomingFile[]) {
  const auth = ctx.auth!;
  const c0 = await loadComplaintInScope(auth, id);
  if (c0.status !== 'AWAITING_CUSTOMER_INFO') throw conflict('No information has been requested for this complaint.', 'NO_INFO_REQUESTED');
  const validated = await validateFiles(files, await attachmentUsage('complaint', c0._id));
  const saved = await withTransaction(async (session) => {
    const c = await loadComplaintInScope(auth, id, session);
    c.customerMessages.push({ direction: 'FROM_CUSTOMER', text: message, by: auth.userId, byName: auth.name, at: new Date() } as never);
    if (validated.length) await storeFiles(ctx, validated, { type: 'complaint', id: c._id, context: 'customerResponse' }, { type: 'USER' }, session);
    await wfTransition({ entity: 'complaint', record: c as never, action: 'infoReceived', ctx, session, system: true, entityRef: c.referenceNo, reason: 'Customer responded via portal' });
    await c.save({ session });
    const recipients = c.supervisorId ? [c.supervisorId] : (await usersWithPermissionInScope('complaint.classify', c)).map((u) => u._id);
    await notify(
      { recipientIds: recipients, type: 'complaint.infoReceived', title: `Customer replied on ${c.referenceNo}`, body: message.slice(0, 200), link: `/complaints/${c._id}`, entityType: 'complaint', entityId: c._id },
      session,
    );
    return c;
  });
  // Build the response after commit so it reflects committed data (e.g. new attachments).
  return toDetail(saved.toObject(), auth);
}

export async function addAttachments(ctx: RequestContext, id: string, files: IncomingFile[], context: 'intake' | 'internal') {
  const auth = ctx.auth!;
  if (!files.length) throw badRequest('Attach at least one file');
  const c0 = await loadComplaintInScope(auth, id);
  const isStaff = auth.permissions.has('complaint.update');
  if (!isStaff && !auth.permissions.has('acceptance.decide')) throw forbidden();
  if (['CLOSED', 'DUPLICATE', 'REJECTED', 'CANCELLED'].includes(c0.status)) throw conflict('Files cannot be added to a closed complaint.', 'COMPLAINT_LOCKED');
  const validated = await validateFiles(files, await attachmentUsage('complaint', c0._id));
  const saved = await withTransaction(async (session) => {
    const c = await loadComplaintInScope(auth, id, session);
    const stored = await storeFiles(ctx, validated, { type: 'complaint', id: c._id, context: isStaff ? context : 'intake' }, { type: 'USER' }, session);
    await audit(ctx, { action: 'complaint.attachmentsAdded', entityType: 'complaint', entityId: c._id, entityRef: c.referenceNo, after: { files: stored.map((s) => s.originalName) } }, session);
    return c;
  });
  // Build the response after commit so it reflects committed data (e.g. new attachments).
  return toDetail(saved.toObject(), auth);
}

// ---- Scoped form options ---------------------------------------------------------------------------

/**
 * Options for complaint forms for signed-in users. Sites and assets are limited to the user's data
 * scope; regions and cities are limited to those that contain an in-scope site. Reference lists
 * (request types, priorities, equipment types) are unrestricted. Never depends on the public form.
 */
export async function scopedOptions(
  auth: AuthContext,
  resource: 'regions' | 'cities' | 'sites' | 'assets' | 'equipmentTypes' | 'requestTypes' | 'priorities',
  q: { parentField?: string; parentId?: string },
) {
  const all = await masterOptions(resource, { ...q, includeInactive: false });
  if (auth.scope.global || ['equipmentTypes', 'requestTypes', 'priorities'].includes(resource)) return all;
  const siteFilter = withScope({ status: 'ACTIVE' }, auth, { organization: 'organizationId', region: 'regionId', site: '_id' });
  const sites = await Site.find(siteFilter).select('_id cityId regionId').lean<Doc[]>();
  const allowed = {
    sites: new Set(sites.map((s) => String(s._id))),
    cities: new Set(sites.map((s) => String(s.cityId))),
    regions: new Set(sites.map((s) => String(s.regionId))),
  };
  if (resource === 'assets') return all.filter((a) => allowed.sites.has(String(a.siteId)));
  return all.filter((o) => allowed[resource as 'regions' | 'cities' | 'sites'].has(String(o.id)));
}

// ---- Dashboard summary -----------------------------------------------------------------------------

export async function complaintSummary(auth: AuthContext) {
  const scope = withScope({}, auth, COMPLAINT_SCOPE);
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const [byStatus, overdue, unclassified, byMonth, byRegion, byPriority, todayCount] = await Promise.all([
    Complaint.aggregate<{ _id: string; n: number }>([{ $match: scope }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Complaint.countDocuments({ $and: [scope, { dueAt: { $lt: now }, resolvedAt: null, status: { $nin: COMPLAINT_CLOSED_STATUSES } }] }),
    Complaint.countDocuments({ $and: [scope, { classifiedAt: null, status: { $nin: COMPLAINT_CLOSED_STATUSES } }] }),
    Complaint.aggregate<{ _id: string; n: number }>([
      { $match: { $and: [scope, { receivedAt: { $gte: monthStart } }] } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$receivedAt' } }, n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Complaint.aggregate<{ _id: string; n: number }>([{ $match: scope }, { $group: { _id: '$snapshot.regionName', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
    Complaint.aggregate<{ _id: unknown; n: number }>([{ $match: scope }, { $group: { _id: '$priorityId', n: { $sum: 1 } } }]),
    Complaint.countDocuments({ $and: [scope, { receivedAt: { $gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) } }] }),
  ]);
  const priorities = await Priority.find({}).select('name rank tone').lean<Doc[]>();
  const def = await getDefinition('complaint');
  const status = Object.fromEntries(byStatus.map((s) => [s._id, s.n]));
  const total = byStatus.reduce((a, s) => a + s.n, 0);
  const closed = COMPLAINT_CLOSED_STATUSES.reduce((a, k) => a + (status[k] ?? 0), 0);
  const months: { month: string; count: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    months.push({ month: key, count: byMonth.find((m) => m._id === key)?.n ?? 0 });
  }
  return {
    total,
    receivedToday: todayCount,
    new: status.NEW ?? 0,
    underReview: status.UNDER_REVIEW ?? 0,
    awaitingCustomer: status.AWAITING_CUSTOMER_INFO ?? 0,
    assigned: status.ASSIGNED ?? 0,
    inProgress: status.IN_PROGRESS ?? 0,
    pendingReview: status.SUBMITTED_FOR_REVIEW ?? 0,
    resolved: status.RESOLVED ?? 0,
    closed: status.CLOSED ?? 0,
    open: total - closed,
    overdue,
    unclassified,
    byStatus: status,
    /** Status counts with the configured labels/colours (D-01), in workflow order. */
    statuses: def.states
      .filter((s) => status[s.key])
      .map((s) => ({ key: s.key, label: s.label, tone: s.tone, count: status[s.key] })),
    byMonth: months,
    byRegion: byRegion.map((r) => ({ region: r._id ?? 'Unknown', count: r.n })),
    byPriority: byPriority.map((p) => {
      const pr = priorities.find((x) => String(x._id) === String(p._id));
      return { priority: pr?.name ?? 'Unclassified', rank: pr?.rank ?? 99, tone: pr?.tone ?? 'neutral', count: p.n };
    }).sort((a, b) => a.rank - b.rank),
  };
}
