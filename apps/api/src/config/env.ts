import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().default(4610),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required (see apps/api/.env.example)'),
    MONGODB_DB: z.string().min(1).default('MVServiceMgmt'),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    /** 32-byte key, base64. Encrypts MFA secrets at rest. */
    MFA_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'MFA_ENCRYPTION_KEY must be 32 bytes base64'),
    MFA_ISSUER: z.string().default('Digital MV CSMS'),

    WEB_ORIGINS: z.string().default('http://localhost:5610'),
    PUBLIC_APP_URL: z.string().url().default('http://localhost:5610'),
    COOKIE_SECURE: bool,
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),

    MAIL_TRANSPORT: z.enum(['file', 'smtp', 'none']).default('file'),
    MAIL_FROM: z.string().default('Digital MV CSMS <no-reply@localhost>'),
    MAIL_DIR: z.string().default('var/mail'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().optional(),
    SMTP_SECURE: bool,
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),

    SEED_ADMIN_EMAIL: z.string().email().optional(),
    SEED_ADMIN_PASSWORD: z.string().optional(),
    SEED_DEMO_PASSWORD: z.string().optional(),

    API_DOCS_ENABLED: bool,
    /** Sign-in attempts allowed per IP per 15 minutes (SEC-03). Keep the default in production. */
    LOGIN_RATE_LIMIT_PER_15_MIN: z.coerce.number().int().min(5).max(10_000).default(20),

    // Private file storage (SEC-05). local = private folder outside the web root (dev/UAT);
    // s3 = any S3-compatible bucket (AWS S3, MinIO, Cloudflare R2, Azure via gateway…).
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('var/storage'),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_ENDPOINT: z.string().url().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: bool,
    /** HMAC key for signed download URLs (local driver). Defaults to a key derived from JWT_ACCESS_SECRET. */
    FILE_URL_SECRET: z.string().min(32).optional(),
    SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    /** Optional ClamAV daemon for upload scanning (D-23). */
    CLAMAV_HOST: z.string().optional(),
    CLAMAV_PORT: z.coerce.number().int().default(3310),

    // Optional Cloudflare Turnstile CAPTCHA for the public form (D-16/D-32).
    TURNSTILE_SITE_KEY: z.string().optional(),
    TURNSTILE_SECRET_KEY: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.MAIL_TRANSPORT === 'smtp' && !env.SMTP_HOST) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_HOST'], message: 'SMTP_HOST is required when MAIL_TRANSPORT=smtp' });
    }
    if (env.STORAGE_DRIVER === 's3' && !env.S3_BUCKET) {
      ctx.addIssue({ code: 'custom', path: ['S3_BUCKET'], message: 'S3_BUCKET is required when STORAGE_DRIVER=s3' });
    }
    if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
      ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'COOKIE_SECURE must be true in production' });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: force re-read of process.env. */
export function resetEnvCache() {
  cached = undefined;
}

export const isProd = () => env().NODE_ENV === 'production';
