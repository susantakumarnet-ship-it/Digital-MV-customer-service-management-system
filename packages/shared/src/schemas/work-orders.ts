import { z } from 'zod';
import { objectId, paginationQuery } from './common';
import type { RefLabel } from './complaints';

/** Work-order statuses that no longer count as active (queues, workload, overdue). */
export const WORK_ORDER_CLOSED_STATUSES = ['CLOSED', 'CANCELLED'] as const;
/** Statuses where the field work is finished (not counted as overdue). */
export const WORK_ORDER_DONE_STATUSES = ['WORK_COMPLETED', 'SUBMITTED', 'APPROVED', 'CLOSED', 'CANCELLED'] as const;
/** Statuses in which planning fields and the assignment may still change. */
export const WORK_ORDER_EDITABLE_STATUSES = ['DRAFT', 'ASSIGNED', 'ACCEPTED', 'SCHEDULED', 'ON_HOLD'] as const;

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal(''))
    .transform((v) => (v ? v : undefined));

const plannedFields = {
  title: z.string().trim().min(3, 'Enter a short title').max(150),
  description: z.string().trim().min(5, 'Describe the work required').max(4000),
  workScope: optText(4000),
  priorityId: objectId.optional(),
  plannedVisitAt: z.coerce.date().optional().nullable(),
  plannedEndAt: z.coerce.date().optional().nullable(),
  dueAt: z.coerce.date().optional().nullable(),
  shutdownRequired: z.boolean().default(false),
  shutdownDetails: optText(2000),
  materialRequired: z.boolean().default(false),
  materialNotes: optText(2000),
};

const planChecks = <T extends z.ZodTypeAny>(s: T) =>
  s
    .refine((v: any) => !v.plannedVisitAt || !v.plannedEndAt || v.plannedEndAt >= v.plannedVisitAt, {
      path: ['plannedEndAt'],
      message: 'Planned end must be after the planned start',
    })
    .refine((v: any) => !v.shutdownRequired || Boolean(v.shutdownDetails), {
      path: ['shutdownDetails'],
      message: 'Describe the shutdown required (isolation, outage window, permits)',
    })
    .refine((v: any) => !v.materialRequired || Boolean(v.materialNotes), {
      path: ['materialNotes'],
      message: 'Describe the materials required',
    });

/** Create a work order against a complaint (WO-01). Assignees are optional at creation. */
export const workOrderCreateSchema = planChecks(
  z.object({
    ...plannedFields,
    supervisorId: objectId.optional(),
    assigneeIds: z.array(objectId).max(10).default([]),
    leadEngineerId: objectId.optional(),
  }),
);
export type WorkOrderCreateInput = z.infer<typeof workOrderCreateSchema>;

/** Update planning fields (until work starts). Changing the due date requires a reason. */
export const workOrderUpdateSchema = planChecks(
  z.object({
    title: plannedFields.title.optional(),
    description: plannedFields.description.optional(),
    workScope: plannedFields.workScope,
    priorityId: objectId.optional(),
    plannedVisitAt: plannedFields.plannedVisitAt,
    plannedEndAt: plannedFields.plannedEndAt,
    dueAt: plannedFields.dueAt,
    shutdownRequired: z.boolean().optional(),
    shutdownDetails: plannedFields.shutdownDetails,
    materialRequired: z.boolean().optional(),
    materialNotes: plannedFields.materialNotes,
    reason: optText(1000),
  }),
);

/** Assign / reassign engineers (WO-04). Reassigning accepted work needs a reason. */
export const workOrderAssignmentSchema = z
  .object({
    assigneeIds: z.array(objectId).min(1, 'Select at least one engineer').max(10),
    leadEngineerId: objectId.optional(),
    supervisorId: objectId.optional(),
    plannedVisitAt: z.coerce.date().optional().nullable(),
    reason: optText(1000),
  })
  .refine((v) => !v.leadEngineerId || v.assigneeIds.includes(v.leadEngineerId), {
    path: ['leadEngineerId'],
    message: 'The lead engineer must be one of the assignees',
  });

export const workOrderTransitionSchema = z.object({
  action: z.string().regex(/^[a-zA-Z]+$/).max(40),
  reason: z.string().trim().max(2000).optional(),
});

export const workOrderListQuery = paginationQuery.extend({
  status: z.string().trim().max(300).optional(), // comma list or ACTIVE
  assigneeId: objectId.optional(),
  supervisorId: objectId.optional(),
  complaintId: objectId.optional(),
  siteId: objectId.optional(),
  regionId: objectId.optional(),
  priorityId: objectId.optional(),
  mine: z.enum(['true', 'false']).optional(),
  overdue: z.enum(['true', 'false']).optional(),
  unassigned: z.enum(['true', 'false']).optional(),
  plannedFrom: z.coerce.date().optional(),
  plannedTo: z.coerce.date().optional(),
  dueFrom: z.coerce.date().optional(),
  dueTo: z.coerce.date().optional(),
});
export type WorkOrderListQuery = z.infer<typeof workOrderListQuery>;

export const calendarQuery = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    assigneeId: objectId.optional(),
    regionId: objectId.optional(),
    includeUnplanned: z.enum(['true', 'false']).optional(),
  })
  .refine((v) => v.to > v.from, { path: ['to'], message: '"to" must be after "from"' })
  .refine((v) => v.to.getTime() - v.from.getTime() <= 92 * 86400_000, { path: ['to'], message: 'Range may not exceed 92 days' });

// ---- DTOs --------------------------------------------------------------------------------------

export interface WorkOrderSummaryDto {
  id: string;
  workOrderNo: string;
  title: string;
  status: string;
  statusLabel: string;
  statusTone: string;
  complaint: { id: string; referenceNo: string };
  site?: RefLabel;
  region?: RefLabel;
  priority?: RefLabel & { tone?: string; rank?: number };
  supervisor?: RefLabel | null;
  assignees: (RefLabel & { accepted: boolean; lead: boolean })[];
  plannedVisitAt?: string | null;
  plannedEndAt?: string | null;
  dueAt?: string | null;
  overdue: boolean;
  shutdownRequired: boolean;
  materialRequired: boolean;
  createdAt: string;
}

export interface WorkOrderDetailDto extends WorkOrderSummaryDto {
  description: string;
  workScope?: string;
  shutdownDetails?: string;
  materialNotes?: string;
  asset?: RefLabel | null;
  equipmentType?: RefLabel | null;
  complaintDetail: { status: string; statusLabel: string; customerName: string; description: string };
  assignmentHistory: {
    at: string;
    byName?: string;
    added: RefLabel[];
    removed: RefLabel[];
    leadEngineer?: RefLabel | null;
    reason?: string;
  }[];
  statusHistory: { from?: string; to: string; toLabel: string; action: string; byName?: string; at: string; reason?: string }[];
  availableActions: { action: string; label: string; to: string; requiresReason: boolean; confirm: boolean }[];
  permissions: { canEdit: boolean; canAssign: boolean; canAccept: boolean };
  updatedAt: string;
}

export interface EngineerWorkloadDto {
  id: string;
  name: string;
  email: string;
  eligible: boolean;
  activeWorkOrders: number;
  overdue: number;
  plannedInRange: number;
  dueNext7Days: number;
}

export interface CalendarItemDto {
  id: string;
  workOrderNo: string;
  title: string;
  start: string | null;
  end: string | null;
  dueAt?: string | null;
  status: string;
  statusLabel: string;
  statusTone: string;
  priorityTone?: string;
  siteName?: string;
  assignees: RefLabel[];
  overdue: boolean;
}
