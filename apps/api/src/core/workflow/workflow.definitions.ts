import type { StatusTone, WorkflowEntity, WorkflowState, WorkflowTransition } from '@mv/shared';

/**
 * Default workflow definitions seeded on first install. Source: HO Appendix A + BRF §22 lifecycle
 * (+ "Duplicate" complaint status from BRF §22). Labels and optional transitions are configurable
 * (D-01 — final matrix to be signed off by the project owner before the end of Phase 3).
 *
 * Guards named here are implemented in the phase that introduces the entity. Until then they are
 * unregistered and the engine fails closed.
 */

const s = (key: string, label: string, tone: StatusTone, extra: Partial<WorkflowState> = {}): WorkflowState => ({
  key,
  label,
  tone,
  terminal: false,
  locked: false,
  ...extra,
});

type T = Omit<WorkflowTransition, 'requiresReason' | 'guards' | 'optional' | 'enabled' | 'systemOnly' | 'confirm'> &
  Partial<WorkflowTransition>;
const t = (x: T): WorkflowTransition => ({
  requiresReason: false,
  guards: [],
  optional: false,
  enabled: true,
  systemOnly: false,
  confirm: false,
  ...x,
});
const sys = (x: Omit<T, 'permission'> & Partial<WorkflowTransition>) => t({ permission: 'system', systemOnly: true, ...x });

export interface WorkflowSeed {
  entity: WorkflowEntity;
  name: string;
  version: number;
  initialState: string;
  states: WorkflowState[];
  transitions: WorkflowTransition[];
}

