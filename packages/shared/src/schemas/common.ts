import { z } from 'zod';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid identifier');

export const trimmed = (max = 200) => z.string().trim().max(max);
export const requiredText = (label: string, max = 200) =>
  z.string({ required_error: `${label} is required` }).trim().min(1, `${label} is required`).max(max);

export const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);

/** E.164-ish: optional +, 7–15 digits, spaces/dashes/brackets allowed in input. */
export const phone = z
  .string()
  .trim()
  .max(25)
  .refine((v) => /^\+?[\d\s\-()]{7,25}$/.test(v) && v.replace(/\D/g, '').length >= 7 && v.replace(/\D/g, '').length <= 15, {
    message: 'Enter a valid mobile number',
  });

export const code = z
  .string()
  .trim()
  .min(1, 'Code is required')
  .max(40)
  .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore only')
  .transform((v) => v.toUpperCase());

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().trim().max(60).optional(),
  q: z.string().trim().max(120).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

/** Query-string boolean: only "true"/"1" are true (z.coerce.boolean would treat "false" as true). */
export const queryBool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

export const statusFilter = z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ACTIVE');

export const reasonBody = z.object({
  reason: requiredText('Reason', 1000),
});

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface Paged<T> {
  data: T[];
  meta: PageMeta;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
    requestId?: string;
  };
}

/** Strong password policy used everywhere a password is set. */
export const password = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password is too long')
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), {
    message: 'Password must include upper-case, lower-case and a number',
  });
