import { randomUUID } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import { AUDIT_ACTIONS, type MaterialLineDto, type MaterialRequestCreateInput, type MaterialRequestDetailDto, type MaterialRequestSummaryDto } from '@mv/shared';
import type { AuthContext, RequestContext } from '../../common/context';
import { conflict, forbidden, notFound, validationFailed } from '../../common/errors';
import { paged, parseSort } from '../../common/http/route';
import { audit } from '../../core/audit/audit.service';
import { nextReference } from '../../core/counters/counter.service';
import { notify } from '../../core/notifications/notification.service';
import { usersWithPermissionInScope } from '../../core/notifications/recipients';
import { inScope, withScope } from '../../core/scope/scope.service';
import { Attachment, toAttachmentDto } from '../../core/storage/attachment.model';
import { storeFiles, validateFiles, type IncomingFile } from '../../core/storage/upload.service';
import { availableActions, getDefinition, registerGuard, transition as wfTransition } from '../../core/workflow/workflow.engine';
import { withTransaction } from '../../db/transaction';
import { InventoryItem, Warehouse } from '../masters/master.models';
import { Visit } from '../visits/visit.models';
import { WORK_ORDER_SCOPE, WorkOrder } from '../work-orders/work-order.model';
import { applyStock, toTransactionDtos } from './inventory.service';
import { MATERIAL_SCOPE, MaterialRequest, StockTransaction } from './material.models';

type Doc = Record<string, any>;
const oid = (v: unknown) => new Types.ObjectId(String(v));
const EDITABLE = ['DRAFT', 'CLARIFICATION_REQUIRED'];
const ISSUABLE = ['APPROVED', 'PARTIALLY_ISSUED'];
const round = (n: number) => Math.round(n * 1000) / 1000;

// ---- Access & guards --------------------------------------------------------------------------------

export async function loadRequestInScope(auth: AuthContext, id: string, session?: ClientSession) {
  const r = await MaterialRequest.findById(id).session(session ?? null);
  if (!r || !inScope(auth, r.toObject(), MATERIAL_SCOPE)) throw notFound('Material request');
  return r;
}

export async function canAccessRequest(auth: AuthContext, id: string) {
  if (!auth.permissions.has('material.read')) return false;
  const r = await MaterialRequest.findById(id).select('organizationId regionId siteId requesterId').lean();
  return Boolean(r && inScope(auth, r, MATERIAL_SCOPE));
}

/** Issue evidence is attached to the stock transaction; access follows its material request. */
export async function canAccessTransactionEvidence(auth: AuthContext, transactionId: string) {
  const t = await StockTransaction.findById(transactionId).select('referenceType referenceId').lean<Doc>();
  return Boolean(t && t.referenceType === 'materialRequest' && (await canAccessRequest(auth, String(t.referenceId))));
}

export function registerMaterialGuards() {
  registerGuard('actorIsRequester', ({ record, ctx }) => (String(record.requesterId) === ctx.auth?.userId ? null : 'Only the requester can submit this request.'));
  registerGuard('hasLines', ({ record }) => ((record.lines as unknown[])?.length ? null : 'Add at least one item.'));
  // MAT-07 / HO §3: approvers (incl. storekeepers with approval rights) never decide their own requests.
  registerGuard('notOwnRequest', ({ record, ctx }) => (String(record.requesterId) === ctx.auth?.userId ? 'You cannot decide your own material request.' : null));
  registerGuard('noOutstandingReservations', ({ record }) => {
    const reserved = (record.lines as Doc[]).reduce((a, l) => a + (l.reservations ?? []).reduce((b: number, x: Doc) => b + x.quantity, 0), 0);
    return reserved > 0 ? 'Release or issue the reserved stock before closing.' : null;
  });
  // Complaint "resolve" (BR-016): material obligations must be finished or disposed.
  registerGuard('materialObligationsComplete', async ({ record, session }) => {
    const open = await MaterialRequest.find({
      complaintId: record._id,
      status: { $in: ['SUBMITTED', 'CLARIFICATION_REQUIRED', 'APPROVED', 'PARTIALLY_ISSUED'] },
    })
      .select('requestNo')
      .session(session ?? null)
      .lean<Doc[]>();
    return open.length ? `Material requests still open: ${open.map((o) => o.requestNo).join(', ')}.` : null;
  });
}

// ---- Create / edit / submit ------------------------------------------------------------------------

