import { z } from 'zod';
import { password } from './common';

export const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'Email or username is required').max(254),
  password: z.string().min(1, 'Password is required').max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const mfaLoginSchema = z.object({
  challengeToken: z.string().min(10).max(2000),
  code: z.string().trim().min(6).max(20),
});
export type MfaLoginInput = z.infer<typeof mfaLoginSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
});

export const resetPasswordSchema = z
  .object({
    token: z.string().min(20).max(200),
    password,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: password,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ['newPassword'],
    message: 'New password must differ from the current password',
  });

export const mfaVerifySchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') });
export const mfaDisableSchema = z.object({
  password: z.string().min(1, 'Password is required'),
  code: z.string().trim().min(6).max(20),
});

export const profileUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(25).optional().or(z.literal('')),
  timezone: z.string().trim().max(60).optional().or(z.literal('')),
});

/** Shape returned by /auth/me and on login. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  username?: string;
  phone?: string;
  roles: { id: string; key?: string; name: string }[];
  permissions: string[];
  scope: { global: boolean; organizationIds: string[]; regionIds: string[]; siteIds: string[] };
  mfaEnabled: boolean;
  mfaRequired: boolean;
  timezone?: string;
  mustChangePassword: boolean;
}

export interface LoginResponse {
  accessToken?: string;
  expiresIn?: number;
  user?: AuthUser;
  mfaRequired?: boolean;
  mfaSetupRequired?: boolean;
  challengeToken?: string;
}
