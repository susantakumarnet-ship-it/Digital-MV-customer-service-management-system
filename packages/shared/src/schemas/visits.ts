import { z } from 'zod';
import { TIME_EVENT_TYPES, type TimeEventType } from '../enums';
import { objectId, paginationQuery } from './common';
import type { RefLabel } from './complaints';

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal(''))
    .transform((v) => (v ? v : undefined));

/** GPS reading captured only after an explicit user action and browser permission (ENG-03). */
export const gpsSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100_000).optional(),
  /** Device time of the reading (diagnostic only). */
  capturedAt: z.coerce.date().optional(),
});
export type GpsInput = z.infer<typeof gpsSchema>;

/** ENG-02: create a visit against a work order. */
export const visitCreateSchema = z.object({
  plannedAt: z.coerce.date().optional(),
  purpose: z.string().trim().min(3, 'Describe the purpose of the visit').max(500),
  /** Engineers taking part (must be assigned to the work order). Defaults to the creator. */
  engineerIds: z.array(objectId).max(10).optional(),
  /** Other attendees (customer staff, contractors) — free text. */
  attendees: optText(1000),
  notes: optText(4000),
});
export type VisitCreateInput = z.infer<typeof visitCreateSchema>;

export const visitUpdateSchema = z.object({
  plannedAt: z.coerce.date().optional().nullable(),
  purpose: z.string().trim().min(3).max(500).optional(),
  attendees: optText(1000),
  notes: optText(4000),
});

/**
 * Record the NEXT time event (TIME-01..03). The server decides the timestamp; the client may send
 * its own clock reading and GPS for diagnostics only. `eventType` must equal the next expected event.
 */
export const timeEventSchema = z.object({
  eventType: z.enum(TIME_EVENT_TYPES),
  clientTimestamp: z.coerce.date().optional(),
  gps: gpsSchema.optional(),
  note: optText(500),
});

/** TIME-07: correction request — original stays unchanged; proposed value + mandatory reason. */
export const timeCorrectionRequestSchema = z.object({
  timeEventId: objectId,
  proposedTimestamp: z.coerce.date(),
  reason: z.string().trim().min(5, 'Explain why the time is wrong').max(1000),
});

export const timeCorrectionDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  comment: z.string().trim().max(1000).optional(),
}).refine((v) => v.decision === 'APPROVE' || Boolean(v.comment), { path: ['comment'], message: 'Explain why the correction is rejected' });

export const visitListQuery = paginationQuery.extend({
  workOrderId: objectId.optional(),
  engineerId: objectId.optional(),
  mine: z.enum(['true', 'false']).optional(),
  status: z.string().trim().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const correctionListQuery = paginationQuery.extend({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ALL']).default('PENDING'),
  visitId: objectId.optional(),
  mine: z.enum(['true', 'false']).optional(),
});

// ---- DTOs --------------------------------------------------------------------------------------

export const TIME_EVENT_ORDER: Record<TimeEventType, number> = Object.fromEntries(
  TIME_EVENT_TYPES.map((t, i) => [t, i + 1]),
) as Record<TimeEventType, number>;

export interface TimeEventDto {
  id: string;
  eventType: TimeEventType;
  sequence: number;
  serverTimestamp: string;
  /** Effective time (approved correction if any, else the server time). */
  effectiveTimestamp: string;
  corrected: boolean;
  clientTimestamp?: string | null;
  gps?: (GpsInput & { capturedAt?: string }) | null;
  note?: string;
  pendingCorrection?: { id: string; proposedTimestamp: string } | null;
}

export interface TimeDurations {
  /** Minutes; null until both bounding events exist. */
  travelToSite: number | null;
  onSiteWork: number | null;
  returnTravel: number | null;
  totalElapsed: number | null;
  /** Time on site before work started (arrival → start work). */
  onSiteWaiting: number | null;
}

export interface EngineerSequenceDto {
  engineer: RefLabel;
  events: TimeEventDto[];
  /** Next event this engineer may record, or null when the sequence is complete. */
  nextEvent: TimeEventType | null;
  complete: boolean;
  durations: TimeDurations;
}

export interface VisitSummaryDto {
  id: string;
  visitNo: string;
  status: string;
  statusLabel: string;
  statusTone: string;
  workOrder: { id: string; workOrderNo: string; title: string };
  complaint: { id: string; referenceNo: string };
  site?: RefLabel;
  plannedAt?: string | null;
  purpose: string;
  engineers: RefLabel[];
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface VisitDetailDto extends VisitSummaryDto {
  attendees?: string;
  notes?: string;
  sequences: EngineerSequenceDto[];
  /** Sequence of the signed-in engineer (if taking part). */
  mySequence?: EngineerSequenceDto | null;
  corrections: TimeCorrectionDto[];
  inspectionReports: { id: string; revisionNo: number; status: string; statusLabel: string; submittedAt?: string | null }[];
  permissions: { canRecordTime: boolean; canRequestCorrection: boolean; canApproveCorrections: boolean; canEdit: boolean; canCancel: boolean; canInspect: boolean };
  timezone: string;
  createdAt: string;
}

export interface TimeCorrectionDto {
  id: string;
  visitId: string;
  timeEventId: string;
  eventType: TimeEventType;
  engineer: RefLabel;
  originalTimestamp: string;
  proposedTimestamp: string;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  requestedByName: string;
  requestedAt: string;
  reviewerName?: string;
  decidedAt?: string;
  decisionComment?: string;
}
