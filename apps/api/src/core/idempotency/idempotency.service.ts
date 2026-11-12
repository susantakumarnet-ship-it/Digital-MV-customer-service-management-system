import { createHash } from 'node:crypto';
import { Schema } from 'mongoose';
import { conflict, unprocessable } from '../../common/errors';
import { defineModel } from '../../db/model';

/**
 * Idempotency for critical writes (API-04, HO §9.1): a client-supplied `Idempotency-Key` makes a
 * retried request return the original response instead of creating a second record.
 * Keys are scoped (e.g. per route + user or IP) and expire after 24 hours.
 */
const idempotencySchema = new Schema(
  {
    key: { type: String, required: true },
    scope: { type: String, required: true },
    requestHash: { type: String, required: true },
    state: { type: String, enum: ['IN_PROGRESS', 'DONE'], default: 'IN_PROGRESS' },
    status: Number,
    response: Schema.Types.Mixed,
    createdAt: { type: Date, default: () => new Date() },
  },
  { collection: 'idempotencyKeys', versionKey: false },
);
idempotencySchema.index({ scope: 1, key: 1 }, { unique: true });
idempotencySchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 3600 });

export const IdempotencyKey = defineModel('IdempotencyKey', idempotencySchema);

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,100}$/;

export function hashRequest(parts: unknown[]) {
  const h = createHash('sha256');
  for (const p of parts) h.update(Buffer.isBuffer(p) ? p : JSON.stringify(p ?? null));
  return h.digest('hex');
}

/**
 * Runs `fn` at most once per (scope, key). A replay with the same payload returns the stored
 * response; a replay with a different payload is rejected (422); a concurrent duplicate gets 409.
 */
export async function withIdempotency<T>(
  key: string | undefined,
  scope: string,
  requestHash: string,
  fn: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  if (!key) {
    const r = await fn();
    return { ...r, replayed: false };
  }
  if (!IDEMPOTENCY_KEY_RE.test(key)) throw unprocessable('Invalid Idempotency-Key header', 'INVALID_IDEMPOTENCY_KEY');
  try {
    await IdempotencyKey.create({ key, scope, requestHash });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    const existing = await IdempotencyKey.findOne({ scope, key }).lean();
    if (!existing) throw conflict('Request is being processed, please retry', 'IDEMPOTENCY_IN_PROGRESS');
    if (existing.requestHash !== requestHash) {
      throw unprocessable('This Idempotency-Key was already used with a different request', 'IDEMPOTENCY_KEY_REUSED');
    }
    if (existing.state !== 'DONE') throw conflict('The original request is still being processed. Please wait and retry.', 'IDEMPOTENCY_IN_PROGRESS');
    return { status: existing.status ?? 200, body: existing.response as T, replayed: true };
  }
  try {
    const r = await fn();
    await IdempotencyKey.updateOne({ scope, key }, { $set: { state: 'DONE', status: r.status, response: r.body } });
    return { ...r, replayed: false };
  } catch (err) {
    // Failed attempts must not block a corrected retry with the same key.
    await IdempotencyKey.deleteOne({ scope, key });
    throw err;
  }
}
