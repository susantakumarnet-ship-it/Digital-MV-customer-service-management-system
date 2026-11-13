import type { ComplaintDetailDto, ComplaintSummaryDto } from '@mv/shared';
import { COMPLAINT_CLOSED_STATUSES } from '@mv/shared';
import type { AuthContext } from '../../common/context';
import { Attachment, toAttachmentDto } from '../../core/storage/attachment.model';
import { availableActions, getDefinition } from '../../core/workflow/workflow.engine';
import { Asset, EquipmentType, Priority, RequestType } from '../masters/master.models';
import { User } from '../users/user.model';
import { Complaint } from './complaint.model';
import { WorkOrder } from '../work-orders/work-order.model';
import { getSettingsGroup } from '../../core/settings/settings.service';

type Doc = Record<string, any>;

export function isOverdue(c: Doc, now = new Date()) {
  return Boolean(c.dueAt && new Date(c.dueAt) < now && !c.resolvedAt && !(COMPLAINT_CLOSED_STATUSES as readonly string[]).includes(c.status));
}

/**
 * Personal contact data is masked for read-only/management roles (HO §11: "mask personal contact
 * information … where full detail is not needed"). Staff who act on complaints, field engineers
 * (who must contact the site) and the customer's own users see it.
 */
export function shouldMaskContact(auth: AuthContext) {
  const p = auth.permissions;
  return !(
    p.has('report.viewPersonalData') ||
    p.has('complaint.update') ||
    p.has('complaint.classify') ||
    p.has('workOrder.accept') ||
    p.has('acceptance.decide')
  );
}

const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, (_m, a, d) => `${a}***${d}`);
const maskPhone = (p: string) => p.replace(/\d(?=(?:\D*\d){3})/g, '•');

async function lookups(rows: Doc[]) {
  const ids = (k: string) => [...new Set(rows.map((r) => r[k]).filter(Boolean).map(String))];
  const [priorities, requestTypes, supervisors, masters] = await Promise.all([
    Priority.find({ _id: { $in: [...ids('priorityId'), ...ids('suggestedPriorityId')] } }).select('name code tone rank').lean<Doc[]>(),
    RequestType.find({ _id: { $in: ids('requestTypeId') } }).select('name code').lean<Doc[]>(),
    User.find({ _id: { $in: ids('supervisorId') } }).select('name').lean<Doc[]>(),
    Complaint.find({ _id: { $in: ids('duplicateOfId') } }).select('referenceNo').lean<Doc[]>(),
  ]);
  const map = (list: Doc[]) => new Map(list.map((x) => [String(x._id), x]));
  return { priorities: map(priorities), requestTypes: map(requestTypes), supervisors: map(supervisors), masters: map(masters) };
}

export async function toSummaries(rows: Doc[]): Promise<ComplaintSummaryDto[]> {
  const def = await getDefinition('complaint');
  const states = new Map(def.states.map((s) => [s.key, s]));
  const lk = await lookups(rows);
  const now = new Date();
  return rows.map((c) => {
    const st = states.get(c.status);
    const pr = c.priorityId ? lk.priorities.get(String(c.priorityId)) : undefined;
    const rt = lk.requestTypes.get(String(c.requestTypeId));
    const sup = c.supervisorId ? lk.supervisors.get(String(c.supervisorId)) : undefined;
    const master = c.duplicateOfId ? lk.masters.get(String(c.duplicateOfId)) : undefined;
    return {
      id: String(c._id),
      referenceNo: c.referenceNo,
      status: c.status,
      statusLabel: st?.label ?? c.status,
      statusTone: st?.tone ?? 'neutral',
      source: c.source,
      customerName: c.customerName,
      organizationName: c.snapshot?.organizationName ?? c.organizationName,
      site: { id: String(c.siteId), name: c.snapshot?.siteName, code: c.snapshot?.siteCode },
      region: { id: String(c.regionId), name: c.snapshot?.regionName },
      city: { id: String(c.cityId), name: c.snapshot?.cityName },
      priority: pr ? { id: String(pr._id), name: pr.name, code: pr.code, tone: pr.tone, rank: pr.rank } : undefined,
      requestType: rt ? { id: String(rt._id), name: rt.name, code: rt.code } : undefined,
      receivedAt: c.receivedAt,
      dueAt: c.dueAt ?? null,
      overdue: isOverdue(c, now),
      supervisor: sup ? { id: String(sup._id), name: sup.name } : null,
      duplicateOf: master ? { id: String(master._id), referenceNo: master.referenceNo } : null,
    } as ComplaintSummaryDto;
  });
}