async function buildLines(lines: { itemId: string; quantity: number; specification?: string; reason?: string }[], session?: ClientSession) {
  const items = await InventoryItem.find({ _id: { $in: lines.map((l) => l.itemId) } }).session(session ?? null).lean<Doc[]>();
  const map = new Map(items.map((i) => [String(i._id), i]));
  const fields: Record<string, string> = {};
  const out = lines.map((l, i) => {
    const it = map.get(l.itemId);
    if (!it || it.status !== 'ACTIVE') fields[`lines.${i}.itemId`] = 'Select an active catalogue item';
    return {
      lineId: randomUUID().slice(0, 8),
      itemId: oid(l.itemId),
      itemCode: it?.code,
      itemName: it?.name,
      unit: it?.unit,
      specification: l.specification ?? it?.specification,
      reason: l.reason,
      quantity: l.quantity,
    };
  });
  if (Object.keys(fields).length) throw validationFailed(fields);
  return out;
}

async function notifyApprovers(r: Doc, session: ClientSession, exclude: string) {
  const approvers = (await usersWithPermissionInScope('material.approve', r)).filter((u) => String(u._id) !== exclude);
  await notify(
    { recipientIds: approvers.map((u) => u._id), type: 'materialRequest.submitted', title: `Material request ${r.requestNo} submitted`, body: `${r.workOrderNo} — ${r.lines.length} item(s), urgency ${r.urgency}`, link: `/materials/${r._id}`, entityType: 'materialRequest', entityId: r._id, severity: r.urgency === 'CRITICAL' ? 'danger' : 'info' },
    session,
  );
}

export async function createRequest(ctx: RequestContext, input: MaterialRequestCreateInput) {
  const auth = ctx.auth!;
  const saved = await withTransaction(async (session) => {
    const w = await WorkOrder.findById(input.workOrderId).session(session);
    if (!w || !inScope(auth, w.toObject(), WORK_ORDER_SCOPE)) throw notFound('Work order');
    if (!w.assigneeIds.map(String).includes(auth.userId)) throw forbidden('Only engineers assigned to the work order can request material.');
    if (['DRAFT', 'CLOSED', 'CANCELLED', 'APPROVED'].includes(w.status)) throw conflict('Material cannot be requested at this stage of the work order.', 'INVALID_STATE');
    let visit: Doc | null = null;
    if (input.visitId) {
      visit = await Visit.findOne({ _id: input.visitId, workOrderId: w._id }).session(session).lean<Doc>();
      if (!visit) throw validationFailed({ visitId: 'Select a visit of this work order' });
    }
    const requestNo = await nextReference('materialRequest', session);
    const now = new Date();
    const [r] = await MaterialRequest.create(
      [
        {
          requestNo,
          workOrderId: w._id,
          workOrderNo: w.workOrderNo,
          visitId: visit?._id,
          visitNo: visit?.visitNo,
          complaintId: w.complaintId,
          complaintRef: w.complaintRef,
          organizationId: w.organizationId,
          regionId: w.regionId,
          siteId: w.siteId,
          siteName: w.snapshot?.siteName,
          requesterId: auth.userId,
          requesterName: auth.name,
          urgency: input.urgency,
          reason: input.reason,
          neededBy: input.neededBy,
          lines: await buildLines(input.lines, session),
          status: 'DRAFT',
          statusHistory: [{ to: 'DRAFT', action: 'create', by: auth.userId, byName: auth.name, at: now }],
        },
      ],
      { session },
    );
    await audit(ctx, { action: AUDIT_ACTIONS.CREATE, entityType: 'materialRequest', entityId: r._id, entityRef: requestNo, after: { workOrder: w.workOrderNo, lines: input.lines.length, urgency: input.urgency } }, session);
    if (input.submit) {
      await wfTransition({ entity: 'materialRequest', record: r as never, action: 'submit', ctx, session, entityRef: requestNo });
      r.submittedAt = now;
      await r.save({ session });
      await notifyApprovers(r.toObject(), session, auth.userId);
    }
    return r;
  });
  return getRequest(auth, String(saved._id));
}

