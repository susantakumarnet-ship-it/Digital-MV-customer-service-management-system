import { z } from 'zod';
import { objectId, paginationQuery } from './common';
import type { AttachmentDto, RefLabel } from './complaints';

export const MATERIAL_URGENCIES = [
  { value: 'LOW', label: 'Low' },
  { value: 'NORMAL', label: 'Normal' },
  { value: 'HIGH', label: 'High' },
  { value: 'CRITICAL', label: 'Critical — work stopped' },
] as const;
export type MaterialUrgency = (typeof MATERIAL_URGENCIES)[number]['value'];

const qty = z.coerce.number({ invalid_type_error: 'Enter a quantity' }).positive('Quantity must be greater than zero').max(1_000_000);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal(''))
    .transform((v) => (v ? v : undefined));

/** MAT-01: request line — always a catalogue item so it can be issued from stock. */
export const materialLineSchema = z.object({
  itemId: objectId,
  quantity: qty,
  specification: optText(1000),
  reason: optText(1000),
});

export const materialRequestCreateSchema = z.object({
  workOrderId: objectId,
  visitId: objectId.optional(),
  urgency: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).default('NORMAL'),
  reason: z.string().trim().min(3, 'Explain why the material is needed').max(2000),
  neededBy: z.coerce.date().optional(),
  lines: z.array(materialLineSchema).min(1, 'Add at least one item').max(50),
  /** Create and submit in one step (default) or keep as draft. */
  submit: z.boolean().default(true),
});
export type MaterialRequestCreateInput = z.infer<typeof materialRequestCreateSchema>;

/** Edit a DRAFT or CLARIFICATION_REQUIRED request (requester). */
export const materialRequestUpdateSchema = z.object({
  urgency: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).optional(),
  reason: z.string().trim().min(3).max(2000).optional(),
  neededBy: z.coerce.date().optional().nullable(),
  lines: z.array(materialLineSchema).min(1).max(50).optional(),
  /** Reply to the supervisor's clarification request. */
  clarificationReply: optText(2000),
});

/** MAT-02: supervisor decision. Approval does not imply stock availability. */
export const materialDecisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT', 'CLARIFY']),
    comment: optText(2000),
    /** Approved quantity per line (defaults to requested; may be reduced, never increased here). */
    lines: z.array(z.object({ lineId: z.string().max(40), approvedQty: z.coerce.number().min(0).max(1_000_000) })).max(50).optional(),
  })
  .refine((v) => v.decision === 'APPROVE' || Boolean(v.comment), { path: ['comment'], message: 'A reason is required' });

/** BR-013: issuing more than approved needs a revised approval (by an approver, with a reason). */
export const materialRevisionSchema = z.object({
  lineId: z.string().max(40),
  approvedQty: z.coerce.number().min(0).max(1_000_000),
  reason: z.string().trim().min(3, 'Explain the revised quantity').max(1000),
});

export const reserveSchema = z.object({
  lineId: z.string().max(40),
  warehouseId: objectId,
  quantity: qty,
});
export const unreserveSchema = reserveSchema.extend({ reason: z.string().trim().min(3).max(500) });

/** MAT-03: issue (full or partial) with traceability and handover. Multipart `data` + optional evidence `files`. */
export const issueSchema = z.object({
  lineId: z.string().max(40),
  warehouseId: objectId,
  quantity: qty,
  batchNo: optText(120),
  serialNumbers: z.array(z.string().trim().min(1).max(120)).max(500).default([]),
  recipientName: z.string().trim().min(2, 'Who received the material?').max(150),
  recipientUserId: objectId.optional(),
  note: optText(1000),
});

export const backorderSchema = z.object({
  lineId: z.string().max(40),
  quantity: z.coerce.number().min(0).max(1_000_000),
  expectedAt: z.coerce.date().optional(),
  note: optText(1000),
});

/** MAT-04: return of issued material — good quantity back to stock, damaged/unusable recorded separately. */
export const returnSchema = z
  .object({
    lineId: z.string().max(40),
    warehouseId: objectId,
    goodQty: z.coerce.number().min(0).max(1_000_000).default(0),
    damagedQty: z.coerce.number().min(0).max(1_000_000).default(0),
    reason: z.string().trim().min(3, 'Explain the return').max(1000),
  })
  .refine((v) => v.goodQty + v.damagedQty > 0, { path: ['goodQty'], message: 'Enter a quantity to return' });

