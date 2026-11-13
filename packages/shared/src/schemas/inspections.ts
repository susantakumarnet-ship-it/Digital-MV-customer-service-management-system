import { z } from 'zod';
import { INSPECTION_RESULTS, type InspectionResult } from '../enums';
import { objectId, paginationQuery } from './common';
import type { AttachmentDto, RefLabel } from './complaints';

export const EVIDENCE_REQUIREMENTS = [
  { value: 'NONE', label: 'No evidence required' },
  { value: 'PHOTO', label: 'Photo required' },
  { value: 'DOCUMENT', label: 'Document required' },
  { value: 'ANY', label: 'Photo or document required' },
] as const;
export type EvidenceRequirement = (typeof EVIDENCE_REQUIREMENTS)[number]['value'];

export const INSPECTION_RESULT_LABELS: Record<InspectionResult, string> = {
  PASS: 'Pass',
  FAIL: 'Fail',
  NOT_CHECKED: 'Not checked',
  NOT_APPLICABLE: 'Not applicable',
};

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal(''))
    .transform((v) => (v ? v : undefined));

/** One checklist line in a template (INSP-01). `key` is stable across versions. */
export const templateItemSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, dash or underscore'),
  section: optText(120),
  description: z.string().trim().min(3, 'Describe what to inspect').max(500),
  guidance: optText(1000),
  required: z.boolean().default(true),
  evidence: z.enum(['NONE', 'PHOTO', 'DOCUMENT', 'ANY']).default('NONE'),
  /** BR-007: N/A needs a reason when configured. (Not Checked always needs a reason.) */
  naReasonRequired: z.boolean().default(false),
  /** Evidence also required when the result is FAIL (common QA rule). */
  evidenceOnFail: z.boolean().default(false),
});
export type TemplateItem = z.infer<typeof templateItemSchema>;

export const inspectionTemplateSchema = z
  .object({
    name: z.string().trim().min(3).max(150),
    equipmentTypeId: objectId,
    description: optText(1000),
    items: z.array(templateItemSchema).min(1, 'Add at least one checklist item').max(300),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.items.forEach((it, i) => {
      if (seen.has(it.key)) ctx.addIssue({ code: 'custom', path: ['items', i, 'key'], message: `Duplicate item key "${it.key}"` });
      seen.add(it.key);
    });
  });
export type InspectionTemplateInput = z.infer<typeof inspectionTemplateSchema>;

export const templateListQuery = paginationQuery.extend({
  equipmentTypeId: objectId.optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'RETIRED', 'ALL']).default('ALL'),
});

/** One result line in a report draft. Validation for submission happens server-side (BR-007/008). */
export const reportResultSchema = z.object({
  itemKey: z.string().max(40),
  result: z.enum(INSPECTION_RESULTS).optional().nullable(),
  remarks: optText(2000),
  /** Reason for NOT_CHECKED / NOT_APPLICABLE. */
  reason: optText(1000),
});

/** Save draft (INSP-05): partial results allowed. */
export const reportDraftSchema = z.object({
  results: z.array(reportResultSchema).max(300).default([]),
  findings: optText(4000),
  recommendations: optText(4000),
});

/** MD-08: controlled temporary asset recorded in the field, reviewed later by a supervisor. */
export const temporaryAssetSchema = z.object({
  name: z.string().trim().min(2).max(150),
  equipmentTypeId: objectId,
  manufacturer: optText(120),
  model: optText(120),
  serialNumber: optText(120),
  rating: optText(120),
  description: optText(1000),
});

export const temporaryAssetDecisionSchema = z
  .object({ decision: z.enum(['APPROVE', 'REJECT']), code: optText(40), comment: optText(1000) })
  .refine((v) => v.decision === 'APPROVE' || Boolean(v.comment), { path: ['comment'], message: 'Explain why the asset is rejected' });

// ---- DTOs --------------------------------------------------------------------------------------

export interface InspectionTemplateDto {
  id: string;
  name: string;
  equipmentType: RefLabel;
  version: number;
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  description?: string;
  items: TemplateItem[];
  publishedAt?: string | null;
  publishedByName?: string;
  updatedAt: string;
}

export interface ReportItemDto extends TemplateItem {
  result?: InspectionResult | null;
  remarks?: string;
  reason?: string;
  attachments: AttachmentDto[];
  /** Problems that would block submission for this item (computed by the server). */
  issues: string[];
  /** Reviewer feedback from the review that returned the previous revision. */
  feedback?: string;
}

export interface InspectionReportDto {
  id: string;
  revisionNo: number;
  status: string;
  statusLabel: string;
  statusTone: string;
  locked: boolean;
  visit: { id: string; visitNo: string };
  workOrder: { id: string; workOrderNo: string; title: string };
  complaint: { id: string; referenceNo: string };
  site?: RefLabel;
  asset?: RefLabel | null;
  equipmentType?: RefLabel | null;
  template: { id: string; name: string; version: number };
  items: ReportItemDto[];
  findings?: string;
  recommendations?: string;
  summary: { total: number; pass: number; fail: number; notChecked: number; notApplicable: number; unanswered: number };
  /** All blocking problems (item issues + report-level, e.g. missing time events). Empty = ready to submit. */
  submissionIssues: string[];
  submittedAt?: string | null;
  submittedByName?: string;
  createdByName?: string;
  previousRevisionId?: string | null;
  /** When this revision exists because the previous one was returned (REV-02). */
  reviewFeedback?: { reviewerName: string; comments?: string; at: string } | null;
  permissions: { canEdit: boolean; canSubmit: boolean; canUpload: boolean };
  updatedAt: string;
}