export async function updateRequest(ctx: RequestContext, id: string, input: Doc) {
  const auth = ctx.auth!;
  await withTransaction(async (session) => {
    const r = await loadRequestInScope(auth, id, session);
    if (String(r.requesterId) !== auth.userId) throw forbidden('Only the requester can edit this request.');
    if (!EDITABLE.includes(r.status)) throw conflict('This request can no longer be edited.', 'INVALID_STATE');
    const before = { urgency: r.urgency, reason: r.reason, lines: r.lines.length };
    if (input.urgency) r.urgency = input.urgency;
    if (input.reason) r.reason = input.reason;
    if (input.neededBy !== undefined) r.neededBy = input.neededBy ?? undefined;
    if (input.lines) r.lines = (await buildLines(input.lines, session)) as never;
    if (input.clarificationReply) r.messages.push({ direction: 'FROM_REQUESTER', text: input.clarificationReply, by: auth.userId, byName: auth.name, at: new Date() } as never);
    await r.save({ session });
    await audit(ctx, { action: AUDIT_ACTIONS.UPDATE, entityType: 'materialRequest', entityId: r._id, entityRef: r.requestNo, before, after: { urgency: r.urgency, reason: r.reason, lines: r.lines.length } }, session);
  });
  return getRequest(auth, id);
}

export async function submitRequest(ctx: RequestContext, id: string) {
  const auth = ctx.auth!;
  await withTransaction(async (session) => {
    const r = await loadRequestInScope(auth, id, session);
    await wfTransition({ entity: 'materialRequest', record: r as never, action: 'submit', ctx, session, entityRef: r.requestNo });
    r.submittedAt = new Date();
    await r.save({ session });
    await notifyApprovers(r.toObject(), session, auth.userId);
  });
  return getRequest(auth, id);
}

// ---- Decisions (MAT-02, BR-013) --------------------------------------------------------------------

export async function decideRequest(ctx: RequestContext, id: string, input: { decision: 'APPROVE' | 'REJECT' | 'CLARIFY'; comment?: string; lines?: { lineId: string; approvedQty: number }[] }) {
  const auth = ctx.auth!;
  await withTransaction(async (session) => {
    const r = await loadRequestInScope(auth, id, session);
    const now = new Date();
    const action = input.decision === 'APPROVE' ? 'approve' : input.decision === 'REJECT' ? 'reject' : 'requestClarification';
    let approvedLines: { lineId: string; approvedQty: number }[] | undefined;
    if (input.decision === 'APPROVE') {
      const overrides = new Map((input.lines ?? []).map((l) => [l.lineId, l.approvedQty]));
      for (const l of input.lines ?? []) {
        const line = r.lines.find((x) => x.lineId === l.lineId);
        if (!line) throw validationFailed({ lines: `Unknown line ${l.lineId}` });
        if (l.approvedQty > line.quantity) throw validationFailed({ lines: `Approved quantity for ${line.itemName} cannot exceed the requested ${line.quantity}. Use a revised approval later if more is needed.` });
      }
      for (const line of r.lines) line.approvedQty = overrides.get(line.lineId) ?? line.quantity;
      if (r.lines.every((l) => (l.approvedQty ?? 0) === 0)) throw validationFailed({ lines: 'Approve at least one quantity, or reject the request.' });
      approvedLines = r.lines.map((l) => ({ lineId: l.lineId, approvedQty: l.approvedQty ?? 0 }));
      r.approvedAt = now;
    }
    await wfTransition({ entity: 'materialRequest', record: r as never, action, ctx, reason: input.comment, session, entityRef: r.requestNo });
    r.decisions.push({ decision: input.decision, by: auth.userId, byName: auth.name, at: now, comment: input.comment, lines: approvedLines } as never);
    if (input.decision === 'CLARIFY') r.messages.push({ direction: 'TO_REQUESTER', text: input.comment, by: auth.userId, byName: auth.name, at: now } as never);
    await r.save({ session });
    await notify(
      {
        recipientIds: [r.requesterId],
        type: input.decision === 'APPROVE' ? 'materialRequest.approved' : input.decision === 'REJECT' ? 'materialRequest.rejected' : 'materialRequest.clarification',
        title: `${r.requestNo} ${input.decision === 'APPROVE' ? 'approved' : input.decision === 'REJECT' ? 'rejected' : 'needs clarification'}`,
        body: input.comment ?? '',
        link: `/materials/${r._id}`,
        entityType: 'materialRequest',
        entityId: r._id,
        severity: input.decision === 'APPROVE' ? 'success' : 'warning',
      },
      session,
    );
    if (input.decision === 'APPROVE') {
      const store = await usersWithPermissionInScope('inventory.issue', r);
      await notify({ recipientIds: store.map((u) => u._id), type: 'materialRequest.readyToIssue', title: `Ready to issue: ${r.requestNo}`, body: `${r.siteName ?? ''} — urgency ${r.urgency}`, link: `/materials/${r._id}`, entityType: 'materialRequest', entityId: r._id }, session);
    }
  });
  return getRequest(auth, id);
}

