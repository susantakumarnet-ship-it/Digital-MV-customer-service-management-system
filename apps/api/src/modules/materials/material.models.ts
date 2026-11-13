import { Schema, type InferSchemaType, type Types } from 'mongoose';
import { STOCK_TRANSACTION_TYPES } from '@mv/shared';
import { defineModel } from '../../db/model';
import { statusHistorySchema } from '../../core/workflow/workflow.model';

const ref = (model: string) => ({ type: Schema.Types.ObjectId, ref: model });

const reservationSchema = new Schema({ warehouseId: ref('Warehouse'), quantity: Number }, { _id: false });

const lineSchema = new Schema(
  {
    lineId: { type: String, required: true },
    itemId: { ...ref('InventoryItem'), required: true },
    itemCode: String,
    itemName: String,
    unit: String,
    specification: String,
    reason: String,
    quantity: { type: Number, required: true },
    approvedQty: { type: Number, default: null },
    issuedQty: { type: Number, default: 0 },
    returnedQty: { type: Number, default: 0 },
    damagedQty: { type: Number, default: 0 },
    backorderQty: { type: Number, default: 0 },
    backorderExpectedAt: Date,
    backorderNote: String,
    reservations: { type: [reservationSchema], default: [] },
  },
  { _id: false },
);

const decisionSchema = new Schema(
  {
    decision: { type: String, enum: ['APPROVE', 'REJECT', 'CLARIFY', 'REVISE'], required: true },
    by: ref('User'),
    byName: String,
    at: { type: Date, required: true },
    comment: String,
    lines: [{ lineId: String, approvedQty: Number, _id: false }],
  },
  { _id: false },
);

const messageSchema = new Schema(
  { direction: { type: String, enum: ['TO_REQUESTER', 'FROM_REQUESTER'] }, text: String, by: ref('User'), byName: String, at: Date },
  { _id: false },
);

/** Material request (HO §8 `materialRequests`, BRF §14). */
const materialRequestSchema = new Schema(
  {
    requestNo: { type: String, required: true },
    workOrderId: { ...ref('WorkOrder'), required: true },
    workOrderNo: String,
    visitId: ref('Visit'),
    visitNo: String,
    complaintId: { ...ref('Complaint'), required: true },
    complaintRef: String,
    organizationId: { ...ref('Organization'), required: true },
    regionId: { ...ref('Region'), required: true },
    siteId: { ...ref('Site'), required: true },
    siteName: String,
    requesterId: { ...ref('User'), required: true },
    requesterName: String,
    urgency: { type: String, enum: ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'], default: 'NORMAL' },
    /** Sort key by severity (0 = CRITICAL … 3 = LOW), kept in sync with urgency. */
    urgencyRank: { type: Number, default: 2 },
    reason: { type: String, required: true },
    neededBy: Date,
    lines: { type: [lineSchema], default: [] },
    decisions: { type: [decisionSchema], default: [] },
    messages: { type: [messageSchema], default: [] },
    status: { type: String, required: true, default: 'DRAFT' },
    statusHistory: { type: [statusHistorySchema], default: [] },
    submittedAt: Date,
    approvedAt: Date,
    closedAt: Date,
  },
  { collection: 'materialRequests', timestamps: true, versionKey: false },
);
materialRequestSchema.index({ requestNo: 1 }, { unique: true });
materialRequestSchema.index({ status: 1, urgencyRank: 1, submittedAt: 1 });
materialRequestSchema.pre('save', function (next) {
  this.urgencyRank = ({ CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 } as Record<string, number>)[this.urgency ?? 'NORMAL'] ?? 2;
  next();
});
materialRequestSchema.index({ workOrderId: 1, createdAt: 1 });
materialRequestSchema.index({ complaintId: 1, status: 1 });
materialRequestSchema.index({ status: 1, urgency: 1, submittedAt: 1 });
materialRequestSchema.index({ requesterId: 1, status: 1 });

export type MaterialRequestDoc = InferSchemaType<typeof materialRequestSchema> & { _id: Types.ObjectId };
export const MaterialRequest = defineModel('MaterialRequest', materialRequestSchema);
export const MATERIAL_SCOPE = { organization: 'organizationId', region: 'regionId', site: 'siteId', personal: ['requesterId'] };

/**
 * Stock transaction ledger (HO §8 `stockTransactions`, MAT-05). Append-only: history is never
 * overwritten; balances are derived (stockBalances) in the same DB transaction.
 */
const stockTransactionSchema = new Schema(
  {
    itemId: { ...ref('InventoryItem'), required: true },
    warehouseId: { ...ref('Warehouse'), required: true },
    transactionType: { type: String, enum: STOCK_TRANSACTION_TYPES, required: true },
    quantity: { type: Number, required: true, min: 0 },
    referenceType: String, // 'materialRequest' | 'receipt' | 'adjustment'
    referenceId: Schema.Types.ObjectId,
    referenceLabel: String,
    /** ISSUE: part of the quantity taken from this request's reservation (for reconciliation). */
    consumedReserved: Number,
    lineId: String,
    batchNo: String,
    serialNumbers: { type: [String], default: [] },
    recipientName: String,
    recipientUserId: ref('User'),
    reason: String,
    actorId: { ...ref('User'), required: true },
    actorName: String,
    transactionAt: { type: Date, required: true },
  },
  { collection: 'stockTransactions', timestamps: true, versionKey: false },
);
stockTransactionSchema.index({ itemId: 1, warehouseId: 1, transactionAt: -1 });
stockTransactionSchema.index({ referenceType: 1, referenceId: 1, transactionAt: 1 });
stockTransactionSchema.index({ transactionAt: -1 });
const immutable = function () {
  throw new Error('Stock transactions are immutable');
};
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  stockTransactionSchema.pre(op, immutable);
}
stockTransactionSchema.pre('save', function (next) {
  if (!this.isNew) return next(new Error('Stock transactions are immutable'));
  next();
});

export const StockTransaction = defineModel('StockTransaction', stockTransactionSchema);

/** Current balance per item × warehouse — a projection of the ledger, never edited directly by users. */
const stockBalanceSchema = new Schema(
  {
    itemId: { ...ref('InventoryItem'), required: true },
    warehouseId: { ...ref('Warehouse'), required: true },
    onHand: { type: Number, default: 0, min: 0 },
    reserved: { type: Number, default: 0, min: 0 },
  },
  { collection: 'stockBalances', timestamps: true, versionKey: false },
);
stockBalanceSchema.index({ itemId: 1, warehouseId: 1 }, { unique: true });
stockBalanceSchema.index({ warehouseId: 1 });

export const StockBalance = defineModel('StockBalance', stockBalanceSchema);
