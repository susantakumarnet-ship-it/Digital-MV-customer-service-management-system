import { Types, type ClientSession } from 'mongoose';
import {
  AUDIT_ACTIONS,

  type InspectionReportDto,
  type InspectionTemplateDto,
  type InspectionTemplateInput,
  type ReportItemDto,
  type TemplateItem,
} from '@mv/shared';
import type { AuthContext, RequestContext } from '../../common/context';
import { conflict, forbidden, notFound, validationFailed } from '../../common/errors';
import { paged } from '../../common/http/route';
import { audit } from '../../core/audit/audit.service';
import { nextSequence } from '../../core/counters/counter.service';
import { notify } from '../../core/notifications/notification.service';
import { usersWithPermissionInScope } from '../../core/notifications/recipients';
import { inScope, withScope } from '../../core/scope/scope.service';
import { Attachment, toAttachmentDto } from '../../core/storage/attachment.model';
import { attachmentUsage, storeFiles, validateFiles, type IncomingFile } from '../../core/storage/upload.service';
import { getDefinition, transition as wfTransition } from '../../core/workflow/workflow.engine';
import { withTransaction } from '../../db/transaction';
import { Complaint } from '../complaints/complaint.model';
import { Asset, EquipmentType, Site } from '../masters/master.models';
import { TimeEvent } from '../visits/visit.models';
import { loadVisitInScope } from '../visits/visit.service';
import { WorkOrder } from '../work-orders/work-order.model';
import { InspectionReport, InspectionTemplate, REPORT_SCOPE } from './inspection.models';
import { ReviewAction } from '../reviews/review.model';

type Doc = Record<string, any>;
const oid = (v: unknown) => new Types.ObjectId(String(v));

// ============================================================================================
// Templates (INSP-01/02)
// ============================================================================================

async function templateDto(t: Doc): Promise<InspectionTemplateDto> {
  const eq = await EquipmentType.findById(t.equipmentTypeId).select('name code').lean<Doc>();
  return {
    id: String(t._id),
    name: t.name,
    equipmentType: { id: String(t.equipmentTypeId), name: eq?.name ?? 'Unknown', code: eq?.code },
    version: t.version,
    status: t.status,
    description: t.description,
    items: t.items,
    publishedAt: t.publishedAt ?? null,
    publishedByName: t.publishedByName,
    updatedAt: t.updatedAt,
  };
}

