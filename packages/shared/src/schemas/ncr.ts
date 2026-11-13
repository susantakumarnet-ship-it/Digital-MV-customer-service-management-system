import { z } from 'zod';
import { objectId, paginationQuery } from './common';
import type { AttachmentDto, RefLabel } from './complaints';

/** D-08 defaults; editable in Configuration → NCR. */
export const DEFAULT_NCR_CATEGORIES = [
  'Workmanship',
  'Material/Component defect',
  'Design/Specification',
  'Safety',
  'Documentation',
  'Supplier/Contractor',
  'Customer-caused',
  'Other',
];
export const DEFAULT_NCR_SEVERITIES = ['Critical', 'Major', 'Minor', 'Observation'];

export const NCR_DISPOSITIONS = [
  { value: 'REWORK', label: 'Rework' },
  { value: 'REPAIR', label: 'Repair' },
  { value: 'REPLACE', label: 'Replace' },
  { value: 'USE_AS_IS', label: 'Use as is (concession)' },
  { value: 'SCRAP', label: 'Scrap' },
  { value: 'RETURN_TO_SUPPLIER', label: 'Return to supplier' },
  { value: 'OTHER', label: 'Other' },
] as const;
export type NcrDisposition = (typeof NCR_DISPOSITIONS)[number]['value'];

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal(''))
    .transform((v) => (v ? v : undefined));

/** NCR-01: raised against a complaint, optionally a work order, asset or inspection item. Multipart `data` + evidence `files`. */
export const ncrCreateSchema = z.object({
  complaintId: objectId,
  workOrderId: objectId.optional(),
  assetId: objectId.optional(),
  inspectionReportId: objectId.optional(),
  itemKey: optText(40),
  category: z.string().trim().min(1, 'Select a category').max(80),
  severity: z.string().trim().min(1, 'Select a severity').max(40),
  title: z.string().trim().min(3, 'Enter a short title').max(150),
  description: z.string().trim().min(10, 'Describe the non-conformance').max(4000),
  ownerId: objectId.optional(),
  dueAt: z.coerce.date().optional(),
});
export type NcrCreateInput = z.infer<typeof ncrCreateSchema>;

export const ncrAssignSchema = z.object({
  ownerId: objectId,
  dueAt: z.coerce.date().optional(),
  comment: optText(2000),
});

/** Owner's action record (containment / root cause / corrective action / disposition). Each save is revisioned. */
export const ncrActionSchema = z.object({
  containmentAction: optText(4000),
  rootCause: optText(4000),
  correctiveAction: optText(4000),
  disposition: z.enum(['REWORK', 'REPAIR', 'REPLACE', 'USE_AS_IS', 'SCRAP', 'RETURN_TO_SUPPLIER', 'OTHER']).optional(),
  dueAt: z.coerce.date().optional(),
});

export const ncrUpdateSchema = z.object({
  category: z.string().trim().min(1).max(80).optional(),
  severity: z.string().trim().min(1).max(40).optional(),
  title: z.string().trim().min(3).max(150).optional(),
  description: z.string().trim().min(10).max(4000).optional(),
  dueAt: z.coerce.date().optional().nullable(),
  reason: optText(1000),
});

export const ncrTransitionSchema = z.object({
  action: z.enum(['assign', 'startAction', 'submitForVerification', 'return', 'verify', 'close']),
  reason: optText(2000),
  /** verify: verification comment recorded with the evidence. */
  comment: optText(2000),
});

export const ncrCommentSchema = z.object({ text: z.string().trim().min(1, 'Write a comment').max(4000) });

export const ncrListQuery = paginationQuery.extend({
  status: z.string().trim().max(300).optional(), // comma list or OPEN (= not closed)
  complaintId: objectId.optional(),
  workOrderId: objectId.optional(),
  ownerId: objectId.optional(),
  mine: z.enum(['true', 'false']).optional(),
  severity: z.string().trim().max(40).optional(),
  category: z.string().trim().max(80).optional(),
  overdue: z.enum(['true', 'false']).optional(),
});

export const NCR_OPEN_STATUSES = ['OPEN', 'ASSIGNED', 'ACTION_IN_PROGRESS', 'SUBMITTED_FOR_VERIFICATION', 'RETURNED'] as const;

// ---- DTOs --------------------------------------------------------------------------------------

export interface NcrSummaryDto {
  id: string;
  ncrNo: string;
  title: string;
  status: string;
  statusLabel: string;
  statusTone: string;
  category: string;
  severity: string;
  complaint: { id: string; referenceNo: string };
  workOrder?: { id: string; workOrderNo: string } | null;
  site?: RefLabel;
  owner?: RefLabel | null;
  raisedBy: RefLabel;
  dueAt?: string | null;
  overdue: boolean;
  createdAt: string;
}

export interface NcrDetailDto extends NcrSummaryDto {
  description: string;
  asset?: RefLabel | null;
  inspection?: { reportId: string; itemKey?: string; itemDescription?: string } | null;
  containmentAction?: string;
  rootCause?: string;
  correctiveAction?: string;
  disposition?: NcrDisposition;
  verification?: { byName: string; at: string; comment?: string } | null;
  evidence: AttachmentDto[];
  verificationEvidence: AttachmentDto[];
  comments: { id: string; text: string; byName: string; at: string }[];
  revisions: { at: string; byName: string; changes: Record<string, { from?: string; to?: string }> }[];
  statusHistory: { from?: string; to: string; toLabel: string; action: string; byName?: string; at: string; reason?: string }[];
  availableActions: { action: string; label: string; to: string; requiresReason: boolean; confirm: boolean }[];
  permissions: { canEditActions: boolean; canEditDetails: boolean; canAssign: boolean; canVerify: boolean; canComment: boolean; canUploadEvidence: boolean; canUploadVerification: boolean; reasonIfNotVerify?: string };
}