/** Stock receipt / opening balance (inventory.adjust). */
export const receiptSchema = z.object({
  warehouseId: objectId,
  type: z.enum(['RECEIPT', 'OPENING']).default('RECEIPT'),
  reference: optText(120),
  lines: z.array(z.object({ itemId: objectId, quantity: qty, batchNo: optText(120) })).min(1).max(200),
});

export const adjustmentSchema = z.object({
  warehouseId: objectId,
  itemId: objectId,
  /** Positive adds stock, negative removes stock. */
  delta: z.coerce.number().refine((n) => n !== 0, 'Enter a non-zero adjustment').refine((n) => Math.abs(n) <= 1_000_000, 'Too large'),
  reason: z.string().trim().min(3, 'A reason is required').max(1000),
});

export const materialListQuery = paginationQuery.extend({
  status: z.string().trim().max(300).optional(),
  workOrderId: objectId.optional(),
  complaintId: objectId.optional(),
  mine: z.enum(['true', 'false']).optional(),
  urgency: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).optional(),
  /** Store queue: approved / partially issued requests. */
  store: z.enum(['true', 'false']).optional(),
});

export const balanceQuery = paginationQuery.extend({
  warehouseId: objectId.optional(),
  itemId: objectId.optional(),
  lowStock: z.enum(['true', 'false']).optional(),
});

export const ledgerQuery = paginationQuery.extend({
  warehouseId: objectId.optional(),
  itemId: objectId.optional(),
  type: z.string().trim().max(200).optional(),
  referenceId: objectId.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const STOCK_TRANSACTION_TYPES = ['OPENING', 'RECEIPT', 'RESERVE', 'UNRESERVE', 'ISSUE', 'RETURN', 'DAMAGE', 'ADJUST_IN', 'ADJUST_OUT'] as const;
export type StockTransactionType = (typeof STOCK_TRANSACTION_TYPES)[number];

// ---- DTOs --------------------------------------------------------------------------------------

export interface MaterialLineDto {
  lineId: string;
  item: RefLabel & { unit: string; specification?: string };
  specification?: string;
  reason?: string;
  quantity: number;
  approvedQty: number | null;
  reservedQty: number;
  issuedQty: number;
  returnedQty: number;
  damagedQty: number;
  backorderQty: number;
  backorderExpectedAt?: string | null;
  /** approved − issued (what may still be issued without a revised approval). */
  outstandingQty: number;
  reservations: { warehouse: RefLabel; quantity: number }[];
}

export interface MaterialRequestSummaryDto {
  id: string;
  requestNo: string;
  status: string;
  statusLabel: string;
  statusTone: string;
  urgency: MaterialUrgency;
  workOrder: { id: string; workOrderNo: string };
  complaint: { id: string; referenceNo: string };
  site?: RefLabel;
  requester: RefLabel;
  lineCount: number;
  /** Lines with quantity still to issue (approved − issued > 0). */
  outstandingLines: number;
  neededBy?: string | null;
  submittedAt?: string | null;
  createdAt: string;
}

export interface MaterialRequestDetailDto extends MaterialRequestSummaryDto {
  reason: string;
  visit?: { id: string; visitNo: string } | null;
  lines: MaterialLineDto[];
  decisions: { decision: string; byName: string; at: string; comment?: string; lines?: { lineId: string; approvedQty: number }[] }[];
  messages: { direction: 'TO_REQUESTER' | 'FROM_REQUESTER'; text: string; byName: string; at: string }[];
  transactions: StockTransactionDto[];
  attachments: AttachmentDto[];
  statusHistory: { from?: string; to: string; toLabel: string; action: string; byName?: string; at: string; reason?: string }[];
  availableActions: { action: string; label: string; to: string; requiresReason: boolean; confirm: boolean }[];
  permissions: { canEdit: boolean; canSubmit: boolean; canDecide: boolean; canReviseApproval: boolean; canIssue: boolean; canReturn: boolean; canClose: boolean; reasonIfNotDecide?: string };
}

export interface StockTransactionDto {
  id: string;
  type: StockTransactionType;
  item: RefLabel & { unit?: string };
  warehouse: RefLabel;
  quantity: number;
  reference?: { type: string; id: string; label?: string } | null;
  lineId?: string;
  batchNo?: string;
  serialNumbers: string[];
  recipientName?: string;
  reason?: string;
  actorName: string;
  transactionAt: string;
  evidence: AttachmentDto[];
}

export interface StockBalanceDto {
  item: RefLabel & { unit: string; category?: string; reorderLevel?: number | null };
  warehouse: RefLabel;
  onHand: number;
  reserved: number;
  available: number;
  lowStock: boolean;
  updatedAt: string;
}