/** BR-013: increase/decrease the approved quantity of a line after approval — approver only, with a reason. */
export async function reviseApproval(ctx: RequestContext, id: string, input: { lineId: string; approvedQty: number; reason: string }) {
  const auth = ctx.auth!;
  await withTransaction(async (session) => {
    const r = await loadRequestInScope(auth, id, session);
    if (!ISSUABLE.includes(r.status)) throw conflict('Approved quantities can only be revised while the request is approved or partially issued.', 'INVALID_STATE');
    if (String(r.requesterId) === auth.userId) throw forbidden('You cannot approve your own material request.', 'SELF_APPROVAL');
    const line = r.lines.find((l) => l.lineId === input.lineId);
    if (!line) throw validationFailed({ lineId: 'Unknown line' });
    const reserved = (line.reservations ?? []).reduce((a, x) => a + (x.quantity ?? 0), 0);
    if (input.approvedQty < line.issuedQty + reserved) {
      throw validationFailed({ approvedQty: `Cannot go below what is already issued and reserved (${round(line.issuedQty + reserved)} ${line.unit}).` });
    }
    const before = line.approvedQty;
    line.approvedQty = input.approvedQty;
    r.decisions.push({ decision: 'REVISE', by: auth.userId, byName: auth.name, at: new Date(), comment: input.reason, lines: [{ lineId: line.lineId, approvedQty: input.approvedQty }] } as never);
    await reconcileStatus(ctx, r, session);
    await r.save({ session });
    await audit(ctx, { action: 'materialRequest.approvalRevised', entityType: 'materialRequest', entityId: r._id, entityRef: r.requestNo, before: { [line.itemCode ?? line.lineId]: before }, after: { [line.itemCode ?? line.lineId]: input.approvedQty }, reason: input.reason }, session);
  });
  return getRequest(auth, id);
}

// ---- Store operations (MAT-03/04) -----------------------------------------------------------------

function lineOf(r: Doc, lineId: string) {
  const line = r.lines.find((l: Doc) => l.lineId === lineId);
  if (!line) throw validationFailed({ lineId: 'Unknown line' });
  return line;
}
const reservedTotal = (line: Doc) => (line.reservations ?? []).reduce((a: number, x: Doc) => a + (x.quantity ?? 0), 0);

async function assertWarehouse(warehouseId: string, session: ClientSession) {
  const wh = await Warehouse.findById(warehouseId).session(session).lean<Doc>();
  if (!wh || wh.status !== 'ACTIVE') throw validationFailed({ warehouseId: 'Select an active warehouse' });
  return wh;
}

/** Status follows the lines: fully issued → Issued; some issued → Partially Issued. */
async function reconcileStatus(ctx: RequestContext, r: Doc, session: ClientSession) {
  const approvedLines = r.lines.filter((l: Doc) => (l.approvedQty ?? 0) > 0);
  const anyIssued = r.lines.some((l: Doc) => l.issuedQty > 0);
  const allIssued = approvedLines.length > 0 && approvedLines.every((l: Doc) => round(l.issuedQty) >= round(l.approvedQty));
  if (allIssued && r.status !== 'ISSUED' && ISSUABLE.includes(r.status)) {
    await wfTransition({ entity: 'materialRequest', record: r as never, action: 'issue', ctx, session, system: true, entityRef: r.requestNo });
  } else if (!allIssued && anyIssued && r.status === 'APPROVED') {
    await wfTransition({ entity: 'materialRequest', record: r as never, action: 'partialIssue', ctx, session, system: true, entityRef: r.requestNo });
  }
}

