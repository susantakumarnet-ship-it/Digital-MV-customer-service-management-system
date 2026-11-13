import { Types, type ClientSession, type PipelineStage } from 'mongoose';
import type { StockBalanceDto, StockTransactionDto, StockTransactionType } from '@mv/shared';
import type { RequestContext } from '../../common/context';
import { AppError, notFound, validationFailed } from '../../common/errors';
import { paged } from '../../common/http/route';
import { audit } from '../../core/audit/audit.service';
import { Attachment, toAttachmentDto } from '../../core/storage/attachment.model';
import { withTransaction } from '../../db/transaction';
import { InventoryItem, Warehouse } from '../masters/master.models';
import { StockBalance, StockTransaction } from './material.models';

type Doc = Record<string, any>;
const oid = (v: unknown) => new Types.ObjectId(String(v));

export interface StockMovement {
  type: StockTransactionType;
  itemId: unknown;
  warehouseId: unknown;
  quantity: number;
  /** ISSUE only: how much of the quantity comes out of this request's reservation. */
  consumeReserved?: number;
  reference?: { type: string; id: unknown; label?: string };
  lineId?: string;
  batchNo?: string;
  serialNumbers?: string[];
  recipientName?: string;
  recipientUserId?: unknown;
  reason?: string;
}

const insufficient = (msg: string, details?: Record<string, unknown>) => new AppError(409, 'INSUFFICIENT_STOCK', msg, undefined, details);

/**
 * The ONLY way stock changes (MAT-05): appends an immutable ledger entry and updates the balance
 * projection in the caller's transaction. Conditional updates make overdraw impossible even under
 * concurrent requests.
 */
export async function applyStock(ctx: RequestContext, m: StockMovement, session: ClientSession) {
  const key = { itemId: oid(m.itemId), warehouseId: oid(m.warehouseId) };
  const q = m.quantity;
  if (!(q > 0)) throw validationFailed({ quantity: 'Quantity must be greater than zero' });
  const avail = (n: number) => ({ $expr: { $gte: [{ $subtract: ['$onHand', '$reserved'] }, n] } });
  const fromRes = m.type === 'ISSUE' ? Math.min(m.consumeReserved ?? 0, q) : 0;

  switch (m.type) {
    case 'OPENING':
    case 'RECEIPT':
    case 'RETURN':
    case 'ADJUST_IN':
      await StockBalance.updateOne(key, { $inc: { onHand: q } }, { upsert: true, session });
      break;
    case 'RESERVE': {
      const r = await StockBalance.updateOne({ ...key, ...avail(q) }, { $inc: { reserved: q } }, { session });
      if (!r.modifiedCount) throw insufficient('Not enough available stock in this warehouse to reserve that quantity.');
      break;
    }
    case 'UNRESERVE': {
      const r = await StockBalance.updateOne({ ...key, reserved: { $gte: q } }, { $inc: { reserved: -q } }, { session });
      if (!r.modifiedCount) throw insufficient('Cannot release more than is reserved.');
      break;
    }
    case 'ISSUE': {
      // Stock must be physically there, and the un-reserved part must not eat other requests' reservations.
      const r = await StockBalance.updateOne(
        { ...key, onHand: { $gte: q }, reserved: { $gte: fromRes }, ...avail(q - fromRes) },
        { $inc: { onHand: -q, reserved: -fromRes } },
        { session },
      );
      if (!r.modifiedCount) throw insufficient('Not enough stock in this warehouse to issue that quantity. Record a backorder or choose another warehouse.');
      break;
    }
    case 'ADJUST_OUT': {
      const r = await StockBalance.updateOne({ ...key, ...avail(q) }, { $inc: { onHand: -q } }, { session });
      if (!r.modifiedCount) throw insufficient('Cannot remove more than the available (unreserved) stock.');
      break;
    }
    case 'DAMAGE':
      // Damaged/unusable returns are recorded for traceability but do not re-enter stock.
      break;
  }
  const [t] = await StockTransaction.create(
    [
      {
        itemId: key.itemId,
        warehouseId: key.warehouseId,
        transactionType: m.type,
        quantity: q,
        referenceType: m.reference?.type,
        referenceId: m.reference?.id,
        referenceLabel: m.reference?.label,
        consumedReserved: m.type === 'ISSUE' ? fromRes : undefined,
        lineId: m.lineId,
        batchNo: m.batchNo,
        serialNumbers: m.serialNumbers ?? [],
        recipientName: m.recipientName,
        recipientUserId: m.recipientUserId,
        reason: m.reason,
        actorId: ctx.auth!.userId,
        actorName: ctx.auth!.name,
        transactionAt: new Date(),
      },
    ],
    { session },
  );
  return t;
}

