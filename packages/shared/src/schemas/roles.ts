import { z } from 'zod';
import { isPermissionKey } from '../permissions';

const permissionKeys = z
  .array(z.string())
  .max(500)
  .superRefine((arr, ctx) => {
    arr.forEach((p, i) => {
      if (!isPermissionKey(p)) ctx.addIssue({ code: 'custom', path: [i], message: `Unknown permission: ${p}` });
    });
  })
  .transform((arr) => Array.from(new Set(arr)).sort());

export const roleCreateSchema = z.object({
  name: z.string().trim().min(2, 'Role name is required').max(80),
  description: z.string().trim().max(500).optional().or(z.literal('')),
  permissions: permissionKeys,
});
export type RoleCreateInput = z.infer<typeof roleCreateSchema>;

export const roleUpdateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(500).optional().or(z.literal('')),
  permissions: permissionKeys.optional(),
});