export async function reserve(ctx: RequestContext, id: string, input: { lineId: string; warehouseId: string; quantity: number }) {
  const auth = ctx.auth!;
  await withTransaction(async (session) => {
    const r = await loadRequestInScope(auth, id, session);
    if (!ISSUABLE.includes(r.status)) throw conflict('Stock can only be reserved for approved requests.', 'INVALID_STATE');
    const line = lineOf(r, input.lineId);
    await assertWarehouse(input.warehouseId, session);
    const room = round((line.approvedQty ?? 0) - line.issuedQty - reservedTotal(line));
    if (input.quantity > room) throw validationFailed({ quantity: `At most ${room} ${line.unit} can still be reserved for this line (approved minus issued and reserved).` });
    await applyStock(ctx, { type: 'RESERVE', itemId: line.itemId, warehouseId: input.warehouseId, quantity: input.quantity, reference: { type: 'materialRequest', id: r._id, label: r.requestNo }, lineId: line.lineId }, session);
    const res = line.reservations.find((x: Doc) => String(x.warehouseId) === input.warehouseId);
    if (res) res.quantity = round(res.quantity + input.quantity);
    else line.reservations.push({ warehouseId: oid(input.warehouseId), quantity: input.quantity });
    await r.save({ session });
    await audit(ctx, { action: 'materialRequest.reserved', entityType: 'materialRequest', entityId: r._id, entityRef: r.requestNo, after: { item: line.itemCode, quantity: input.quantity, warehouseId: input.warehouseId } }, session);
  });
  return getRequest(auth, id);
}

export async function unreserve(ctx: RequestContext, id: string, input: { lineId: string; warehouseId: string; quantity: number; reason: string }) {
  const auth = ctx.auth!;
  await withTransaction(async (session) => {
    const r = await loadRequestInScope(auth, id, session);
    const line = lineOf(r, input.lineId);
    const res = line.reservations.find((x: Doc) => String(x.warehouseId) === input.warehouseId);
    if (!res || res.quantity < input.quantity) throw validationFailed({ quantity: 'Cannot release more than is reserved in that warehouse for this line.' });
    await applyStock(ctx, { type: 'UNRESERVE', itemId: line.itemId, warehouseId: input.warehouseId, quantity: input.quantity, reason: input.reason, reference: { type: 'materialRequest', id: r._id, label: r.requestNo }, lineId: line.lineId }, session);
    res.quantity = round(res.quantity - input.quantity);
    line.reservations = line.reservations.filter((x: Doc) => x.quantity > 0);
    await r.save({ session });
  });
  return getRequest(auth, id);
}

export async function issue(
  ctx: RequestContext,
  id: string,
  input: { lineId: string; warehouseId: string; quantity: number; batchNo?: string; serialNumbers: string[]; recipientName: string; recipientUserId?: string; note?: string },
  files: IncomingFile[],
) {
  const auth = ctx.auth!;
  const validated = await validateFiles(files);
  await withTransaction(async (session) => {
    const r = await loadRequestInScope(auth, id, session);
    if (!ISSUABLE.includes(r.status)) throw conflict('Only approved requests can be issued.', 'INVALID_STATE');
    const line = lineOf(r, input.lineId);
    await assertWarehouse(input.warehouseId, session);
    // BR-013: never issue more than approved without a revised approval.
    const outstanding = round((line.approvedQty ?? 0) - line.issuedQty);
    if (input.quantity > outstanding) {
      throw conflict(`Only ${outstanding} ${line.unit} remain approved for this line. Ask a supervisor for a revised approval to issue more.`, 'EXCEEDS_APPROVED', { outstanding });
    }
    if (input.serialNumbers.length && input.serialNumbers.length !== input.quantity) {
      throw validationFailed({ serialNumbers: `Enter one serial number per unit (${input.quantity}).` });
    }
    const res = line.reservations.find((x: Doc) => String(x.warehouseId) === input.warehouseId);
    const fromRes = Math.min(res?.quantity ?? 0, input.quantity);
    const t = await applyStock(
      ctx,
      {
        type: 'ISSUE',
        itemId: line.itemId,
        warehouseId: input.warehouseId,
        quantity: input.quantity,
        consumeReserved: fromRes,
        reference: { type: 'materialRequest', id: r._id, label: r.requestNo },
        lineId: line.lineId,
        batchNo: input.batchNo,
        serialNumbers: input.serialNumbers,
        recipientName: input.recipientName,
        recipientUserId: input.recipientUserId,
        reason: input.note,
      },
      session,
    );
    if (res) {
      res.quantity = round(res.quantity - fromRes);
      line.reservations = line.reservations.filter((x: Doc) => x.quantity > 0);
    }
    line.issuedQty = round(line.issuedQty + input.quantity);
    line.backorderQty = Math.max(0, round(line.backorderQty - input.quantity));
    if (validated.length) await storeFiles(ctx, validated, { type: 'stockTransaction', id: t._id, context: 'handover' }, { type: 'USER' }, session);
    await reconcileStatus(ctx, r, session);
    await r.save({ session });
    await audit(ctx, { action: 'materialRequest.issued', entityType: 'materialRequest', entityId: r._id, entityRef: r.requestNo, after: { item: line.itemCode, quantity: input.quantity, warehouseId: input.warehouseId, recipient: input.recipientName, batchNo: input.batchNo, serials: input.serialNumbers.length, evidence: validated.length } }, session);
    await notify({ recipientIds: [r.requesterId], type: 'materialRequest.issued', title: `Material issued: ${r.requestNo}`, body: `${input.quantity} ${line.unit} ${line.itemName} — received by ${input.recipientName}`, link: `/materials/${r._id}`, entityType: 'materialRequest', entityId: r._id, severity: 'success' }, session);
  });
  return getRequest(auth, id);
}

