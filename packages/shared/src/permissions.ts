/**
 * Permission catalogue. Keys are `module.action`. Default deny: a user holds a permission
 * only if one of their roles grants it explicitly (HO §3.1, BRF §6B).
 * Permission KEYS are stable contract; role → permission assignments are configurable data.
 */

export interface PermissionActionDef {
  action: string;
  label: string;
}

export interface PermissionModuleDef {
  module: string;
  label: string;
  /** Phase in which the module's endpoints become available (informational for the admin UI). */
  phase: number;
  actions: PermissionActionDef[];
}

const a = (action: string, label: string): PermissionActionDef => ({ action, label });

export const PERMISSION_CATALOG = [
  {
    module: 'dashboard',
    label: 'Dashboards',
    phase: 2,
    actions: [
      a('admin', 'View administrator dashboard'),
      a('supervisor', 'View supervisor dashboard'),
      a('engineer', 'View engineer dashboard'),
      a('reviewer', 'View reviewer dashboard'),
      a('storekeeper', 'View storekeeper dashboard'),
      a('management', 'View management dashboard'),
      a('customer', 'View customer dashboard'),
    ],
  },
  {
    module: 'user',
    label: 'Users',
    phase: 2,
    actions: [
      a('read', 'View users'),
      a('create', 'Create users'),
      a('update', 'Edit users and scope'),
      a('administer', 'Activate/deactivate users, reset passwords, assign roles'),
    ],
  },
  {
    module: 'role',
    label: 'Roles & permissions',
    phase: 2,
    actions: [a('read', 'View roles'), a('create', 'Create roles'), a('update', 'Edit role permissions')],
  },
  {
    module: 'master',
    label: 'Master data',
    phase: 2,
    actions: [
      a('read', 'View master data'),
      a('create', 'Create master records'),
      a('update', 'Edit / activate / deactivate master records'),
      a('import', 'Bulk import master data'),
    ],
  },
  {
    module: 'settings',
    label: 'System configuration',
    phase: 2,
    actions: [a('read', 'View configuration'), a('update', 'Change configuration')],
  },
  {
    module: 'workflow',
    label: 'Workflow configuration',
    phase: 2,
    actions: [a('read', 'View workflows'), a('update', 'Change status labels and optional transitions')],
  },
  {
    module: 'audit',
    label: 'Audit log',
    phase: 2,
    actions: [a('read', 'Search audit history'), a('export', 'Export audit history')],
  },
  {
    module: 'notification',
    label: 'Notifications',
    phase: 2,
    actions: [a('read', 'Receive and read own notifications')],
  },
  {
    module: 'complaint',
    label: 'Complaints',
    phase: 3,
    actions: [
      a('create', 'Register complaints internally'),
      a('read', 'View complaints'),
      a('readInternal', 'View internal notes'),
      a('update', 'Edit complaint details and add notes'),
      a('classify', 'Review, classify and set priority'),
      a('duplicate', 'Mark and link duplicates'),
      a('requestInfo', 'Request information from customer'),
      a('reject', 'Reject or cancel complaints'),
      a('resolve', 'Resolve complaints'),
      a('close', 'Close complaints'),
      a('reopen', 'Reopen complaints'),
      a('waiveAcceptance', 'Record customer-acceptance waiver'),
      a('export', 'Export complaints'),
    ],
  },
  {
    module: 'workOrder',
    label: 'Work orders',
    phase: 4,
    actions: [
      a('create', 'Create work orders'),
      a('read', 'View work orders'),
      a('update', 'Edit work orders'),
      a('assign', 'Assign engineers'),
      a('accept', 'Accept assigned work'),
      a('cancel', 'Cancel work orders'),
      a('export', 'Export work orders'),
    ],
  },
  {
    module: 'visit',
    label: 'Site visits & time',
    phase: 5,
    actions: [
      a('create', 'Create visits'),
      a('read', 'View visits and time logs'),
      a('update', 'Update visits'),
      a('recordTime', 'Record own time events'),
      a('requestCorrection', 'Request time corrections'),
      a('approveCorrection', 'Approve/reject time corrections'),
    ],
  },
  {
    module: 'inspection',
    label: 'Inspections & reports',
    phase: 5,
    actions: [
      a('read', 'View inspection reports'),
      a('create', 'Create and edit draft reports'),
      a('submit', 'Submit reports for review'),
      a('approve', 'Approve reports'),
      a('return', 'Return reports for correction'),
      a('manageTemplates', 'Manage checklist templates'),
      a('reviewTempAsset', 'Approve temporary assets'),
      a('export', 'Export inspection reports'),
    ],
  },
  {
    module: 'material',
    label: 'Material requests',
    phase: 7,
    actions: [
      a('read', 'View material requests'),
      a('create', 'Raise material requests'),
      a('approve', 'Approve/reject/clarify requests'),
      a('export', 'Export material data'),
    ],
  },
  {
    module: 'inventory',
    label: 'Inventory & store',
    phase: 7,
    actions: [
      a('read', 'View stock and ledger'),
      a('issue', 'Reserve / issue / return material'),
      a('adjust', 'Receive stock and record adjustments'),
    ],
  },
  {
    module: 'ncr',
    label: 'Non-conformance reports',
    phase: 8,
    actions: [
      a('read', 'View NCRs'),
      a('create', 'Raise NCRs'),
      a('update', 'Update NCR actions (owner)'),
      a('assign', 'Assign NCR owner'),
      a('verify', 'Verify / return NCRs'),
      a('close', 'Close NCRs'),
      a('export', 'Export NCRs'),
    ],
  },
  {
    module: 'acceptance',
    label: 'Customer acceptance',
    phase: 8,
    actions: [
      a('request', 'Send customer acceptance requests'),
      a('decide', 'Accept/reject service as customer'),
      a('read', 'View acceptance records'),
    ],
  },
  {
    module: 'report',
    label: 'Reports & analytics',
    phase: 9,
    actions: [
      a('read', 'View reports'),
      a('export', 'Export reports'),
      a('viewPersonalData', 'See unmasked personal data in reports'),
    ],
  },
] as const satisfies readonly PermissionModuleDef[];

type Catalog = typeof PERMISSION_CATALOG;
type ModuleEntry = Catalog[number];
export type PermissionKey = {
  [M in ModuleEntry as M['module']]: `${M['module']}.${M['actions'][number]['action']}`;
}[ModuleEntry['module']];

export const ALL_PERMISSIONS: PermissionKey[] = PERMISSION_CATALOG.flatMap((m) =>
  m.actions.map((x) => `${m.module}.${x.action}` as PermissionKey),
);

const ALL_SET = new Set<string>(ALL_PERMISSIONS);
export function isPermissionKey(value: string): value is PermissionKey {
  return ALL_SET.has(value);
}

/** Convenience constant: P.complaint.read === 'complaint.read' with type safety. */
export const P = Object.fromEntries(
  PERMISSION_CATALOG.map((m) => [m.module, Object.fromEntries(m.actions.map((x) => [x.action, `${m.module}.${x.action}`]))]),
) as {
  [M in ModuleEntry as M['module']]: { [A in M['actions'][number] as A['action']]: `${M['module']}.${A['action']}` };
};