async function assertActive(itemId: unknown, warehouseId: unknown, session?: ClientSession) {
  const [item, wh] = await Promise.all([
    InventoryItem.findById(itemId).session(session ?? null).lean<Doc>(),
    Warehouse.findById(warehouseId).session(session ?? null).lean<Doc>(),
  ]);
  const fields: Record<string, string> = {};
  if (!item || item.status !== 'ACTIVE') fields.itemId = 'Select an active catalogue item';
  if (!wh || wh.status !== 'ACTIVE') fields.warehouseId = 'Select an active warehouse';
  if (Object.keys(fields).length) throw validationFailed(fields);
  return { item: item!, warehouse: wh! };
}

// ---- Receipts & adjustments -------------------------------------------------------------------------

export async function receiveStock(ctx: RequestContext, input: { warehouseId: string; type: 'RECEIPT' | 'OPENING'; reference?: string; lines: { itemId: string; quantity: number; batchNo?: string }[] }) {
  return withTransaction(async (session) => {
    const created = [];
    for (const l of input.lines) {
      await assertActive(l.itemId, input.warehouseId, session);
      created.push(
        await applyStock(ctx, { type: input.type, itemId: l.itemId, warehouseId: input.warehouseId, quantity: l.quantity, batchNo: l.batchNo, reference: { type: 'receipt', id: undefined, label: input.reference }, reason: input.reference }, session),
      );
    }
    await audit(ctx, { action: 'inventory.received', entityType: 'inventory', meta: { type: input.type, warehouseId: input.warehouseId, lines: input.lines.length, reference: input.reference } }, session);
    return { transactions: created.length };
  });
}

export async function adjustStock(ctx: RequestContext, input: { warehouseId: string; itemId: string; delta: number; reason: string }) {
  return withTransaction(async (session) => {
    await assertActive(input.itemId, input.warehouseId, session);
    const before = await StockBalance.findOne({ itemId: input.itemId, warehouseId: input.warehouseId }).session(session).lean<Doc>();
    await applyStock(ctx, { type: input.delta > 0 ? 'ADJUST_IN' : 'ADJUST_OUT', itemId: input.itemId, warehouseId: input.warehouseId, quantity: Math.abs(input.delta), reason: input.reason, reference: { type: 'adjustment', id: undefined } }, session);
    const after = await StockBalance.findOne({ itemId: input.itemId, warehouseId: input.warehouseId }).session(session).lean<Doc>();
    await audit(ctx, { action: 'inventory.adjusted', entityType: 'inventory', entityId: input.itemId, before: { onHand: before?.onHand ?? 0 }, after: { onHand: after?.onHand ?? 0 }, reason: input.reason, meta: { warehouseId: input.warehouseId } }, session);
    return { onHand: after?.onHand ?? 0, reserved: after?.reserved ?? 0 };
  });
}

// ---- Queries ---------------------------------------------------------------------------------------

