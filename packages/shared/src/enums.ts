/**
 * Fixed vocabularies mandated by business rules (not configurable).
 * Status *keys* for workflow entities are defined by the workflow definitions (configurable labels);
 * the constants below are the keys the code relies on for guards.
 */

/** BR-010 / HO §4.4 — exactly six ordered events. Order is the array index + 1. */
export const TIME_EVENT_TYPES = [
  'START_TRAVEL',
  'ARRIVE_SITE',
  'START_WORK',
  'END_WORK',
  'START_RETURN',
  'ARRIVE_BASE',
] as const;
export type TimeEventType = (typeof TIME_EVENT_TYPES)[number];

export const TIME_EVENT_LABELS: Record<TimeEventType, string> = {
  START_TRAVEL: 'Start Travel from Base',
  ARRIVE_SITE: 'Arrive at Site',
  START_WORK: 'Start Work at Site',
  END_WORK: 'End Work at Site',
  START_RETURN: 'Start Return Travel',
  ARRIVE_BASE: 'Arrive at Base',
};

/** BR-006 */
export const INSPECTION_RESULTS = ['PASS', 'FAIL', 'NOT_CHECKED', 'NOT_APPLICABLE'] as const;
export type InspectionResult = (typeof INSPECTION_RESULTS)[number];

export const WORKFLOW_ENTITIES = [
  'complaint',
  'workOrder',
  'visit',
  'inspectionReport',
  'materialRequest',
  'ncr',
] as const;
export type WorkflowEntity = (typeof WORKFLOW_ENTITIES)[number];

export const USER_STATUSES = ['ACTIVE', 'INACTIVE', 'LOCKED', 'PENDING_ACTIVATION'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const MASTER_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type MasterStatus = (typeof MASTER_STATUSES)[number];

export const STATUS_TONES = ['neutral', 'info', 'primary', 'warning', 'success', 'danger', 'accent'] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

export const AUDIT_ACTIONS = {
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILURE: 'auth.login.failure',
  LOGIN_LOCKED: 'auth.login.locked',
  LOGOUT: 'auth.logout',
  TOKEN_REUSE: 'auth.refresh.reuseDetected',
  PASSWORD_RESET_REQUESTED: 'auth.password.resetRequested',
  PASSWORD_RESET: 'auth.password.reset',
  PASSWORD_CHANGED: 'auth.password.changed',
  MFA_ENABLED: 'auth.mfa.enabled',
  MFA_DISABLED: 'auth.mfa.disabled',
  SESSION_REVOKED: 'auth.session.revoked',
  CREATE: 'create',
  UPDATE: 'update',
  ACTIVATE: 'activate',
  DEACTIVATE: 'deactivate',
  TRANSITION: 'transition',
  ROLE_PERMISSIONS_CHANGED: 'role.permissions.changed',
  USER_ROLES_CHANGED: 'user.roles.changed',
  USER_SCOPE_CHANGED: 'user.scope.changed',
  ADMIN_PASSWORD_RESET: 'user.password.adminReset',
  SETTINGS_CHANGED: 'settings.changed',
  WORKFLOW_CHANGED: 'workflow.changed',
  IMPORT: 'master.import',
  EXPORT: 'export',
} as const;
