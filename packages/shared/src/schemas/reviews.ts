import { z } from 'zod';
import { paginationQuery } from './common';
import type { InspectionReportDto } from './inspections';
import type { EngineerSequenceDto, TimeCorrectionDto } from './visits';

/**
 * Review action on a submitted inspection report (REV-02, HO §9 `POST /inspection-reports/:id/review-actions`).
 * - approve: comments optional (D-29); with multi-level approval each level needs a different reviewer.
 * - return: comments mandatory; optional per-item feedback shown to the engineer on the new revision.
 */
export const reviewActionSchema = z
  .object({
    action: z.enum(['startReview', 'approve', 'return']),
    comments: z.string().trim().max(4000).optional(),
    itemFeedback: z
      .array(z.object({ itemKey: z.string().max(40), comment: z.string().trim().min(1).max(2000) }))
      .max(300)
      .default([]),
  })
  .refine((v) => v.action !== 'return' || Boolean(v.comments), {
    path: ['comments'],
    message: 'Explain what must be corrected',
  });
export type ReviewActionInput = z.infer<typeof reviewActionSchema>;

export const reviewQueueQuery = paginationQuery.extend({
  status: z.enum(['PENDING', 'SUBMITTED', 'UNDER_REVIEW', 'RETURNED', 'APPROVED', 'ALL']).default('PENDING'),
  mineOnly: z.enum(['true', 'false']).optional(),
});

export interface ReviewActionDto {
  id: string;
  revisionNo: number;
  action: 'startReview' | 'approve' | 'return';
  level?: number;
  reviewerName: string;
  comments?: string;
  itemFeedback: { itemKey: string; comment: string }[];
  actionAt: string;
}

/** REV-05: warnings for the reviewer (never block approval on their own). */
export interface TimeLogFlag {
  severity: 'warning' | 'danger';
  engineer?: string;
  code: 'MISSING_EVENTS' | 'LONG_TRAVEL' | 'LONG_WORK' | 'SHORT_WORK' | 'PENDING_CORRECTION' | 'CLOCK_SKEW' | 'CORRECTED';
  message: string;
}

export interface ReviewQueueItemDto {
  id: string;
  revisionNo: number;
  status: string;
  statusLabel: string;
  statusTone: string;
  workOrder: { id: string; workOrderNo: string; title: string };
  complaint: { id: string; referenceNo: string };
  visit: { id: string; visitNo: string };
  siteName?: string;
  template: string;
  submittedAt?: string | null;
  submittedByName?: string;
  approvalsSoFar: number;
  approvalLevels: number;
  isOwn: boolean;
  summary: { fail: number; notChecked: number };
  waitingHours: number | null;
}

/** Everything a reviewer needs on one screen (REV-01). */
export interface ReviewContextDto {
  report: InspectionReportDto;
  complaint: { id: string; referenceNo: string; status: string; statusLabel: string; customerName: string; description: string; priority?: string };
  workOrder: { id: string; workOrderNo: string; title: string; status: string; statusLabel: string; description: string; shutdownRequired: boolean; materialRequired: boolean };
  visit: { id: string; visitNo: string; status: string; statusLabel: string; purpose: string; timezone: string };
  sequences: EngineerSequenceDto[];
  corrections: TimeCorrectionDto[];
  timeFlags: TimeLogFlag[];
  revisions: { id: string; revisionNo: number; status: string; statusLabel: string; submittedAt?: string | null }[];
  reviewHistory: ReviewActionDto[];
  /** Review feedback that applies to this revision (from the review that returned the previous one). */
  feedbackFromPreviousReview?: ReviewActionDto | null;
  ncrs: { id: string; ncrNo: string; status: string; statusLabel: string; statusTone: string; title: string; severity: string; itemKey?: string; inspectionReportId?: string }[];
  approval: { levels: number; approvalsSoFar: number; approvedBy: string[] };
  permissions: { canStartReview: boolean; canApprove: boolean; canReturn: boolean; reasonIfNot?: string };
}

export interface RevisionComparisonDto {
  from: { id: string; revisionNo: number; status: string };
  to: { id: string; revisionNo: number; status: string };
  items: {
    key: string;
    description: string;
    changed: boolean;
    from: { result?: string | null; remarks?: string; reason?: string; evidence: number };
    to: { result?: string | null; remarks?: string; reason?: string; evidence: number };
    feedback?: string;
  }[];
  findingsChanged: boolean;
  recommendationsChanged: boolean;
  from_findings?: string;
  to_findings?: string;
  from_recommendations?: string;
  to_recommendations?: string;
}