export async function recordBackorder(ctx: RequestContext, id: string, input: { lineId: string; quantity: number; expectedAt?: Date; note?: string }) {
  const auth = ctx.auth!;
  await withTransaction(async (session) => {
    const r = await loadRequestInScope(auth, id, session);
    if (!ISSUABLE.includes(r.status)) throw conflict('Backorders apply to approved requests.', 'INVALID_STATE');
    const line = lineOf(r, input.lineId);
    const max = round((line.approvedQty ?? 0) - line.issuedQty);
    if (input.quantity > max) throw validationFailed({ quantity: `Backorder cannot exceed the outstanding ${max} ${line.unit}.` });
    line.backorderQty = input.quantity;
    line.backorderExpectedAt = input.expectedAt;
    line.backorderNote = input.note;
    await r.save({ session });
    await audit(ctx, { action: 'materialRequest.backorder', entityType: 'materialRequest', entityId: r._id, entityRef: r.requestNo, after: { item: line.itemCode, quantity: input.quantity, expectedAt: input.expectedAt }, reason: input.note }, session);
    await notify({ recipientIds: [r.requesterId], type: 'materialRequest.backorder', title: `Backorder on ${r.requestNo}`, body: `${input.quantity} ${line.unit} ${line.itemName}${input.expectedAt ? ` expected ${input.expectedAt.toDateString()}` : ''}`, link: `/materials/${r._id}`, entityType: 'materialRequest', entityId: r._id, severity: 'warning' }, session);
  });
  return getRequest(auth, id);
}

export async function returnMaterial(ctx: RequestContext, id: string, input: { lineId: string; warehouseId: string; goodQty: number; damagedQty: number; reason: string }) {
  const auth = ctx.auth!;
  await withTransaction(async (session) => {
    const r = await loadRequestInScope(auth, id, session);
    if (!['PARTIALLY_ISSUED', 'ISSUED', 'RETURNED'].includes(r.status)) throw conflict('Only issued material can be returned.', 'INVALID_STATE');
    const line = lineOf(r, input.lineId);
    await assertWarehouse(input.warehouseId, session);
    const returnable = round(line.issuedQty - line.returnedQty - line.damagedQty);
    if (input.goodQty + input.damagedQty > returnable) throw validationFailed({ goodQty: `At most ${returnable} ${line.unit} can be returned for this line.` });
    const ref = { type: 'materialRequest', id: r._id, label: r.requestNo };
    if (input.goodQty > 0) await applyStock(ctx, { type: 'RETURN', itemId: line.itemId, warehouseId: input.warehouseId, quantity: input.goodQty, reason: input.reason, reference: ref, lineId: line.lineId }, session);
    if (input.damagedQty > 0) await applyStock(ctx, { type: 'DAMAGE', itemId: line.itemId, warehouseId: input.warehouseId, quantity: input.damagedQty, reason: input.reason, reference: ref, lineId: line.lineId }, session);
    line.returnedQty = round(line.returnedQty + input.goodQty);
    line.damagedQty = round(line.damagedQty + input.damagedQty);
    // Everything issued has come back → Returned.
    const allBack = r.lines.every((l: Doc) => l.issuedQty === 0 || round(l.returnedQty + l.damagedQty) >= round(l.issuedQty));
    if (allBack && r.status !== 'RETURNED') await wfTransition({ entity: 'materialRequest', record: r as never, action: 'returnMaterial', ctx, session, system: true, entityRef: r.requestNo });
    await r.save({ session });
    await audit(ctx, { action: 'materialRequest.returned', entityType: 'materialRequest', entityId: r._id, entityRef: r.requestNo, after: { item: line.itemCode, good: input.goodQty, damaged: input.damagedQty }, reason: input.reason }, session);
  });
  return getRequest(auth, id);
}