export async function toDetail(c: Doc, auth: AuthContext): Promise<ComplaintDetailDto> {
  const [summary] = await toSummaries([c]);
  const def = await getDefinition('complaint');
  const labels = new Map(def.states.map((s) => [s.key, s.label]));
  const p = auth.permissions;
  const mask = shouldMaskContact(auth);
  const isCustomer = p.has('acceptance.decide') && !p.has('complaint.classify');

  const [asset, eq, suggested, attachments, duplicates] = await Promise.all([
    c.assetId ? Asset.findById(c.assetId).select('name code').lean<Doc>() : null,
    c.equipmentTypeId ? EquipmentType.findById(c.equipmentTypeId).select('name code').lean<Doc>() : null,
    c.suggestedPriorityId ? Priority.findById(c.suggestedPriorityId).select('name code').lean<Doc>() : null,
    Attachment.find({ ownerType: 'complaint', ownerId: c._id, removedAt: null }).sort({ createdAt: 1 }).lean<Doc[]>(),
    Complaint.find({ _id: { $in: c.linkedDuplicateIds ?? [] } }).select('referenceNo status receivedAt').lean<Doc[]>(),
  ]);
  // Work orders raised against this complaint (Phase 4).
  const [wos, woDef, wfSettings] = await Promise.all([
    WorkOrder.find({ complaintId: c._id }).sort({ createdAt: 1 }).select('workOrderNo title status assigneeIds plannedVisitAt dueAt').lean<Doc[]>(),
    getDefinition('workOrder'),
    getSettingsGroup('workflow'),
  ]);
  const woStates = new Map(woDef.states.map((s) => [s.key, s]));
  const woUsers = new Map(
    (await User.find({ _id: { $in: wos.flatMap((w) => w.assigneeIds ?? []) } }).select('name').lean<Doc[]>()).map((u) => [String(u._id), u.name]),
  );
  const activeWos = wos.filter((w) => w.status !== 'CANCELLED').length;
  const canCreateWorkOrder =
    p.has('workOrder.create') &&
    Boolean(c.classifiedAt && c.priorityId) &&
    ['UNDER_REVIEW', 'REOPENED', 'ASSIGNED', 'IN_PROGRESS'].includes(c.status) &&
    (wfSettings.allowMultipleWorkOrdersPerComplaint || activeWos === 0);

  // Customers never see staff workflow actions.
  const actions = isCustomer ? [] : await availableActions('complaint', c as never, { auth });
  const locked = (def.states.find((s) => s.key === c.status)?.locked ?? false) as boolean;
  const editableStatus = ['NEW', 'UNDER_REVIEW', 'AWAITING_CUSTOMER_INFO', 'REOPENED'].includes(c.status);

  return {
    ...summary,
    contactPerson: c.contactPerson,
    mobile: mask ? maskPhone(c.mobile) : c.mobile,
    email: mask ? maskEmail(c.email) : c.email,
    contactMasked: mask,
    customerOrganization: { id: String(c.organizationId), name: c.snapshot?.organizationName },
    asset: asset ? { id: String(asset._id), name: asset.name, code: asset.code } : null,
    equipmentType: eq ? { id: String(eq._id), name: eq.name, code: eq.code } : null,
    suggestedPriority: suggested ? { id: String(suggested._id), name: suggested.name, code: suggested.code } : null,
    description: c.description,
    category: c.category,
    classification: c.classifiedAt
      ? { classifiedAt: c.classifiedAt, classifiedByName: c.classifiedByName, notes: p.has('complaint.readInternal') ? c.classificationNotes : undefined }
      : null,
    acknowledgedAt: c.acknowledgedAt ?? null,
    consent: { accepted: Boolean(c.consent?.accepted), version: c.consent?.version, at: c.consent?.at },
    attachments: attachments
      .filter((a) => !isCustomer || a.context !== 'internal')
      .map((a) => toAttachmentDto(a) as never),
    internalNotes: p.has('complaint.readInternal')
      ? (c.internalNotes ?? []).map((n: Doc) => ({ id: String(n._id), text: n.text, byName: n.byName, at: n.at }))
      : undefined,
    customerMessages: (c.customerMessages ?? []).map((m: Doc) => ({
      id: String(m._id),
      direction: m.direction,
      text: m.text,
      byName: m.byName,
      at: m.at,
    })),
    linkedDuplicates: duplicates.map((d) => ({ id: String(d._id), referenceNo: d.referenceNo, status: d.status, receivedAt: d.receivedAt })),
    workOrders: isCustomer
      ? []
      : wos.map((w) => ({
          id: String(w._id),
          workOrderNo: w.workOrderNo,
          title: w.title,
          status: w.status,
          statusLabel: woStates.get(w.status)?.label ?? w.status,
          statusTone: woStates.get(w.status)?.tone ?? 'neutral',
          assignees: (w.assigneeIds ?? []).map((a: unknown) => woUsers.get(String(a)) ?? 'Unknown'),
          plannedVisitAt: w.plannedVisitAt ?? null,
          dueAt: w.dueAt ?? null,
        })),
    statusHistory: (c.statusHistory ?? []).map((h: Doc) => ({
      from: h.from,
      to: h.to,
      toLabel: labels.get(h.to) ?? h.to,
      action: h.action,
      byName: h.byName,
      at: h.at,
      reason: h.reason,
    })),
    availableActions: actions,
    permissions: {
      canEdit: p.has('complaint.update') && editableStatus && !locked,
      canClassify: p.has('complaint.classify') && editableStatus,
      canAddNote: p.has('complaint.update'),
      canAttach: !locked && (p.has('complaint.update') || (isCustomer && c.status !== 'CLOSED')),
      canRespond: isCustomer && c.status === 'AWAITING_CUSTOMER_INFO',
      canCreateWorkOrder,
    },
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  } as ComplaintDetailDto;
}
