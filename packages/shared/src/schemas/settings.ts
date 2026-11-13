import { z } from 'zod';

/**
 * System settings (BRF §6D). Each group is stored as one systemSettings document keyed by group name.
 * Defaults reflect the provisional answers in the decisions register.
 */

const numbering = z.object({
  prefix: z.string().trim().min(1).max(10).regex(/^[A-Z0-9]+$/, 'Upper-case letters/numbers only'),
  padding: z.coerce.number().int().min(4).max(10),
  resetYearly: z.boolean(),
});

export const settingsSchemas = {
  general: z.object({
    applicationName: z.string().trim().min(1).max(120),
    organizationName: z.string().trim().max(120),
    timezone: z.string().trim().min(1).max(60),
    dateFormat: z.enum(['dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd']),
    supportEmail: z.string().trim().email().or(z.literal('')),
    supportPhone: z.string().trim().max(30),
  }),
  numbering: z.object({
    complaint: numbering,
    workOrder: numbering,
    visit: numbering,
    materialRequest: numbering,
    ncr: numbering,
  }),
  workflow: z.object({
    allowMultipleWorkOrdersPerComplaint: z.boolean(),
    allowConcurrentTimeSequences: z.boolean(),
    pauseSlaWhileAwaitingCustomer: z.boolean(),
    inspectionApprovalLevels: z.coerce.number().int().min(1).max(3),
    allowSelfApproval: z.boolean(),
    acceptanceTokenValidityDays: z.coerce.number().int().min(1).max(60),
    duplicateLookbackDays: z.coerce.number().int().min(1).max(365),
    repeatComplaintWindowDays: z.coerce.number().int().min(1).max(365),
    // REV-05 time-log warning thresholds (minutes).
    timeFlagMaxTravelMinutes: z.coerce.number().int().min(10).max(1440),
    timeFlagMaxWorkMinutes: z.coerce.number().int().min(30).max(2880),
    timeFlagMinWorkMinutes: z.coerce.number().int().min(0).max(120),
  }),
  attachments: z.object({
    allowedExtensions: z
      .array(z.string().trim().toLowerCase().regex(/^[a-z0-9]{1,8}$/))
      .min(1)
      .max(30),
    maxFileSizeMb: z.coerce.number().min(1).max(100),
    maxFilesPerRecord: z.coerce.number().int().min(1).max(50),
    maxTotalSizeMbPerRecord: z.coerce.number().min(1).max(500),
  }),
  security: z.object({
    mfaRequiredForPrivileged: z.boolean(),
    maxFailedLogins: z.coerce.number().int().min(3).max(20),
    lockoutMinutes: z.coerce.number().int().min(1).max(1440),
    sessionIdleTimeoutMinutes: z.coerce.number().int().min(5).max(1440),
    sessionAbsoluteTimeoutHours: z.coerce.number().int().min(1).max(720),
    passwordResetValidityMinutes: z.coerce.number().int().min(10).max(1440),
  }),
  notifications: z.object({
    emailEnabled: z.boolean(),
    smsEnabled: z.boolean(),
    whatsappEnabled: z.boolean(),
    dueSoonHours: z.coerce.number().int().min(1).max(720),
    digestHourLocal: z.coerce.number().int().min(0).max(23),
  }),
  ncr: z.object({
    categories: z.array(z.string().trim().min(1).max(80)).min(1).max(50),
    severities: z.array(z.string().trim().min(1).max(40)).min(1).max(10),
    defaultDueDays: z.coerce.number().int().min(1).max(365),
  }),
  publicForm: z.object({
    enabled: z.boolean(),
    privacyNoticeVersion: z.string().trim().min(1).max(20),
    privacyNoticeText: z.string().trim().min(1).max(5000),
    minimumFillSeconds: z.coerce.number().int().min(0).max(120),
    maxSubmissionsPerHourPerIp: z.coerce.number().int().min(1).max(1000),
  }),
} as const;

export type SettingsGroup = keyof typeof settingsSchemas;
export const SETTINGS_GROUPS = Object.keys(settingsSchemas) as SettingsGroup[];
export type Settings = { [K in SettingsGroup]: z.infer<(typeof settingsSchemas)[K]> };

const num = (prefix: string) => ({ prefix, padding: 6, resetYearly: true });

export const DEFAULT_SETTINGS: Settings = {
  general: {
    applicationName: 'Digital MV Customer Service Management System',
    organizationName: '',
    timezone: 'UTC',
    dateFormat: 'dd/MM/yyyy',
    supportEmail: '',
    supportPhone: '',
  },
  numbering: {
    complaint: num('MV'),
    workOrder: num('WO'),
    visit: num('VIS'),
    materialRequest: num('MR'),
    ncr: num('NCR'),
  },
  workflow: {
    allowMultipleWorkOrdersPerComplaint: true,
    allowConcurrentTimeSequences: false,
    pauseSlaWhileAwaitingCustomer: false,
    inspectionApprovalLevels: 1,
    allowSelfApproval: false,
    acceptanceTokenValidityDays: 7,
    duplicateLookbackDays: 30,
    repeatComplaintWindowDays: 30,
    timeFlagMaxTravelMinutes: 240,
    timeFlagMaxWorkMinutes: 720,
    timeFlagMinWorkMinutes: 5,
  },
  attachments: {
    allowedExtensions: ['jpg', 'jpeg', 'png', 'heic', 'pdf', 'docx', 'xlsx'],
    maxFileSizeMb: 10,
    maxFilesPerRecord: 10,
    maxTotalSizeMbPerRecord: 50,
  },
  security: {
    mfaRequiredForPrivileged: false,
    maxFailedLogins: 5,
    lockoutMinutes: 15,
    sessionIdleTimeoutMinutes: 60,
    sessionAbsoluteTimeoutHours: 12,
    passwordResetValidityMinutes: 60,
  },
  notifications: {
    emailEnabled: true,
    smsEnabled: false,
    whatsappEnabled: false,
    dueSoonHours: 24,
    digestHourLocal: 7,
  },
  ncr: {
    categories: ['Workmanship', 'Material/Component defect', 'Design/Specification', 'Safety', 'Documentation', 'Supplier/Contractor', 'Customer-caused', 'Other'],
    severities: ['Critical', 'Major', 'Minor', 'Observation'],
    defaultDueDays: 14,
  },
  publicForm: {
    enabled: true,
    privacyNoticeVersion: '1.0',
    privacyNoticeText:
      'The information you provide will be used to register, investigate and resolve your complaint and to contact you about it. It is stored securely and shared only with staff and contractors involved in resolving the complaint.',
    minimumFillSeconds: 5,
    maxSubmissionsPerHourPerIp: 10,
  },
};

export function formatReference(cfg: { prefix: string; padding: number; resetYearly: boolean }, year: number, seq: number) {
  const n = String(seq).padStart(cfg.padding, '0');
  return cfg.resetYearly ? `${cfg.prefix}-${year}-${n}` : `${cfg.prefix}-${n}`;
}