export async function closeRequest(ctx: RequestContext, id: string, reason?: string) {
  const auth = ctx.auth!;
  await withTransaction(async (session) => {
    const r = await loadRequestInScope(auth, id, session);
    await wfTransition({ entity: 'materialRequest', record: r as never, action: 'close', ctx, reason, session, entityRef: r.requestNo });
    r.closedAt = new Date();
    await r.save({ session });
  });
  return getRequest(auth, id);
}

// ---- Read models --------------------------------------------------------------------------------

async function summaries(rows: Doc[]): Promise<MaterialRequestSummaryDto[]> {
  const def = await getDefinition('materialRequest');
  return rows.map((r) => {
    const st = def.states.find((s) => s.key === r.status);
    return {
      id: String(r._id),
      requestNo: r.requestNo,
      status: r.status,
      statusLabel: st?.label ?? r.status,
      statusTone: st?.tone ?? 'neutral',
      urgency: r.urgency,
      workOrder: { id: String(r.workOrderId), workOrderNo: r.workOrderNo },
      complaint: { id: String(r.complaintId), referenceNo: r.complaintRef },
      site: { id: String(r.siteId), name: r.siteName },
      requester: { id: String(r.requesterId), name: r.requesterName },
      lineCount: r.lines?.length ?? 0,
      outstandingLines: (r.lines ?? []).filter((l: Doc) => (l.approvedQty ?? 0) - l.issuedQty > 0).length,
      neededBy: r.neededBy ?? null,
      submittedAt: r.submittedAt ?? null,
      createdAt: r.createdAt,
    };
  });
}

export async function listRequests(auth: AuthContext, q: { page: number; limit: number; sort?: string; status?: string; workOrderId?: string; complaintId?: string; mine?: string; urgency?: string; store?: string; q?: string }) {
  const f: Doc = {};
  if (q.status) f.status = { $in: q.status.split(',') };
  if (q.store === 'true') f.status = { $in: ISSUABLE };
  if (q.workOrderId) f.workOrderId = oid(q.workOrderId);
  if (q.complaintId) f.complaintId = oid(q.complaintId);
  if (q.mine === 'true') f.requesterId = oid(auth.userId);
  if (q.urgency) f.urgency = q.urgency;
  if (q.q) {
    const rx = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    f.$or = [{ requestNo: rx }, { workOrderNo: rx }, { complaintRef: rx }, { 'lines.itemName': rx }, { 'lines.itemCode': rx }];
  }
  const scoped = withScope(f, auth, MATERIAL_SCOPE);
  // Urgency sorts by severity (urgencyRank), not alphabetically; the store queue defaults to most urgent, then oldest.
  const sortParam = q.sort === 'urgency' ? 'urgencyRank' : q.sort === '-urgency' ? '-urgencyRank' : q.sort;
  const fallback: Record<string, 1 | -1> = q.store === 'true' ? { urgencyRank: 1, submittedAt: 1 } : { createdAt: -1 };
  const sort = parseSort(sortParam, ['createdAt', 'submittedAt', 'requestNo', 'urgencyRank', 'neededBy'], fallback);
  const [rows, total] = await Promise.all([
    MaterialRequest.find(scoped).sort(sort).skip((q.page - 1) * q.limit).limit(q.limit).lean<Doc[]>(),
    MaterialRequest.countDocuments(scoped),
  ]);
  return paged(await summaries(rows), total, q.page, q.limit);
}

