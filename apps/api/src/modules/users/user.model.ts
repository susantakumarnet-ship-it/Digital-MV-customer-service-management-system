import { Schema, type InferSchemaType, type Types } from 'mongoose';
import { USER_STATUSES } from '@mv/shared';
import { defineModel } from '../../db/model';

const scopeSchema = new Schema(
  {
    global: { type: Boolean, default: false },
    organizationIds: [{ type: Schema.Types.ObjectId, ref: 'Organization' }],
    regionIds: [{ type: Schema.Types.ObjectId, ref: 'Region' }],
    siteIds: [{ type: Schema.Types.ObjectId, ref: 'Site' }],
  },
  { _id: false },
);

const mfaSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    /** AES-256-GCM encrypted TOTP secret. */
    secretEnc: { type: String, select: false },
    pendingSecretEnc: { type: String, select: false },
    recoveryCodeHashes: { type: [String], select: false, default: [] },
    enabledAt: Date,
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    username: { type: String, lowercase: true, trim: true },
    phone: String,
    jobTitle: String,
    passwordHash: { type: String, select: false },
    roleIds: [{ type: Schema.Types.ObjectId, ref: 'Role' }],
    /** Home organisation (required for customer users). */
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization' },
    scope: { type: scopeSchema, default: () => ({}) },
    status: { type: String, enum: USER_STATUSES, default: 'ACTIVE' },
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: Date,
    lastLoginAt: Date,
    lastLoginIp: String,
    mfa: { type: mfaSchema, default: () => ({}) },
    mustChangePassword: { type: Boolean, default: false },
    passwordChangedAt: Date,
    timezone: String,
    deactivatedAt: Date,
    deactivationReason: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { collection: 'users', timestamps: true, versionKey: false },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index(
  { username: 1 },
  { unique: true, partialFilterExpression: { username: { $type: 'string' } } },
);
userSchema.index({ status: 1, name: 1 });
userSchema.index({ roleIds: 1 });
userSchema.index({ organizationId: 1 });

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };
export const User = defineModel('User', userSchema);

/** Safe public projection — never includes secrets (SEC-08). */
export function toUserDto(u: Record<string, any>) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    username: u.username ?? undefined,
    phone: u.phone ?? undefined,
    jobTitle: u.jobTitle ?? undefined,
    roleIds: (u.roleIds ?? []).map((r: any) => String(r._id ?? r)),
    roles: Array.isArray(u.roleIds) && u.roleIds[0]?.name
      ? u.roleIds.map((r: any) => ({ id: String(r._id), key: r.key ?? undefined, name: r.name }))
      : undefined,
    organizationId: u.organizationId ? String(u.organizationId._id ?? u.organizationId) : null,
    organizationName: u.organizationId?.name ?? undefined,
    scope: {
      global: Boolean(u.scope?.global),
      organizationIds: (u.scope?.organizationIds ?? []).map(String),
      regionIds: (u.scope?.regionIds ?? []).map(String),
      siteIds: (u.scope?.siteIds ?? []).map(String),
    },
    status: effectiveStatus(u),
    mfaEnabled: Boolean(u.mfa?.enabled),
    mustChangePassword: Boolean(u.mustChangePassword),
    lastLoginAt: u.lastLoginAt ?? null,
    lockedUntil: u.lockedUntil && new Date(u.lockedUntil) > new Date() ? u.lockedUntil : null,
    timezone: u.timezone ?? undefined,
    deactivationReason: u.deactivationReason ?? undefined,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export function effectiveStatus(u: { status?: string; lockedUntil?: Date | null }) {
  if (u.status === 'ACTIVE' && u.lockedUntil && new Date(u.lockedUntil) > new Date()) return 'LOCKED';
  return u.status ?? 'ACTIVE';
}