export async function listBalances(q: { page: number; limit: number; warehouseId?: string; itemId?: string; lowStock?: string; q?: string }) {
  const match: Doc = {};
  if (q.warehouseId) match.warehouseId = oid(q.warehouseId);
  if (q.itemId) match.itemId = oid(q.itemId);
  const pipeline: PipelineStage[] = [
    { $match: match },
    { $lookup: { from: 'inventoryItems', localField: 'itemId', foreignField: '_id', as: 'item' } },
    { $unwind: '$item' },
    { $lookup: { from: 'warehouses', localField: 'warehouseId', foreignField: '_id', as: 'wh' } },
    { $unwind: '$wh' },
    { $addFields: { available: { $subtract: ['$onHand', '$reserved'] } } },
  ];
  if (q.q) {
    const rx = q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pipeline.push({ $match: { $or: [{ 'item.name': { $regex: rx, $options: 'i' } }, { 'item.code': { $regex: rx, $options: 'i' } }] } });
  }
  if (q.lowStock === 'true') pipeline.push({ $match: { 'item.reorderLevel': { $ne: null }, $expr: { $lte: ['$available', '$item.reorderLevel'] } } });
  const [rows, total] = await Promise.all([
    StockBalance.aggregate([...pipeline, { $sort: { 'item.name': 1, 'wh.name': 1 } }, { $skip: (q.page - 1) * q.limit }, { $limit: q.limit }]),
    StockBalance.aggregate([...pipeline, { $count: 'n' }]).then((r) => r[0]?.n ?? 0),
  ]);
  const data: StockBalanceDto[] = rows.map((b: Doc) => ({
    item: { id: String(b.item._id), name: b.item.name, code: b.item.code, unit: b.item.unit, category: b.item.category, reorderLevel: b.item.reorderLevel ?? null },
    warehouse: { id: String(b.wh._id), name: b.wh.name, code: b.wh.code },
    onHand: b.onHand,
    reserved: b.reserved,
    available: b.available,
    lowStock: b.item.reorderLevel !== undefined && b.item.reorderLevel !== null && b.available <= b.item.reorderLevel,
    updatedAt: b.updatedAt,
  }));
  return paged(data, total, q.page, q.limit);
}

export async function toTransactionDtos(rows: Doc[]): Promise<StockTransactionDto[]> {
  const [items, whs, evidence] = await Promise.all([
    InventoryItem.find({ _id: { $in: rows.map((r) => r.itemId) } }).select('name code unit').lean<Doc[]>(),
    Warehouse.find({ _id: { $in: rows.map((r) => r.warehouseId) } }).select('name code').lean<Doc[]>(),
    Attachment.find({ ownerType: 'stockTransaction', ownerId: { $in: rows.map((r) => r._id) }, removedAt: null }).lean<Doc[]>(),
  ]);
  const im = new Map(items.map((i) => [String(i._id), i]));
  const wm = new Map(whs.map((w) => [String(w._id), w]));
  return rows.map((t) => {
    const it = im.get(String(t.itemId));
    const wh = wm.get(String(t.warehouseId));
    return {
      id: String(t._id),
      type: t.transactionType,
      item: { id: String(t.itemId), name: it?.name ?? 'Unknown', code: it?.code, unit: it?.unit },
      warehouse: { id: String(t.warehouseId), name: wh?.name ?? 'Unknown', code: wh?.code },
      quantity: t.quantity,
      reference: t.referenceType ? { type: t.referenceType, id: t.referenceId ? String(t.referenceId) : '', label: t.referenceLabel } : null,
      lineId: t.lineId,
      batchNo: t.batchNo,
      serialNumbers: t.serialNumbers ?? [],
      recipientName: t.recipientName,
      reason: t.reason,
      actorName: t.actorName,
      transactionAt: t.transactionAt,
      evidence: evidence.filter((e) => String(e.ownerId) === String(t._id)).map((e) => toAttachmentDto(e) as never),
    };
  });
}

