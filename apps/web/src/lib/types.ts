import type { AuthUser, StatusTone, UserScope } from '@mv/shared';

/** Response DTO shapes (mirror apps/api serializers). */

export type Me = AuthUser & { restriction: 'MFA_SETUP_REQUIRED' | 'PASSWORD_CHANGE_REQUIRED' | null };

export interface UserDto {
  id: string;
  name: string;
  email: string;
  username?: string;
  phone?: string;
  jobTitle?: string;
  roleIds: string[];
  roles?: { id: string; key?: string; name: string }[];
  organizationId: string | null;
  organizationName?: string;
  scope: UserScope;
  status: 'ACTIVE' | 'INACTIVE' | 'LOCKED' | 'PENDING_ACTIVATION';
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  timezone?: string;
  deactivationReason?: string;
  createdAt: string;
  updatedAt: string;
  activeSessions?: number;
}

export interface RoleDto {
  id: string;
  key: string | null;
  name: string;
  description: string;
  permissions: string[];
  isSystem: boolean;
  assignable: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  userCount: number;
  updatedAt: string;
}

export interface ActivityRow {
  id: string;
  action: string;
  outcome: 'SUCCESS' | 'FAILURE';
  ip?: string;
  userAgent?: string;
  timestamp: string;
  meta?: Record<string, unknown>;
}

export interface SessionRow {
  id: string;
  userAgent?: string;
  ip?: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

export interface NotificationDto {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  severity: 'info' | 'success' | 'warning' | 'danger';
  readAt: string | null;
  createdAt: string;
}

export interface MasterOption {
  id: string;
  label: string;
  code: string;
  status: string;
  [parent: string]: string;
}

export type MasterRecord = Record<string, unknown> & {
  id: string;
  name: string;
  code: string;
  status: 'ACTIVE' | 'INACTIVE';
  _refs?: Record<string, string>;
  deactivationReason?: string;
  updatedAt?: string;
};

export interface AuditRow {
  id: string;
  timestamp: string;
  actorId: string | null;
  actorName: string | null;
  actorRoles: string[];
  action: string;
  entityType: string;
  entityId: string | null;
  entityRef: string | null;
  outcome: 'SUCCESS' | 'FAILURE';
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
}

export interface PublicSettings {
  applicationName: string;
  organizationName: string;
  timezone: string;
  dateFormat: string;
  supportEmail: string;
  supportPhone: string;
  publicForm?: { enabled: boolean; privacyNoticeVersion: string; privacyNoticeText: string };
  attachments?: { allowedExtensions: string[]; maxFileSizeMb: number; maxFilesPerRecord: number; maxTotalSizeMbPerRecord: number };
}

export interface AdminDashboardDto {
  users: { total: number; active: number; inactive: number; pendingActivation: number; locked: number };
  activeSessions24h: number;
  roles: number;
  loginFailures24h: number;
  loginTrend: { day: string; success: number; failure: number }[];
  roleDistribution: { role: string; users: number }[];
  masterData: { key: string; label: string; active: number; inactive: number }[];
  operational: { complaints: number | null; workOrders: number | null; materialRequests: number | null; ncrs: number | null };
  recentEvents: { id: string; timestamp: string; actorName: string; action: string; entityType: string; entityRef: string | null; outcome: string }[];
}

export type Tone = StatusTone;
