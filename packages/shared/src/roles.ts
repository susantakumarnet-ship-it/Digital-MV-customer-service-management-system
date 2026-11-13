import { ALL_PERMISSIONS, type PermissionKey } from './permissions';

export const SYSTEM_ROLE_KEYS = [
  'ADMIN',
  'SUPERVISOR',
  'ENGINEER',
  'REVIEWER',
  'STOREKEEPER',
  'MANAGEMENT',
  'CUSTOMER',
  'PUBLIC_REPORTER',
] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

/** Roles whose holders must use MFA when the `security.mfaRequiredForPrivileged` setting is on (D-21). */
export const PRIVILEGED_ROLE_KEYS: SystemRoleKey[] = ['ADMIN', 'SUPERVISOR', 'REVIEWER'];

export interface SystemRoleDef {
  key: SystemRoleKey;
  name: string;
  description: string;
  /** PUBLIC_REPORTER represents unauthenticated access and can never be assigned to a user account. */
  assignable: boolean;
  permissions: PermissionKey[];
}

/**
 * Default permission sets per system role (HO §3). These are seeded once; administrators may
 * adjust them afterwards (BRF §6B). The seed never overwrites admin changes on re-run.
 */
export const SYSTEM_ROLES: SystemRoleDef[] = [
  {
    key: 'ADMIN',
    name: 'Administrator',
    description: 'Manages users, roles, master data, configuration, all complaints, reports and audit.',
    assignable: true,
    // Holds every permission so administrators can assign any role (anti-escalation rule). Acting
    // *as a customer* is additionally bound to customer identity / acceptance token in Phase 8.
    permissions: [...ALL_PERMISSIONS],
  },
  {
    key: 'SUPERVISOR',
    name: 'Service Supervisor',
    description: 'Reviews complaints, creates work orders, assigns staff, approves material requests, resolves and closes.',
    assignable: true,
    permissions: [
      'dashboard.supervisor',
      'notification.read',
      'master.read',
      'user.read',
      'complaint.create',
      'complaint.read',
      'complaint.readInternal',
      'complaint.update',
      'complaint.classify',
      'complaint.duplicate',
      'complaint.requestInfo',
      'complaint.reject',
      'complaint.resolve',
      'complaint.close',
      'complaint.reopen',
      'complaint.waiveAcceptance',
      'complaint.export',
      'workOrder.create',
      'workOrder.read',
      'workOrder.update',
      'workOrder.assign',
      'workOrder.cancel',
      'workOrder.export',
      'visit.read',
      'visit.create',
      'visit.update',
      'visit.approveCorrection',
      'inspection.read',
      'inspection.reviewTempAsset',
      'material.read',
      'material.approve',
      'material.export',
      'inventory.read',
      'ncr.read',
      'ncr.create',
      'ncr.assign',
      'ncr.update',
      'ncr.export',
      'acceptance.request',
      'acceptance.read',
      'report.read',
      'report.export',
      'report.viewPersonalData',
    ],
  },
  {
    key: 'ENGINEER',
    name: 'Field Engineer / Technician',
    description: 'Executes assigned work: visits, six-step time tracking, inspections, material requests and NCRs.',
    assignable: true,
    permissions: [
      'dashboard.engineer',
      'notification.read',
      'master.read',
      'complaint.read',
      'workOrder.read',
      'workOrder.accept',
      'visit.create',
      'visit.read',
      'visit.update',
      'visit.recordTime',
      'visit.requestCorrection',
      'inspection.read',
      'inspection.create',
      'inspection.submit',
      'material.read',
      'material.create',
      'ncr.read',
      'ncr.create',
      'ncr.update',
    ],
  },
  {
    key: 'REVIEWER',
    name: 'Reviewer / Quality Approver',
    description: 'Reviews submitted reports, evidence, time logs and NCRs; approves or returns with comments.',
    assignable: true,
    permissions: [
      'dashboard.reviewer',
      'notification.read',
      'master.read',
      'complaint.read',
      'complaint.readInternal',
      'workOrder.read',
      'visit.read',
      'visit.approveCorrection',
      'inspection.read',
      'inspection.approve',
      'inspection.return',
      'inspection.export',
      'ncr.read',
      'ncr.verify',
      'ncr.close',
      'ncr.update',
      'ncr.create',
      'material.read',
      'report.read',
    ],
  },
  {
    key: 'STOREKEEPER',
    name: 'Storekeeper',
    description: 'Issues and receives material against approved requests; maintains the stock ledger.',
    assignable: true,
    permissions: [
      'dashboard.storekeeper',
      'notification.read',
      'master.read',
      'workOrder.read',
      'material.read',
      'material.export',
      'inventory.read',
      'inventory.issue',
      'inventory.adjust',
    ],
  },
  {
    key: 'MANAGEMENT',
    name: 'Management Viewer',
    description: 'Read-only dashboards, trends, workload, overdue items and reports. Personal data masked.',
    assignable: true,
    permissions: [
      'dashboard.management',
      'notification.read',
      'master.read',
      'complaint.read',
      'complaint.export',
      'workOrder.read',
      'visit.read',
      'inspection.read',
      'material.read',
      'inventory.read',
      'ncr.read',
      'acceptance.read',
      'report.read',
      'report.export',
    ],
  },
  {
    key: 'CUSTOMER',
    name: 'Customer User',
    description: "Views own organisation's complaints, supplies requested information and accepts/rejects service.",
    assignable: true,
    permissions: ['dashboard.customer', 'notification.read', 'complaint.create', 'complaint.read', 'acceptance.decide'],
  },
  {
    key: 'PUBLIC_REPORTER',
    name: 'Public Reporter',
    description: 'Unauthenticated public complaint submission. Not assignable to user accounts.',
    assignable: false,
    permissions: [],
  },
];