const complaint: WorkflowSeed = {
  entity: 'complaint',
  name: 'Complaint lifecycle',
  version: 1,
  initialState: 'NEW',
  states: [
    s('NEW', 'New', 'info'),
    s('UNDER_REVIEW', 'Under Review', 'primary'),
    s('AWAITING_CUSTOMER_INFO', 'Awaiting Customer Information', 'warning'),
    s('ASSIGNED', 'Assigned', 'primary'),
    s('IN_PROGRESS', 'In Progress', 'accent'),
    s('SUBMITTED_FOR_REVIEW', 'Submitted for Review', 'warning'),
    s('RETURNED_FOR_CORRECTION', 'Returned for Correction', 'danger'),
    s('APPROVED', 'Approved', 'success'),
    s('RESOLVED', 'Resolved', 'success'),
    s('CUSTOMER_ACCEPTANCE_PENDING', 'Customer Acceptance Pending', 'warning'),
    s('CUSTOMER_ACCEPTED', 'Customer Accepted', 'success'),
    s('CLOSED', 'Closed', 'neutral', { terminal: true, locked: true }),
    s('DUPLICATE', 'Duplicate', 'neutral', { terminal: true, locked: true }),
    s('REJECTED', 'Rejected', 'neutral', { terminal: true, locked: true }),
    s('CANCELLED', 'Cancelled', 'neutral', { terminal: true, locked: true }),
    s('REOPENED', 'Reopened', 'danger'),
  ],
  transitions: [
    t({ action: 'startReview', label: 'Start review', from: ['NEW', 'REOPENED'], to: 'UNDER_REVIEW', permission: 'complaint.classify' }),
    t({
      action: 'requestInfo',
      label: 'Request information',
      from: ['NEW', 'UNDER_REVIEW'],
      to: 'AWAITING_CUSTOMER_INFO',
      permission: 'complaint.requestInfo',
      requiresReason: true,
    }),
    t({
      action: 'infoReceived',
      label: 'Information received',
      from: ['AWAITING_CUSTOMER_INFO'],
      to: 'UNDER_REVIEW',
      permission: 'complaint.update',
    }),
    t({
      action: 'markDuplicate',
      label: 'Mark as duplicate',
      from: ['NEW', 'UNDER_REVIEW', 'AWAITING_CUSTOMER_INFO'],
      to: 'DUPLICATE',
      permission: 'complaint.duplicate',
      requiresReason: true,
      guards: ['duplicateTargetValid'],
      confirm: true,
    }),
    t({
      action: 'reject',
      label: 'Reject',
      from: ['NEW', 'UNDER_REVIEW', 'AWAITING_CUSTOMER_INFO'],
      to: 'REJECTED',
      permission: 'complaint.reject',
      requiresReason: true,
      confirm: true,
    }),
    t({
      action: 'cancel',
      label: 'Cancel',
      from: ['NEW', 'UNDER_REVIEW', 'AWAITING_CUSTOMER_INFO', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED'],
      to: 'CANCELLED',
      permission: 'complaint.reject',
      requiresReason: true,
      guards: ['noActiveWorkOrders'],
      confirm: true,
    }),
    sys({
      action: 'assign',
      label: 'Assigned',
      from: ['UNDER_REVIEW', 'REOPENED'],
      to: 'ASSIGNED',
      guards: ['intakeComplete', 'classificationComplete'],
    }),
    sys({ action: 'startWork', label: 'Work started', from: ['ASSIGNED'], to: 'IN_PROGRESS' }),
    sys({
      action: 'submitForReview',
      label: 'Submitted for review',
      from: ['IN_PROGRESS', 'RETURNED_FOR_CORRECTION'],
      to: 'SUBMITTED_FOR_REVIEW',
    }),
    sys({ action: 'returnForCorrection', label: 'Returned for correction', from: ['SUBMITTED_FOR_REVIEW'], to: 'RETURNED_FOR_CORRECTION' }),
    sys({ action: 'approve', label: 'Technically approved', from: ['SUBMITTED_FOR_REVIEW'], to: 'APPROVED' }),
    t({
      action: 'resolve',
      label: 'Resolve',
      from: ['APPROVED'],
      to: 'RESOLVED',
      permission: 'complaint.resolve',
      guards: ['materialObligationsComplete', 'ncrObligationsComplete'],
      confirm: true,
    }),
    t({
      action: 'requestAcceptance',
      label: 'Request customer acceptance',
      from: ['RESOLVED'],
      to: 'CUSTOMER_ACCEPTANCE_PENDING',
      permission: 'acceptance.request',
    }),
    sys({ action: 'customerAccept', label: 'Customer accepted', from: ['CUSTOMER_ACCEPTANCE_PENDING'], to: 'CUSTOMER_ACCEPTED' }),
    sys({
      action: 'customerReject',
      label: 'Customer requested further action',
      from: ['CUSTOMER_ACCEPTANCE_PENDING'],
      to: 'REOPENED',
      requiresReason: true,
    }),
    t({
      action: 'waiveAcceptance',
      label: 'Waive customer acceptance',
      from: ['RESOLVED', 'CUSTOMER_ACCEPTANCE_PENDING'],
      to: 'CUSTOMER_ACCEPTED',
      permission: 'complaint.waiveAcceptance',
      requiresReason: true,
      confirm: true,
    }),
    t({
      action: 'close',
      label: 'Close',
      from: ['CUSTOMER_ACCEPTED'],
      to: 'CLOSED',
      permission: 'complaint.close',
      guards: ['closureConditionsMet'],
      confirm: true,
    }),
    t({
      action: 'reopen',
      label: 'Reopen',
      from: ['RESOLVED', 'CUSTOMER_ACCEPTANCE_PENDING', 'CUSTOMER_ACCEPTED', 'CLOSED'],
      to: 'REOPENED',
      permission: 'complaint.reopen',
      requiresReason: true,
      confirm: true,
    }),
  ],
};

const workOrder: WorkflowSeed = {
  entity: 'workOrder',
  name: 'Work order lifecycle',
  version: 1,
  initialState: 'DRAFT',
  states: [
    s('DRAFT', 'Draft', 'neutral'),
    s('ASSIGNED', 'Assigned', 'primary'),
    s('ACCEPTED', 'Accepted', 'info'),
    s('SCHEDULED', 'Scheduled', 'info'),
    s('IN_PROGRESS', 'In Progress', 'accent'),
    s('ON_HOLD', 'On Hold', 'warning'),
    s('WORK_COMPLETED', 'Work Completed', 'success'),
    s('SUBMITTED', 'Submitted', 'warning'),
    s('APPROVED', 'Approved', 'success'),
    s('CLOSED', 'Closed', 'neutral', { terminal: true, locked: true }),
    s('CANCELLED', 'Cancelled', 'neutral', { terminal: true, locked: true }),
  ],
  transitions: [
    t({ action: 'assign', label: 'Assign', from: ['DRAFT'], to: 'ASSIGNED', permission: 'workOrder.assign', guards: ['hasAssignees'] }),
    t({ action: 'accept', label: 'Accept work', from: ['ASSIGNED'], to: 'ACCEPTED', permission: 'workOrder.accept', guards: ['actorIsAssignee'] }),
    t({
      action: 'schedule',
      label: 'Mark scheduled',
      from: ['ACCEPTED'],
      to: 'SCHEDULED',
      permission: 'workOrder.update',
      optional: true,
      guards: ['plannedDateSet'],
    }),
    sys({ action: 'start', label: 'Work started', from: ['ACCEPTED', 'SCHEDULED'], to: 'IN_PROGRESS' }),
    t({ action: 'hold', label: 'Put on hold', from: ['IN_PROGRESS'], to: 'ON_HOLD', permission: 'workOrder.update', requiresReason: true, optional: true }),
    t({ action: 'resume', label: 'Resume', from: ['ON_HOLD'], to: 'IN_PROGRESS', permission: 'workOrder.update', optional: true }),
    sys({ action: 'completeWork', label: 'Work completed', from: ['IN_PROGRESS'], to: 'WORK_COMPLETED' }),
    sys({ action: 'submit', label: 'Report submitted', from: ['IN_PROGRESS', 'WORK_COMPLETED'], to: 'SUBMITTED' }),
    sys({ action: 'returnForCorrection', label: 'Report returned', from: ['SUBMITTED'], to: 'IN_PROGRESS' }),
    sys({ action: 'approve', label: 'Report approved', from: ['SUBMITTED'], to: 'APPROVED' }),
    sys({ action: 'close', label: 'Closed', from: ['APPROVED'], to: 'CLOSED' }),
    t({
      action: 'cancel',
      label: 'Cancel',
      from: ['DRAFT', 'ASSIGNED', 'ACCEPTED', 'SCHEDULED', 'ON_HOLD'],
      to: 'CANCELLED',
      permission: 'workOrder.cancel',
      requiresReason: true,
      confirm: true,
    }),
  ],
};

const visit: WorkflowSeed = {
  entity: 'visit',
  name: 'Site visit lifecycle (driven by the six time events)',
  version: 1,
  initialState: 'PLANNED',
  states: [
    s('PLANNED', 'Planned', 'neutral'),
    s('TRAVEL_STARTED', 'Travel Started', 'info'),
    s('ARRIVED', 'Arrived', 'primary'),
    s('WORK_STARTED', 'Work Started', 'accent'),
    s('WORK_ENDED', 'Work Ended', 'success'),
    s('RETURN_TRAVEL', 'Return Travel', 'info'),
    s('COMPLETED', 'Completed', 'success', { terminal: true }),
    s('CANCELLED', 'Cancelled', 'neutral', { terminal: true, locked: true }),
  ],
  transitions: [
    sys({ action: 'startTravel', label: 'Start Travel from Base', from: ['PLANNED'], to: 'TRAVEL_STARTED' }),
    sys({ action: 'arriveSite', label: 'Arrive at Site', from: ['TRAVEL_STARTED'], to: 'ARRIVED' }),
    sys({ action: 'startWork', label: 'Start Work at Site', from: ['ARRIVED'], to: 'WORK_STARTED' }),
    sys({ action: 'endWork', label: 'End Work at Site', from: ['WORK_STARTED'], to: 'WORK_ENDED' }),
    sys({ action: 'startReturn', label: 'Start Return Travel', from: ['WORK_ENDED'], to: 'RETURN_TRAVEL' }),
    sys({ action: 'arriveBase', label: 'Arrive at Base', from: ['RETURN_TRAVEL'], to: 'COMPLETED' }),
    t({ action: 'cancel', label: 'Cancel visit', from: ['PLANNED'], to: 'CANCELLED', permission: 'visit.update', requiresReason: true, confirm: true }),
  ],
};

const inspectionReport: WorkflowSeed = {
  entity: 'inspectionReport',
  name: 'Inspection report revision lifecycle',
  version: 1,
  initialState: 'DRAFT',
  states: [
    s('DRAFT', 'Draft', 'neutral'),
    s('SUBMITTED', 'Submitted', 'warning', { locked: true }),
    s('UNDER_REVIEW', 'Under Review', 'primary', { locked: true }),
    s('RETURNED', 'Returned', 'danger', { locked: true }),
    s('APPROVED', 'Approved', 'success', { terminal: true, locked: true }),
    s('SUPERSEDED', 'Superseded', 'neutral', { terminal: true, locked: true }),
  ],
  transitions: [
    t({
      action: 'submit',
      label: 'Submit for review',
      from: ['DRAFT'],
      to: 'SUBMITTED',
      permission: 'inspection.submit',
      guards: ['actorIsAssignee', 'reportComplete', 'timeSequenceComplete'],
      confirm: true,
    }),
    t({ action: 'startReview', label: 'Start review', from: ['SUBMITTED'], to: 'UNDER_REVIEW', permission: 'inspection.approve', guards: ['notSelfApproval'] }),
    t({
      action: 'approve',
      label: 'Approve',
      from: ['SUBMITTED', 'UNDER_REVIEW'],
      to: 'APPROVED',
      permission: 'inspection.approve',
      guards: ['notSelfApproval', 'approvalLevelsComplete'],
      confirm: true,
    }),
    t({
      action: 'return',
      label: 'Return for correction',
      from: ['SUBMITTED', 'UNDER_REVIEW'],
      to: 'RETURNED',
      permission: 'inspection.return',
      requiresReason: true,
      guards: ['notSelfApproval'],
      confirm: true,
    }),
    sys({ action: 'supersede', label: 'Superseded by new revision', from: ['RETURNED'], to: 'SUPERSEDED' }),
  ],
};

const materialRequest: WorkflowSeed = {
  entity: 'materialRequest',
  name: 'Material request lifecycle',
  version: 1,
  initialState: 'DRAFT',
  states: [
    s('DRAFT', 'Draft', 'neutral'),
    s('SUBMITTED', 'Submitted', 'warning'),
    s('CLARIFICATION_REQUIRED', 'Clarification Required', 'danger'),
    s('APPROVED', 'Approved', 'success'),
    s('PARTIALLY_ISSUED', 'Partially Issued', 'accent'),
    s('ISSUED', 'Issued', 'success'),
    s('REJECTED', 'Rejected', 'neutral', { terminal: true, locked: true }),
    s('RETURNED', 'Returned', 'info'),
    s('CLOSED', 'Closed', 'neutral', { terminal: true, locked: true }),
  ],
  transitions: [
    t({ action: 'submit', label: 'Submit', from: ['DRAFT', 'CLARIFICATION_REQUIRED'], to: 'SUBMITTED', permission: 'material.create', guards: ['actorIsRequester', 'hasLines'] }),
    t({
      action: 'requestClarification',
      label: 'Request clarification',
      from: ['SUBMITTED'],
      to: 'CLARIFICATION_REQUIRED',
      permission: 'material.approve',
      requiresReason: true,
      guards: ['notOwnRequest'],
    }),
    t({ action: 'approve', label: 'Approve', from: ['SUBMITTED'], to: 'APPROVED', permission: 'material.approve', guards: ['notOwnRequest'], confirm: true }),
    t({ action: 'reject', label: 'Reject', from: ['SUBMITTED'], to: 'REJECTED', permission: 'material.approve', requiresReason: true, guards: ['notOwnRequest'], confirm: true }),
    sys({ action: 'partialIssue', label: 'Partially issued', from: ['APPROVED', 'PARTIALLY_ISSUED'], to: 'PARTIALLY_ISSUED' }),
    sys({ action: 'issue', label: 'Fully issued', from: ['APPROVED', 'PARTIALLY_ISSUED'], to: 'ISSUED' }),
    sys({ action: 'returnMaterial', label: 'Material returned', from: ['PARTIALLY_ISSUED', 'ISSUED'], to: 'RETURNED' }),
    t({
      action: 'close',
      label: 'Close',
      from: ['ISSUED', 'PARTIALLY_ISSUED', 'RETURNED'],
      to: 'CLOSED',
      permission: 'material.approve',
      guards: ['noOutstandingReservations'],
      confirm: true,
    }),
  ],
};

const ncr: WorkflowSeed = {
  entity: 'ncr',
  name: 'NCR lifecycle',
  version: 1,
  initialState: 'OPEN',
  states: [
    s('OPEN', 'Open', 'danger'),
    s('ASSIGNED', 'Assigned', 'primary'),
    s('ACTION_IN_PROGRESS', 'Action in Progress', 'accent'),
    s('SUBMITTED_FOR_VERIFICATION', 'Submitted for Verification', 'warning'),
    s('RETURNED', 'Returned', 'danger'),
    s('VERIFIED', 'Verified', 'success'),
    s('CLOSED', 'Closed', 'neutral', { terminal: true, locked: true }),
  ],
  transitions: [
    t({ action: 'assign', label: 'Assign owner', from: ['OPEN'], to: 'ASSIGNED', permission: 'ncr.assign', guards: ['ownerSet'] }),
    t({ action: 'startAction', label: 'Start action', from: ['ASSIGNED', 'RETURNED'], to: 'ACTION_IN_PROGRESS', permission: 'ncr.update', guards: ['actorIsOwner'] }),
    t({
      action: 'submitForVerification',
      label: 'Submit for verification',
      from: ['ACTION_IN_PROGRESS'],
      to: 'SUBMITTED_FOR_VERIFICATION',
      permission: 'ncr.update',
      guards: ['actorIsOwner', 'ncrActionsRecorded'],
      confirm: true,
    }),
    t({
      action: 'return',
      label: 'Return',
      from: ['SUBMITTED_FOR_VERIFICATION'],
      to: 'RETURNED',
      permission: 'ncr.verify',
      requiresReason: true,
      guards: ['notSelfVerification'],
    }),
    t({
      action: 'verify',
      label: 'Verify',
      from: ['SUBMITTED_FOR_VERIFICATION'],
      to: 'VERIFIED',
      permission: 'ncr.verify',
      guards: ['notSelfVerification', 'verificationEvidencePresent'],
      confirm: true,
    }),
    t({ action: 'close', label: 'Close', from: ['VERIFIED'], to: 'CLOSED', permission: 'ncr.close', confirm: true }),
  ],
};

export const DEFAULT_WORKFLOWS: WorkflowSeed[] = [complaint, workOrder, visit, inspectionReport, materialRequest, ncr];
