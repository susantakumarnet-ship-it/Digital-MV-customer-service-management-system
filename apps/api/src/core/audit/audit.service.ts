import type { ClientSession, Types } from 'mongoose';
import type { RequestContext } from '../../common/context';
import { logger } from '../../common/logger';
import { AuditLog } from './audit.model';

const SENSITIVE_KEY = /pass(word)?|secret|token|hash|recovery|otp|mfa.?secret|authorization|cookie/i;
const MAX_STRING = 2000;
const MAX_DEPTH = 6;

/** Deep-copies a value removing secrets and bounding size, so audit payloads are always safe to display. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[…]';
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  // ObjectId / Decimal128 / Buffer → string form
  if ('_bsontype' in (value as object)) return String(value);
  if (Buffer.isBuffer(value)) return '[binary]';
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));
  const src = typeof (value as { toObject?: () => unknown }).toObject === 'function'
    ? (value as { toObject: () => Record<string, unknown> }).toObject()
    : (value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === '__v') continue;
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

/** Returns only the keys that changed between before/after (shallow), for compact audit entries. */
export function diff(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined) {
  const b = (redact(before ?? {}) as Record<string, unknown>) ?? {};
  const a = (redact(after ?? {}) as Record<string, unknown>) ?? {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};
  for (const k of keys) {
    if (['updatedAt', 'createdAt', 'updatedBy'].includes(k)) continue;
    if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) {
      changedBefore[k] = b[k];
      changedAfter[k] = a[k];
    }
  }
  return { before: changedBefore, after: changedAfter, changed: Object.keys(changedAfter) };
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | Types.ObjectId;
  entityRef?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  outcome?: 'SUCCESS' | 'FAILURE';
  meta?: Record<string, unknown>;
  /** Override actor (e.g. failed login where there is no authenticated user yet). */
  actorId?: string | Types.ObjectId;
  actorName?: string;
}

export async function audit(ctx: RequestContext, entry: AuditEntry, session?: ClientSession) {
  const doc = {
    actorId: entry.actorId ?? ctx.auth?.userId,
    actorName: entry.actorName ?? ctx.auth?.name ?? (ctx.requestId === 'system' ? 'System' : undefined),
    actorRoles: ctx.auth?.roles.map((r) => r.key ?? r.name) ?? [],
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    entityRef: entry.entityRef,
    before: entry.before === undefined ? undefined : redact(entry.before),
    after: entry.after === undefined ? undefined : redact(entry.after),
    reason: entry.reason,
    outcome: entry.outcome ?? 'SUCCESS',
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
    meta: entry.meta ? redact(entry.meta) : undefined,
    timestamp: new Date(),
  };
  try {
    await AuditLog.create([doc], { session });
  } catch (err) {
    // Inside a transaction the error must propagate so the business change is rolled back too.
    if (session) throw err;
    logger.error({ err, action: entry.action }, 'Failed to write audit log');
  }
}
