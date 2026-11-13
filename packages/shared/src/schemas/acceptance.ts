import { z } from 'zod';

/**
 * Customer acceptance (BRF §16, HO §4.8, BR-015). Opening the link never counts as acceptance:
 * only an explicit POST with a decision does. Tokens are random, single-use, expiring and stored hashed.
 */
export const acceptanceDecisionSchema = z
  .object({
    decision: z.enum(['ACCEPT', 'REJECT']),
    comments: z.string().trim().max(4000).optional(),
    /** 1–5 satisfaction rating (optional feedback). */
    rating: z.coerce.number().int().min(1).max(5).optional(),
    feedback: z.string().trim().max(4000).optional(),
    /** Token flow: the person deciding types their name (identity record — D-12). */
    signerName: z.string().trim().min(2, 'Enter your name').max(150).optional(),
  })
  .refine((v) => v.decision === 'ACCEPT' || Boolean(v.comments), { path: ['comments'], message: 'Tell us what still needs to be done' });
export type AcceptanceDecisionInput = z.infer<typeof acceptanceDecisionSchema>;

export const acceptanceRequestSchema = z.object({
  /** Override recipient email (defaults to the complaint contact). */
  recipientEmail: z.string().trim().toLowerCase().email().optional(),
  message: z.string().trim().max(2000).optional(),
});

export const waiverSchema = z.object({
  reason: z.string().trim().min(5, 'Explain why customer acceptance is waived').max(2000),
});

export const resolutionSchema = z.object({
  reason: z.string().trim().min(5, 'Describe how the customer concern was resolved').max(2000),
});

export interface AcceptanceSummaryDto {
  complaint: {
    referenceNo: string;
    receivedAt: string;
    siteName?: string;
    customerName: string;
    description: string;
    statusLabel: string;
  };
  workOrders: { workOrderNo: string; title: string; completedAt?: string | null }[];
  serviceCompletion: {
    visits: number;
    firstVisitAt?: string | null;
    lastVisitAt?: string | null;
    onSiteMinutes: number;
  };
  approvedReports: {
    workOrderNo: string;
    template: string;
    approvedAt?: string | null;
    summary: { pass: number; fail: number; notChecked: number; notApplicable: number };
    findings?: string;
    recommendations?: string;
  }[];
  documents: { id: string; name: string; size: number }[];
  expiresAt?: string;
  /** Already decided via this token / portal. */
  decided?: { decision: 'ACCEPT' | 'REJECT' | 'WAIVED'; at: string } | null;
}

export interface AcceptanceRecordDto {
  id: string;
  decision: 'ACCEPT' | 'REJECT' | 'WAIVED';
  method: 'TOKEN' | 'PORTAL' | 'WAIVER';
  decidedByName: string;
  comments?: string;
  rating?: number;
  feedback?: string;
  decidedAt: string;
}

export interface ClosureChecklistDto {
  canClose: boolean;
  conditions: { key: string; label: string; met: boolean; detail?: string }[];
}
