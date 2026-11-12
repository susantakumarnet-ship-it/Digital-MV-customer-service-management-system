import { Schema, type ClientSession } from 'mongoose';
import { defineModel } from '../../db/model';
import { formatReference, type Settings } from '@mv/shared';
import { getSettingsGroup } from '../settings/settings.service';

/** Atomic sequence counters for reference numbers (BR-001, HO §8 `counters`). */
const counterSchema = new Schema(
  {
    key: { type: String, required: true },
    year: { type: Number, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { collection: 'counters', versionKey: false, timestamps: true },
);
counterSchema.index({ key: 1, year: 1 }, { unique: true });

export const Counter = defineModel('Counter', counterSchema);

/**
 * Atomically increments and returns the next sequence. A single findOneAndUpdate with $inc is atomic
 * on the server, so concurrent callers can never receive the same number. Upsert races on first use
 * are handled by retrying on duplicate-key.
 */
export async function nextSequence(key: string, year: number, session?: ClientSession): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const doc = await Counter.findOneAndUpdate(
        { key, year },
        { $inc: { seq: 1 } },
        { upsert: true, new: true, session, setDefaultsOnInsert: true },
      ).lean<{ seq: number }>();
      return doc!.seq;
    } catch (err) {
      if ((err as { code?: number }).code === 11000 && attempt < 2) continue;
      throw err;
    }
  }
  throw new Error('Unable to allocate sequence');
}

export type ReferenceKind = keyof Settings['numbering'];

/** Generates e.g. MV-2026-000001 using the configured numbering rules (CFG-01). */
export async function nextReference(kind: ReferenceKind, session?: ClientSession, now = new Date()) {
  const numbering = await getSettingsGroup('numbering');
  const cfg = numbering[kind];
  const year = now.getUTCFullYear();
  const seq = await nextSequence(kind, cfg.resetYearly ? year : 0, session);
  return formatReference(cfg, year, seq);
}
