import { z } from 'zod';
import { email, objectId, password, paginationQuery } from './common';

export const userScopeSchema = z.object({
  global: z.boolean().default(false),
  organizationIds: z.array(objectId).max(500).default([]),
  regionIds: z.array(objectId).max(500).default([]),
  siteIds: z.array(objectId).max(2000).default([]),
});
export type UserScope = z.infer<typeof userScopeSchema>;

const username = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Username must be at least 3 characters')
  .max(60)
  .regex(/^[a-z0-9._-]+$/, 'Use lower-case letters, numbers, dot, dash or underscore');

export const userCreateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  email,
  username: username.optional().or(z.literal('')),
  phone: z.string().trim().max(25).optional().or(z.literal('')),
  jobTitle: z.string().trim().max(120).optional().or(z.literal('')),
  roleIds: z.array(objectId).min(1, 'Assign at least one role').max(10),
  organizationId: objectId.optional().nullable(),
  scope: userScopeSchema,
  /** Optional initial password. When omitted, the user receives a set-password (activation) email. */
  password: password.optional(),
  mustChangePassword: z.boolean().default(true),
});
export type UserCreateInput = z.infer<typeof userCreateSchema>;

export const userUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: email.optional(),
  username: username.optional().or(z.literal('')),
  phone: z.string().trim().max(25).optional().or(z.literal('')),
  jobTitle: z.string().trim().max(120).optional().or(z.literal('')),
  organizationId: objectId.optional().nullable(),
});

export const userRolesSchema = z.object({ roleIds: z.array(objectId).min(1).max(10) });
export const userScopeUpdateSchema = z.object({ scope: userScopeSchema });

export const userAdminResetSchema = z.object({
  /** When omitted a reset link is emailed to the user instead. */
  password: password.optional(),
  mustChangePassword: z.boolean().default(true),
});

export const userListQuery = paginationQuery.extend({
  status: z.enum(['ACTIVE', 'INACTIVE', 'LOCKED', 'PENDING_ACTIVATION', 'ALL']).default('ALL'),
  roleId: objectId.optional(),
  organizationId: objectId.optional(),
});