export async function listLedger(q: { page: number; limit: number; warehouseId?: string; itemId?: string; type?: string; referenceId?: string; from?: Date; to?: Date }) {
  const f: Doc = {};
  if (q.warehouseId) f.warehouseId = oid(q.warehouseId);
  if (q.itemId) f.itemId = oid(q.itemId);
  if (q.type) f.transactionType = { $in: q.type.split(',') };
  if (q.referenceId) f.referenceId = oid(q.referenceId);
  if (q.from || q.to) f.transactionAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const [rows, total] = await Promise.all([
    StockTransaction.find(f).sort({ transactionAt: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean<Doc[]>(),
    StockTransaction.countDocuments(f),
  ]);
  return paged(await toTransactionDtos(rows), total, q.page, q.limit);
}

/**
 * Recomputes every balance from the ledger and reports differences (integrity check, MAT-05).
 * Read-only: drift indicates tampering outside the service and must be investigated, not auto-fixed.
 */
export async function reconcile() {
  const fromLedger = await StockTransaction.aggregate<{ _id: { itemId: unknown; warehouseId: unknown }; onHand: number; reserved: number }>([
    {
      $group: {
        _id: { itemId: '$itemId', warehouseId: '$warehouseId' },
        onHand: {
          $sum: {
            $switch: {
              branches: [
                { case: { $in: ['$transactionType', ['OPENING', 'RECEIPT', 'RETURN', 'ADJUST_IN']] }, then: '$quantity' },
                { case: { $in: ['$transactionType', ['ISSUE', 'ADJUST_OUT']] }, then: { $multiply: ['$quantity', -1] } },
              ],
              default: 0,
            },
          },
        },
        reserved: {
          $sum: {
            $switch: {
              branches: [
                { case: { $eq: ['$transactionType', 'RESERVE'] }, then: '$quantity' },
                { case: { $eq: ['$transactionType', 'UNRESERVE'] }, then: { $multiply: ['$quantity', -1] } },
              ],
              default: 0,
            },
          },
        },
      },
    },
  ]);
  // Reserved stock consumed by issues is released in the balance; the ledger records it on the ISSUE line.
  const consumed = await StockTransaction.aggregate<{ _id: { itemId: unknown; warehouseId: unknown }; n: number }>([
    { $match: { transactionType: 'ISSUE', consumedReserved: { $gt: 0 } } },
    { $group: { _id: { itemId: '$itemId', warehouseId: '$warehouseId' }, n: { $sum: '$consumedReserved' } } },
  ]);
  const consumedMap = new Map(consumed.map((c) => [`${c._id.itemId}:${c._id.warehouseId}`, c.n]));
  const balances = await StockBalance.find({}).lean<Doc[]>();
  const bmap = new Map(balances.map((b) => [`${b.itemId}:${b.warehouseId}`, b]));
  const drift: { itemId: string; warehouseId: string; ledgerOnHand: number; balanceOnHand: number; ledgerReserved: number; balanceReserved: number }[] = [];
  for (const l of fromLedger) {
    const k = `${l._id.itemId}:${l._id.warehouseId}`;
    const b = bmap.get(k);
    const reserved = l.reserved - (consumedMap.get(k) ?? 0);
    if (!b || Math.abs(b.onHand - l.onHand) > 1e-9 || Math.abs(b.reserved - reserved) > 1e-9) {
      drift.push({ itemId: String(l._id.itemId), warehouseId: String(l._id.warehouseId), ledgerOnHand: l.onHand, balanceOnHand: b?.onHand ?? 0, ledgerReserved: reserved, balanceReserved: b?.reserved ?? 0 });
    }
    bmap.delete(k);
  }
  for (const [, b] of bmap) {
    if (b.onHand || b.reserved) drift.push({ itemId: String(b.itemId), warehouseId: String(b.warehouseId), ledgerOnHand: 0, balanceOnHand: b.onHand, ledgerReserved: 0, balanceReserved: b.reserved });
  }
  return { checked: fromLedger.length, consistent: drift.length === 0, drift };
}

export async function itemStock(itemId: string) {
  const item = await InventoryItem.findById(itemId).lean<Doc>();
  if (!item) throw notFound('Item');
  const balances = await listBalances({ page: 1, limit: 100, itemId });
  return { item: { id: String(item._id), name: item.name, code: item.code, unit: item.unit, reorderLevel: item.reorderLevel ?? null }, balances: balances.data };
}