export async function getRequest(auth: AuthContext, id: string): Promise<MaterialRequestDetailDto> {
  const r = (await loadRequestInScope(auth, id)).toObject() as Doc;
  const [summary] = await summaries([r]);
  const [def, txRows, whs, items] = await Promise.all([
    getDefinition('materialRequest'),
    StockTransaction.find({ referenceType: 'materialRequest', referenceId: r._id }).sort({ transactionAt: 1 }).lean<Doc[]>(),
    Warehouse.find({ _id: { $in: r.lines.flatMap((l: Doc) => (l.reservations ?? []).map((x: Doc) => x.warehouseId)) } }).select('name code').lean<Doc[]>(),
    InventoryItem.find({ _id: { $in: r.lines.map((l: Doc) => l.itemId) } }).select('name code unit specification').lean<Doc[]>(),
  ]);
  const whMap = new Map(whs.map((w) => [String(w._id), w]));
  const itemMap = new Map(items.map((i) => [String(i._id), i]));
  const transactions = await toTransactionDtos(txRows);
  const evidence = await Attachment.find({ ownerType: 'stockTransaction', ownerId: { $in: txRows.map((t) => t._id) }, removedAt: null }).lean<Doc[]>();
  const lines: MaterialLineDto[] = r.lines.map((l: Doc) => {
    const it = itemMap.get(String(l.itemId));
    return {
      lineId: l.lineId,
      item: { id: String(l.itemId), name: it?.name ?? l.itemName, code: it?.code ?? l.itemCode, unit: it?.unit ?? l.unit, specification: it?.specification },
      specification: l.specification,
      reason: l.reason,
      quantity: l.quantity,
      approvedQty: l.approvedQty ?? null,
      reservedQty: reservedTotal(l),
      issuedQty: l.issuedQty,
      returnedQty: l.returnedQty,
      damagedQty: l.damagedQty,
      backorderQty: l.backorderQty,
      backorderExpectedAt: l.backorderExpectedAt ?? null,
      outstandingQty: Math.max(0, round((l.approvedQty ?? 0) - l.issuedQty)),
      reservations: (l.reservations ?? []).map((x: Doc) => ({ warehouse: { id: String(x.warehouseId), name: whMap.get(String(x.warehouseId))?.name ?? 'Unknown', code: whMap.get(String(x.warehouseId))?.code }, quantity: x.quantity })),
    };
  });
  const p = auth.permissions;
  const isRequester = String(r.requesterId) === auth.userId;
  const actions = (await availableActions('materialRequest', r as never, { auth })).filter((a) => !(['approve', 'reject', 'requestClarification'].includes(a.action) && isRequester));
  return {
    ...summary,
    reason: r.reason,
    visit: r.visitId ? { id: String(r.visitId), visitNo: r.visitNo } : null,
    lines,
    decisions: (r.decisions ?? []).map((d: Doc) => ({ decision: d.decision, byName: d.byName, at: d.at, comment: d.comment, lines: d.lines })),
    messages: (r.messages ?? []).map((m: Doc) => ({ direction: m.direction, text: m.text, byName: m.byName, at: m.at })),
    transactions,
    attachments: evidence.map((e) => toAttachmentDto(e) as never),
    statusHistory: (r.statusHistory ?? []).map((h: Doc) => ({ from: h.from, to: h.to, toLabel: def.states.find((s) => s.key === h.to)?.label ?? h.to, action: h.action, byName: h.byName, at: h.at, reason: h.reason })),
    availableActions: actions,
    permissions: {
      canEdit: isRequester && EDITABLE.includes(r.status),
      canSubmit: isRequester && EDITABLE.includes(r.status) && p.has('material.create'),
      canDecide: r.status === 'SUBMITTED' && p.has('material.approve') && !isRequester,
      canReviseApproval: ISSUABLE.includes(r.status) && p.has('material.approve') && !isRequester,
      canIssue: ISSUABLE.includes(r.status) && p.has('inventory.issue'),
      canReturn: ['PARTIALLY_ISSUED', 'ISSUED', 'RETURNED'].includes(r.status) && p.has('inventory.issue'),
      canClose: ['ISSUED', 'PARTIALLY_ISSUED', 'RETURNED'].includes(r.status) && p.has('material.approve'),
      reasonIfNotDecide: isRequester && r.status === 'SUBMITTED' ? 'You cannot decide your own request.' : undefined,
    },
  };
}

export async function materialSummary(auth: AuthContext) {
  const scope = withScope({}, auth, MATERIAL_SCOPE);
  const by = await MaterialRequest.aggregate<{ _id: string; n: number }>([{ $match: scope }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const s = Object.fromEntries(by.map((b) => [b._id, b.n]));
  const critical = await MaterialRequest.countDocuments({ $and: [scope, { status: { $in: ['SUBMITTED', ...ISSUABLE] }, urgency: 'CRITICAL' }] });
  return {
    pendingApproval: s.SUBMITTED ?? 0,
    clarification: s.CLARIFICATION_REQUIRED ?? 0,
    readyToIssue: s.APPROVED ?? 0,
    partiallyIssued: s.PARTIALLY_ISSUED ?? 0,
    issued: s.ISSUED ?? 0,
    criticalOpen: critical,
    total: by.reduce((a, b) => a + b.n, 0),
  };
}
