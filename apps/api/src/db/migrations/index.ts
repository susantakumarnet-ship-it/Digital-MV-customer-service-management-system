import type { Db } from 'mongodb';
import { ALL_MODELS } from '../models';

export interface Migration {
  id: string;
  description: string;
  up: (db: Db) => Promise<void>;
  down: (db: Db) => Promise<void>;
}

/**
 * Ordered, versioned migrations (DB-05). Never edit a migration after it has run in any shared
 * environment — add a new one. Production runs with autoIndex disabled, so indexes are created here.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: '2026-11-12-001-initial-indexes',
    description: 'Create collections and indexes for the Phase 2 foundation',
    up: async () => {
      for (const model of ALL_MODELS) {
        await model.createCollection().catch(() => undefined);
        await model.createIndexes();
      }
    },
    down: async () => {
      // Index removal is intentionally not automated: dropping indexes on a live system is unsafe.
    },
  },
];