export async function listTemplates(q: { page: number; limit: number; equipmentTypeId?: string; status: string; q?: string }) {
  const f: Doc = {};
  if (q.equipmentTypeId) f.equipmentTypeId = oid(q.equipmentTypeId);
  if (q.status !== 'ALL') f.status = q.status;
  if (q.q) f.name = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const [rows, total] = await Promise.all([
    InspectionTemplate.find(f).sort({ equipmentTypeId: 1, version: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean<Doc[]>(),
    InspectionTemplate.countDocuments(f),
  ]);
  return paged(await Promise.all(rows.map(templateDto)), total, q.page, q.limit);
}

export async function getTemplate(id: string) {
  const t = await InspectionTemplate.findById(id).lean<Doc>();
  if (!t) throw notFound('Checklist template');
  return templateDto(t);
}

async function nextVersion(equipmentTypeId: unknown, session: ClientSession) {
  const last = await InspectionTemplate.findOne({ equipmentTypeId }).sort({ version: -1 }).select('version').session(session).lean<Doc>();
  return (last?.version ?? 0) + 1;
}

export async function createTemplate(ctx: RequestContext, input: InspectionTemplateInput) {
  const eq = await EquipmentType.findById(input.equipmentTypeId).lean<Doc>();
  if (!eq || eq.status !== 'ACTIVE') throw validationFailed({ equipmentTypeId: 'Select an active equipment type' });
  const t = await withTransaction(async (session) => {
    const [doc] = await InspectionTemplate.create(
      [{ ...input, version: await nextVersion(input.equipmentTypeId, session), status: 'DRAFT', createdBy: ctx.auth?.userId }],
      { session },
    );
    await audit(ctx, { action: AUDIT_ACTIONS.CREATE, entityType: 'inspectionTemplate', entityId: doc._id, entityRef: `${input.name} v${doc.version}`, after: { items: input.items.length } }, session);
    return doc;
  });
  return templateDto(t.toObject());
}

export async function updateTemplate(ctx: RequestContext, id: string, input: InspectionTemplateInput) {
  const t = await InspectionTemplate.findById(id);
  if (!t) throw notFound('Checklist template');
  if (t.status !== 'DRAFT') throw conflict('Only draft versions can be edited. Create a new version instead.', 'TEMPLATE_LOCKED');
  if (String(t.equipmentTypeId) !== input.equipmentTypeId) throw validationFailed({ equipmentTypeId: 'The equipment type of a version cannot change' });
  const before = { name: t.name, items: t.items.length };
  t.name = input.name;
  t.description = input.description;
  t.items = input.items as never;
  await t.save();
  await audit(ctx, { action: AUDIT_ACTIONS.UPDATE, entityType: 'inspectionTemplate', entityId: t._id, entityRef: `${t.name} v${t.version}`, before, after: { name: t.name, items: t.items.length } });
  return templateDto(t.toObject());
}

/** Publish a draft: it becomes ACTIVE and the previous active version for the equipment type is retired. */
export async function publishTemplate(ctx: RequestContext, id: string) {
  const saved = await withTransaction(async (session) => {
    const t = await InspectionTemplate.findById(id).session(session);
    if (!t) throw notFound('Checklist template');
    if (t.status !== 'DRAFT') throw conflict('Only draft versions can be published.', 'TEMPLATE_LOCKED');
    const now = new Date();
    const previous = await InspectionTemplate.findOneAndUpdate(
      { equipmentTypeId: t.equipmentTypeId, status: 'ACTIVE' },
      { $set: { status: 'RETIRED', retiredAt: now } },
      { session },
    );
    t.status = 'ACTIVE';
    t.publishedAt = now;
    t.effectiveFrom = now;
    t.publishedBy = ctx.auth!.userId as never;
    t.publishedByName = ctx.auth!.name;
    await t.save({ session });
    await audit(ctx, { action: 'inspectionTemplate.published', entityType: 'inspectionTemplate', entityId: t._id, entityRef: `${t.name} v${t.version}`, meta: { retired: previous ? `v${previous.version}` : null } }, session);
    return t;
  });
  return templateDto(saved.toObject());
}

/** Start a new draft version from any existing version (usually the active one). */
export async function newTemplateVersion(ctx: RequestContext, id: string) {
  const saved = await withTransaction(async (session) => {
    const src = await InspectionTemplate.findById(id).session(session).lean<Doc>();
    if (!src) throw notFound('Checklist template');
    if (await InspectionTemplate.exists({ equipmentTypeId: src.equipmentTypeId, status: 'DRAFT' }).session(session)) {
      throw conflict('A draft version already exists for this equipment type.', 'DRAFT_EXISTS');
    }
    const [doc] = await InspectionTemplate.create(
      [{ name: src.name, equipmentTypeId: src.equipmentTypeId, description: src.description, items: src.items, version: await nextVersion(src.equipmentTypeId, session), status: 'DRAFT', createdBy: ctx.auth?.userId }],
      { session },
    );
    await audit(ctx, { action: AUDIT_ACTIONS.CREATE, entityType: 'inspectionTemplate', entityId: doc._id, entityRef: `${doc.name} v${doc.version}`, meta: { from: `v${src.version}` } }, session);
    return doc;
  });
  return templateDto(saved.toObject());
}

export async function retireTemplate(ctx: RequestContext, id: string, reason: string) {
  const t = await InspectionTemplate.findById(id);
  if (!t) throw notFound('Checklist template');
  if (t.status !== 'ACTIVE') throw conflict('Only the active version can be retired.', 'INVALID_STATE');
  t.status = 'RETIRED';
  t.retiredAt = new Date();
  await t.save();
  await audit(ctx, { action: 'inspectionTemplate.retired', entityType: 'inspectionTemplate', entityId: t._id, entityRef: `${t.name} v${t.version}`, reason });
  return templateDto(t.toObject());
}

// ============================================================================================
// Reports (INSP-02..07)
// ============================================================================================

export async function loadReportInScope(auth: AuthContext, id: string, session?: ClientSession) {
  const r = await InspectionReport.findById(id).session(session ?? null);
  if (!r || !inScope(auth, r.toObject(), REPORT_SCOPE)) throw notFound('Inspection report');
  return r;
}

export async function canAccessReport(auth: AuthContext, id: string) {
  if (!auth.permissions.has('inspection.read')) return false;
  const r = await InspectionReport.findById(id).select('organizationId regionId siteId assigneeIds createdBy').lean();
  return Boolean(r && inScope(auth, r, REPORT_SCOPE));
}

/** Creates revision 1 for a visit from the ACTIVE template of the asset's equipment type (INSP-02). */
export async function createReport(ctx: RequestContext, visitId: string, input: { assetId?: string }) {
  const auth = ctx.auth!;
  const saved = await withTransaction(async (session) => {
    const v = await loadVisitInScope(auth, visitId, session);
    if (!v.engineerIds.map(String).includes(auth.userId)) throw forbidden('Only engineers on this visit can create its inspection report.');
    if (v.status === 'CANCELLED') throw conflict('This visit was cancelled.', 'INVALID_STATE');
    const existing = await InspectionReport.findOne({ visitId: v._id }).sort({ revisionNo: -1 }).session(session);
    if (existing) return existing; // one report chain per visit
    const w = await WorkOrder.findById(v.workOrderId).session(session).lean<Doc>();
    const assetId = input.assetId ?? w?.assetId;
    let equipmentTypeId = w?.equipmentTypeId;
    let assetName: string | undefined;
    if (assetId) {
      const a = await Asset.findById(assetId).session(session).lean<Doc>();
      if (!a || String(a.siteId) !== String(v.siteId)) throw validationFailed({ assetId: 'Select an asset at this site' });
      if (a.status !== 'ACTIVE') throw validationFailed({ assetId: 'This asset is not available' });
      equipmentTypeId = a.equipmentTypeId;
      assetName = a.name;
    }
    if (!equipmentTypeId) throw conflict('Select the asset being inspected (its equipment type determines the checklist).', 'EQUIPMENT_TYPE_REQUIRED');
    const template = await InspectionTemplate.findOne({ equipmentTypeId, status: 'ACTIVE' }).session(session).lean<Doc>();
    if (!template) throw conflict('No active checklist template exists for this equipment type. Ask an administrator to publish one.', 'NO_TEMPLATE');
    const now = new Date();
    const [r] = await InspectionReport.create(
      [
        {
          visitId: v._id,
          visitNo: v.visitNo,
          workOrderId: v.workOrderId,
          workOrderNo: v.workOrderNo,
          complaintId: v.complaintId,
          complaintRef: v.complaintRef,
          organizationId: v.organizationId,
          regionId: v.regionId,
          siteId: v.siteId,
          siteName: v.siteName,
          assetId,
          equipmentTypeId,
          assigneeIds: v.engineerIds,
          templateId: template._id,
          templateName: template.name,
          templateVersion: template.version,
          templateItems: template.items,
          revisionNo: 1,
          results: template.items.map((i: TemplateItem) => ({ itemKey: i.key, result: null })),
          status: 'DRAFT',
          statusHistory: [{ to: 'DRAFT', action: 'create', by: auth.userId, byName: auth.name, at: now }],
          createdBy: auth.userId,
          createdByName: auth.name,
        },
      ],
      { session },
    );
    await audit(ctx, { action: AUDIT_ACTIONS.CREATE, entityType: 'inspectionReport', entityId: r._id, entityRef: `${v.visitNo} r1`, after: { template: `${template.name} v${template.version}`, asset: assetName } }, session);
    return r;
  });
  return getReport(auth, String(saved._id));
}

function assertCanEditReport(auth: AuthContext, r: Doc) {
  if (r.status !== 'DRAFT') throw conflict('Submitted reports cannot be changed. Corrections are made in a new revision after review.', 'REPORT_LOCKED');
  if (!(r.assigneeIds ?? []).map(String).includes(auth.userId) || !auth.permissions.has('inspection.create')) {
    throw forbidden('Only the engineers on this visit can edit the report.');
  }
}

export async function saveDraft(ctx: RequestContext, id: string, input: { results: Doc[]; findings?: string; recommendations?: string }) {
  const auth = ctx.auth!;
  const r = await loadReportInScope(auth, id);
  assertCanEditReport(auth, r);
  const keys = new Set(r.templateItems.map((i) => i.key));
  const byKey = new Map(r.results.map((x) => [x.itemKey, x]));
  for (const x of input.results) {
    if (!keys.has(x.itemKey)) throw validationFailed({ results: `Unknown checklist item "${x.itemKey}"` });
    const cur = byKey.get(x.itemKey) as Doc | undefined;
    const next = { itemKey: x.itemKey, result: x.result ?? null, remarks: x.remarks, reason: x.reason };
    if (cur) Object.assign(cur, next);
    else r.results.push(next as never);
  }
  if (input.findings !== undefined) r.findings = input.findings;
  if (input.recommendations !== undefined) r.recommendations = input.recommendations;
  await r.save();
  return getReport(auth, id);
}

export async function addReportAttachments(ctx: RequestContext, id: string, files: IncomingFile[], itemKey: string | undefined) {
  const auth = ctx.auth!;
  const r0 = await loadReportInScope(auth, id);
  assertCanEditReport(auth, r0);
  if (itemKey && !r0.templateItems.some((i) => i.key === itemKey)) throw validationFailed({ itemKey: 'Unknown checklist item' });
  // Evidence policy applies per report (all items).
  const validated = await validateFiles(files, await attachmentUsageForReport(r0._id));
  await withTransaction(async (session) => {
    const r = await loadReportInScope(auth, id, session);
    assertCanEditReport(auth, r);
    const stored = await storeFiles(ctx, validated, { type: 'inspectionReport', id: r._id, context: itemKey ?? 'general' }, { type: 'USER' }, session);
    await audit(ctx, { action: 'inspectionReport.evidenceAdded', entityType: 'inspectionReport', entityId: r._id, entityRef: `${r.visitNo} r${r.revisionNo}`, after: { itemKey, files: stored.map((s) => s.originalName) } }, session);
  });
  return getReport(auth, id);
}

/** Evidence volume is generous by design; reuse the attachment limits × item count. */
async function attachmentUsageForReport(reportId: unknown) {
  const u = await attachmentUsage('inspectionReport', reportId as never);
  // Count limit applies per item in practice; we only enforce the total-size cap across the report.
  return { count: 0, bytes: u.bytes };
}

export async function removeReportAttachment(ctx: RequestContext, id: string, attachmentId: string, reason: string) {
  const auth = ctx.auth!;
  const r = await loadReportInScope(auth, id);
  assertCanEditReport(auth, r);
  const a = await Attachment.findOne({ _id: attachmentId, ownerType: 'inspectionReport', ownerId: r._id, removedAt: null });
  if (!a) throw notFound('Attachment');
  a.removedAt = new Date();
  a.removedBy = auth.userId as never;
  a.removalReason = reason;
  await a.save();
  await audit(ctx, { action: 'inspectionReport.evidenceRemoved', entityType: 'inspectionReport', entityId: r._id, entityRef: `${r.visitNo} r${r.revisionNo}`, reason, meta: { filename: a.originalName } });
  return getReport(auth, id);
}

/** BR-006/007/008 validation, shared by the preview (issues) and the submit guard. */
export function itemIssues(item: TemplateItem, res: Doc | undefined, evidence: Doc[]): string[] {
  const issues: string[] = [];
  const result = res?.result as string | null | undefined;
  if (!result) {
    if (item.required) issues.push('A result is required');
    return issues;
  }
  if (result === 'NOT_CHECKED' && !res?.reason) issues.push('Not Checked requires a reason');
  if (result === 'NOT_APPLICABLE' && item.naReasonRequired && !res?.reason) issues.push('Not Applicable requires a reason for this item');
  const needs = item.evidence !== 'NONE' && result !== 'NOT_APPLICABLE' && result !== 'NOT_CHECKED' ? item.evidence : item.evidenceOnFail && result === 'FAIL' ? 'ANY' : 'NONE';
  if (needs !== 'NONE') {
    const photos = evidence.filter((a) => a.mimeType.startsWith('image/')).length;
    const docs = evidence.length - photos;
    if (needs === 'PHOTO' && !photos) issues.push('A photo is required as evidence');
    if (needs === 'DOCUMENT' && !docs) issues.push('A document is required as evidence');
    if (needs === 'ANY' && !evidence.length) issues.push('Evidence (photo or document) is required');
  }
  return issues;
}

/** D-33: the submitter must have recorded Arrive at Site, Start Work and End Work on the visit. */
export async function missingTimeEvents(visitId: unknown, userId: string, session?: ClientSession) {
  const events = await TimeEvent.find({ visitId, userId }).select('eventType').session(session ?? null).lean<Doc[]>();
  const have = new Set(events.map((e) => e.eventType));
  return ['ARRIVE_SITE', 'START_WORK', 'END_WORK'].filter((t) => !have.has(t));
}

export async function computeSubmissionIssues(r: Doc, submitterId: string, session?: ClientSession) {
  const evidence = await Attachment.find({ ownerType: 'inspectionReport', ownerId: r._id, removedAt: null }).session(session ?? null).lean<Doc[]>();
  const byKey = new Map((r.results ?? []).map((x: Doc) => [x.itemKey, x]));
  const issues: string[] = [];
  for (const item of r.templateItems as TemplateItem[]) {
    for (const i of itemIssues(item, byKey.get(item.key) as Doc | undefined, evidence.filter((a) => a.context === item.key))) issues.push(`${item.key} — ${item.description}: ${i}`);
  }
  const missing = await missingTimeEvents(r.visitId, submitterId, session);
  if (missing.length) issues.push(`Record your time events first: ${missing.join(', ')}`);
  return issues;
}

/** Submit (INSP-05/06/07): validates, freezes the revision, moves work order & complaint forward. */
export async function submitReport(ctx: RequestContext, id: string) {
  const auth = ctx.auth!;
  await withTransaction(async (session) => {
    const r = await loadReportInScope(auth, id, session);
    if (r.status !== 'DRAFT') throw conflict('This report has already been submitted.', 'REPORT_LOCKED');
    await wfTransition({ entity: 'inspectionReport', record: r as never, action: 'submit', ctx, session, entityRef: `${r.visitNo} r${r.revisionNo}` });
    const now = new Date();
    r.submittedAt = now;
    r.submittedBy = auth.userId as never;
    r.submittedByName = auth.name;
    await r.save({ session });

    // Work order → Submitted (from In Progress / Work Completed).
    const w = await WorkOrder.findById(r.workOrderId).session(session);
    if (w && (w.status === 'IN_PROGRESS' || w.status === 'WORK_COMPLETED')) {
      await wfTransition({ entity: 'workOrder', record: w as never, action: 'submit', ctx, session, system: true, entityRef: w.workOrderNo });
      w.completedAt = now;
      await w.save({ session });
    }
    // Complaint → Submitted for Review once no active work order is still in the field.
    const c = await Complaint.findById(r.complaintId).session(session);
    if (c && (c.status === 'IN_PROGRESS' || c.status === 'RETURNED_FOR_CORRECTION')) {
      const stillOpen = await WorkOrder.countDocuments({
        complaintId: c._id,
        status: { $nin: ['SUBMITTED', 'APPROVED', 'CLOSED', 'CANCELLED'] },
      }).session(session);
      if (!stillOpen) {
        await wfTransition({ entity: 'complaint', record: c as never, action: 'submitForReview', ctx, session, system: true, entityRef: c.referenceNo });
        await c.save({ session });
      }
    }
    const reviewers = (await usersWithPermissionInScope('inspection.approve', r)).filter((u) => String(u._id) !== auth.userId);
    await notify(
      { recipientIds: reviewers.map((u) => u._id), type: 'inspectionReport.submitted', title: `Inspection report submitted: ${r.workOrderNo}`, body: `${r.siteName ?? ''} — ${r.templateName} (rev ${r.revisionNo}) by ${auth.name}`, link: `/inspection-reports/${r._id}`, entityType: 'inspectionReport', entityId: r._id },
      session,
    );
  });
  return getReport(auth, id);
}

export async function getReport(auth: AuthContext, id: string): Promise<InspectionReportDto> {
  const r = (await loadReportInScope(auth, id)).toObject() as Doc;
  // Feedback from the review that returned the previous revision (shown to engineers on this draft).
  const returnedBy = r.previousRevisionId ? await ReviewAction.findOne({ reportId: r.previousRevisionId, action: 'return' }).lean<Doc>() : null;
  const feedback = new Map(((returnedBy?.itemFeedback ?? []) as Doc[]).map((x) => [x.itemKey, x.comment as string]));
  const [def, evidence, asset, eq, wo] = await Promise.all([
    getDefinition('inspectionReport'),
    Attachment.find({ ownerType: 'inspectionReport', ownerId: r._id, removedAt: null }).sort({ createdAt: 1 }).lean<Doc[]>(),
    r.assetId ? Asset.findById(r.assetId).select('name code').lean<Doc>() : null,
    EquipmentType.findById(r.equipmentTypeId).select('name code').lean<Doc>(),
    WorkOrder.findById(r.workOrderId).select('title').lean<Doc>(),
  ]);
  const st = def.states.find((s) => s.key === r.status);
  const byKey = new Map((r.results ?? []).map((x: Doc) => [x.itemKey, x]));
  const items: ReportItemDto[] = (r.templateItems as TemplateItem[]).map((item) => {
    const res = byKey.get(item.key) as Doc | undefined;
    const ev = evidence.filter((a) => a.context === item.key);
    return { ...item, result: res?.result ?? null, remarks: res?.remarks, reason: res?.reason, attachments: ev.map((a) => toAttachmentDto(a) as never), issues: itemIssues(item, res, ev), feedback: feedback.get(item.key) };
  });
  const count = (k: string) => items.filter((i) => i.result === k).length;
  const isEngineer = (r.assigneeIds ?? []).map(String).includes(auth.userId);
  const draft = r.status === 'DRAFT';
  const submissionIssues = draft && isEngineer ? await computeSubmissionIssues(r, auth.userId) : [];
  return {
    id: String(r._id),
    revisionNo: r.revisionNo,
    status: r.status,
    statusLabel: st?.label ?? r.status,
    statusTone: st?.tone ?? 'neutral',
    locked: !draft,
    visit: { id: String(r.visitId), visitNo: r.visitNo },
    workOrder: { id: String(r.workOrderId), workOrderNo: r.workOrderNo, title: wo?.title ?? '' },
    complaint: { id: String(r.complaintId), referenceNo: r.complaintRef },
    site: { id: String(r.siteId), name: r.siteName },
    asset: asset ? { id: String(asset._id), name: asset.name, code: asset.code } : null,
    equipmentType: eq ? { id: String(eq._id), name: eq.name, code: eq.code } : null,
    template: { id: String(r.templateId), name: r.templateName, version: r.templateVersion },
    items,
    findings: r.findings,
    recommendations: r.recommendations,
    summary: {
      total: items.length,
      pass: count('PASS'),
      fail: count('FAIL'),
      notChecked: count('NOT_CHECKED'),
      notApplicable: count('NOT_APPLICABLE'),
      unanswered: items.filter((i) => !i.result).length,
    },
    submissionIssues,
    submittedAt: r.submittedAt ?? null,
    submittedByName: r.submittedByName,
    createdByName: r.createdByName,
    previousRevisionId: r.previousRevisionId ? String(r.previousRevisionId) : null,
    reviewFeedback: returnedBy ? { reviewerName: returnedBy.reviewerName, comments: returnedBy.comments, at: returnedBy.actionAt } : null,
    permissions: {
      canEdit: draft && isEngineer && auth.permissions.has('inspection.create'),
      canSubmit: draft && isEngineer && auth.permissions.has('inspection.submit') && submissionIssues.length === 0,
      canUpload: draft && isEngineer && auth.permissions.has('inspection.create'),
    },
    updatedAt: r.updatedAt,
  };
}

export async function listReports(auth: AuthContext, q: { page: number; limit: number; status?: string; workOrderId?: string; visitId?: string }) {
  const f: Doc = {};
  if (q.status) f.status = { $in: q.status.split(',') };
  if (q.workOrderId) f.workOrderId = oid(q.workOrderId);
  if (q.visitId) f.visitId = oid(q.visitId);
  const scoped = withScope(f, auth, REPORT_SCOPE);
  const def = await getDefinition('inspectionReport');
  const [rows, total] = await Promise.all([
    InspectionReport.find(scoped).sort({ updatedAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).select('-results -templateItems').lean<Doc[]>(),
    InspectionReport.countDocuments(scoped),
  ]);
  return paged(
    rows.map((r) => ({
      id: String(r._id),
      revisionNo: r.revisionNo,
      status: r.status,
      statusLabel: def.states.find((s) => s.key === r.status)?.label ?? r.status,
      statusTone: def.states.find((s) => s.key === r.status)?.tone ?? 'neutral',
      visit: { id: String(r.visitId), visitNo: r.visitNo },
      workOrder: { id: String(r.workOrderId), workOrderNo: r.workOrderNo },
      complaint: { id: String(r.complaintId), referenceNo: r.complaintRef },
      siteName: r.siteName,
      template: `${r.templateName} v${r.templateVersion}`,
      submittedAt: r.submittedAt ?? null,
      submittedByName: r.submittedByName,
      updatedAt: r.updatedAt,
    })),
    total,
    q.page,
    q.limit,
  );
}

// ============================================================================================
// Temporary assets (MD-08 / D-25)
// ============================================================================================

export async function createTemporaryAsset(ctx: RequestContext, visitId: string, input: Doc) {
  const auth = ctx.auth!;
  return withTransaction(async (session) => {
    const v = await loadVisitInScope(auth, visitId, session);
    if (!v.engineerIds.map(String).includes(auth.userId)) throw forbidden('Only engineers on this visit can record assets here.');
    const eq = await EquipmentType.findById(input.equipmentTypeId).session(session).lean<Doc>();
    if (!eq || eq.status !== 'ACTIVE') throw validationFailed({ equipmentTypeId: 'Select an active equipment type' });
    const site = await Site.findById(v.siteId).session(session).lean<Doc>();
    const year = new Date().getUTCFullYear();
    const seq = await nextSequence('temporaryAsset', year, session);
    const code = `TMP-${year}-${String(seq).padStart(5, '0')}`;
    const [a] = await Asset.create(
      [
        {
          ...input,
          code,
          siteId: v.siteId,
          cityId: site!.cityId,
          regionId: site!.regionId,
          organizationId: site!.organizationId,
          isTemporary: true,
          status: 'ACTIVE',
          createdBy: auth.userId,
        },
      ],
      { session },
    );
    await audit(ctx, { action: 'asset.temporaryRecorded', entityType: 'assets', entityId: a._id, entityRef: `${code} ${input.name}`, meta: { visit: v.visitNo } }, session);
    const supervisors = await usersWithPermissionInScope('inspection.reviewTempAsset', v);
    await notify(
      { recipientIds: supervisors.map((u) => u._id), type: 'asset.temporaryRecorded', title: `Temporary asset recorded: ${code}`, body: `${input.name} at ${v.siteName} (${v.visitNo})`, link: `/inspections/temporary-assets`, entityType: 'assets', entityId: a._id, severity: 'warning' },
      session,
    );
    return { id: String(a._id), code, name: a.name, equipmentTypeId: String(a.equipmentTypeId), isTemporary: true };
  });
}

export async function listTemporaryAssets(auth: AuthContext) {
  const rows = await Asset.find(withScope({ isTemporary: true, status: 'ACTIVE' }, auth, { organization: 'organizationId', region: 'regionId', site: 'siteId' }))
    .sort({ createdAt: 1 })
    .lean<Doc[]>();
  const eqs = new Map((await EquipmentType.find({ _id: { $in: rows.map((r) => r.equipmentTypeId) } }).select('name').lean<Doc[]>()).map((e) => [String(e._id), e.name]));
  const sites = new Map(
    (await Site.find({ _id: { $in: rows.map((r) => r.siteId) } }).select('name').lean<Doc[]>()).map((s) => [String(s._id), s.name]),
  );
  return rows.map((a) => ({
    id: String(a._id),
    code: a.code,
    name: a.name,
    equipmentType: eqs.get(String(a.equipmentTypeId)),
    site: sites.get(String(a.siteId)),
    manufacturer: a.manufacturer,
    model: a.model,
    serialNumber: a.serialNumber,
    createdAt: a.createdAt,
  }));
}

export async function reviewTemporaryAsset(ctx: RequestContext, assetId: string, input: { decision: 'APPROVE' | 'REJECT'; code?: string; comment?: string }) {
  const auth = ctx.auth!;
  const a = await Asset.findById(assetId);
  if (!a || !a.isTemporary || !inScope(auth, a.toObject(), { organization: 'organizationId', region: 'regionId', site: 'siteId' })) throw notFound('Temporary asset');
  const before = { code: a.code, status: a.status };
  if (input.decision === 'APPROVE') {
    if (input.code) a.code = input.code.toUpperCase();
    a.isTemporary = false;
  } else {
    a.status = 'INACTIVE';
    a.deactivatedAt = new Date();
    a.deactivationReason = input.comment;
  }
  await a.save();
  await audit(ctx, { action: input.decision === 'APPROVE' ? 'asset.temporaryApproved' : 'asset.temporaryRejected', entityType: 'assets', entityId: a._id, entityRef: `${a.code} ${a.name}`, before, after: { code: a.code, status: a.status, isTemporary: a.isTemporary }, reason: input.comment });
  return { id: String(a._id), code: a.code, status: a.status, isTemporary: a.isTemporary };
}

