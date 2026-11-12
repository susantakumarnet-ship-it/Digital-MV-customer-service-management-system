import { z } from 'zod';
import { email, objectId, paginationQuery, phone } from './common';

/** Complaint status keys the code relies on (labels are configurable — D-01). */
export const COMPLAINT_STATUS = {
  NEW: 'NEW',
  UNDER_REVIEW: 'UNDER_REVIEW',
  AWAITING_CUSTOMER_INFO: 'AWAITING_CUSTOMER_INFO',
  ASSIGNED: 'ASSIGNED',
  IN_PROGRESS: 'IN_PROGRESS',
  SUBMITTED_FOR_REVIEW: 'SUBMITTED_FOR_REVIEW',
  RETURNED_FOR_CORRECTION: 'RETURNED_FOR_CORRECTION',
  APPROVED: 'APPROVED',
  RESOLVED: 'RESOLVED',
  CUSTOMER_ACCEPTANCE_PENDING: 'CUSTOMER_ACCEPTANCE_PENDING',
  CUSTOMER_ACCEPTED: 'CUSTOMER_ACCEPTED',
  CLOSED: 'CLOSED',
  DUPLICATE: 'DUPLICATE',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  REOPENED: 'REOPENED',
} as const;

/** Statuses that no longer count as "open" for queues, SLA and dashboards. */
export const COMPLAINT_CLOSED_STATUSES = ['CLOSED', 'DUPLICATE', 'REJECTED', 'CANCELLED'] as const;

export const COMPLAINT_SOURCES = [
  { value: 'PUBLIC_FORM', label: 'Public web form' },
  { value: 'CUSTOMER_PORTAL', label: 'Customer portal' },
  { value: 'PHONE', label: 'Phone call' },
  { value: 'EMAIL', label: 'Email' },
  { value: 'WALK_IN', label: 'Walk-in / site visit' },
  { value: 'OTHER', label: 'Other' },
] as const;
export type ComplaintSource = (typeof COMPLAINT_SOURCES)[number]['value'];

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal(''))
    .transform((v) => (v ? v : undefined));
const optId = objectId.optional().or(z.literal('')).transform((v) => (v ? v : undefined));

/** Fields shared by every intake channel (PUB-01, BRF §5). */
const intakeShape = {
  customerName: z.string().trim().min(2, 'Customer name is required').max(150),
  organizationName: optText(150),
  contactPerson: optText(150),
  mobile: phone,
  email,
  regionId: objectId,
  cityId: objectId,
  siteId: objectId,
  assetId: optId,
  equipmentTypeId: optId,
  requestTypeId: objectId,
  description: z.string().trim().min(10, 'Please describe the problem (at least 10 characters)').max(5000),
  suggestedPriorityId: optId,
};

/** Public form (no login). Received time is always the server time. */
export const publicComplaintSchema = z.object({
  ...intakeShape,
  consentAccepted: z.literal(true, { errorMap: () => ({ message: 'You must accept the privacy notice to submit' }) }),
  consentVersion: z.string().trim().min(1).max(20),
  /** Signed token issued when the form was opened (minimum fill time / anti-automation). */
  formToken: z.string().min(10).max(500),
  /** Honeypot: must stay empty. Real users never see this field. */
  website: z.string().max(0, 'Invalid submission').optional().or(z.literal('')),
  captchaToken: z.string().max(4000).optional(),
});
export type PublicComplaintInput = z.infer<typeof publicComplaintSchema>;

/** Internal registration by staff (phone/email/walk-in) or by a portal customer. */
export const internalComplaintSchema = z.object({
  ...intakeShape,
  source: z.enum(['CUSTOMER_PORTAL', 'PHONE', 'EMAIL', 'WALK_IN', 'OTHER']).default('PHONE'),
  /** When the complaint was actually received (e.g. a phone call earlier today). Never in the future. */
  receivedAt: z.coerce
    .date()
    .optional()
    .refine((d) => !d || d.getTime() <= Date.now() + 60_000, 'Received time cannot be in the future'),
  consentAccepted: z.boolean().default(true),
});
export type InternalComplaintInput = z.infer<typeof internalComplaintSchema>;

/** Editable intake details (before the complaint is locked). */
export const complaintUpdateSchema = z.object({
  customerName: intakeShape.customerName.optional(),
  organizationName: optText(150),
  contactPerson: optText(150),
  mobile: phone.optional(),
  email: email.optional(),
  siteId: objectId.optional(),
  assetId: objectId.optional().nullable().or(z.literal('')),
  equipmentTypeId: objectId.optional().nullable().or(z.literal('')),
  description: intakeShape.description.optional(),
  reason: z.string().trim().max(1000).optional(),
});

/** Review & classification (CMP-03). */
export const classificationSchema = z.object({
  requestTypeId: objectId,
  priorityId: objectId,
  category: optText(120),
  supervisorId: optId,
  equipmentTypeId: optId,
  assetId: optId,
  notes: optText(2000),
});
export type ClassificationInput = z.infer<typeof classificationSchema>;

export const complaintTransitionSchema = z.object({
  action: z.string().regex(/^[a-zA-Z]+$/).max(40),
  reason: z.string().trim().max(2000).optional(),
  /** markDuplicate: the master complaint this one duplicates. */
  duplicateOfId: objectId.optional(),
  /** requestInfo: message sent to the customer (defaults to the reason). */
  messageToCustomer: z.string().trim().max(4000).optional(),
});

export const complaintNoteSchema = z.object({
  text: z.string().trim().min(1, 'Note cannot be empty').max(4000),
});

/** Portal customer answering a request for information (D-31). */
export const customerResponseSchema = z.object({
  message: z.string().trim().min(2, 'Please enter your response').max(4000),
});

export const complaintListQuery = paginationQuery.extend({
  status: z.string().trim().max(400).optional(), // comma-separated status keys, or OPEN
  priorityId: objectId.optional(),
  requestTypeId: objectId.optional(),
  regionId: objectId.optional(),
  cityId: objectId.optional(),
  siteId: objectId.optional(),
  organizationId: objectId.optional(),
  supervisorId: objectId.optional(),
  source: z.string().trim().max(20).optional(),
  overdue: z.enum(['true', 'false']).optional(),
  unclassified: z.enum(['true', 'false']).optional(),
  receivedFrom: z.coerce.date().optional(),
  receivedTo: z.coerce.date().optional(),
  dueFrom: z.coerce.date().optional(),
  dueTo: z.coerce.date().optional(),
});
export type ComplaintListQuery = z.infer<typeof complaintListQuery>;

// ---- Response shapes ---------------------------------------------------------------------------

export interface RefLabel {
  id: string;
  name: string;
  code?: string;
}

export interface AttachmentDto {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
  uploadedByName?: string;
  scanStatus: 'NOT_SCANNED' | 'PENDING' | 'CLEAN' | 'INFECTED';
  context?: string;
}

export interface ComplaintSummaryDto {
  id: string;
  referenceNo: string;
  status: string;
  statusLabel: string;
  statusTone: string;
  source: ComplaintSource;
  customerName: string;
  organizationName?: string;
  site?: RefLabel;
  region?: RefLabel;
  city?: RefLabel;
  priority?: RefLabel & { tone?: string; rank?: number };
  requestType?: RefLabel;
  receivedAt: string;
  dueAt?: string | null;
  overdue: boolean;
  supervisor?: RefLabel | null;
  duplicateOf?: { id: string; referenceNo: string } | null;
}

export interface ComplaintDetailDto extends ComplaintSummaryDto {
  contactPerson?: string;
  mobile: string;
  email: string;
  contactMasked: boolean;
  customerOrganization?: RefLabel;
  asset?: RefLabel | null;
  equipmentType?: RefLabel | null;
  suggestedPriority?: RefLabel | null;
  description: string;
  category?: string;
  classification?: { classifiedAt: string; classifiedByName?: string; notes?: string } | null;
  acknowledgedAt?: string | null;
  consent: { accepted: boolean; version?: string; at?: string };
  attachments: AttachmentDto[];
  internalNotes?: { id: string; text: string; byName: string; at: string }[];
  customerMessages: { id: string; direction: 'TO_CUSTOMER' | 'FROM_CUSTOMER'; text: string; byName?: string; at: string }[];
  linkedDuplicates: { id: string; referenceNo: string; status: string; receivedAt: string }[];
  statusHistory: { from?: string; to: string; toLabel: string; action: string; byName?: string; at: string; reason?: string }[];
  availableActions: { action: string; label: string; to: string; requiresReason: boolean; confirm: boolean }[];
  permissions: { canEdit: boolean; canClassify: boolean; canAddNote: boolean; canAttach: boolean; canRespond: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface PublicSubmissionResult {
  referenceNo: string;
  receivedAt: string;
  /** Set only when the SAME email recently reported the same site (no information leak to others). */
  possibleDuplicateOf?: string;
  message: string;
}
