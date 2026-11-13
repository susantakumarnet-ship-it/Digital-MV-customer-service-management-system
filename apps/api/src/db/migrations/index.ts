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
  {
    id: '2026-11-13-002-complaints',
    description: 'Phase 3: complaints, attachments and idempotency-key collections and indexes',
    up: async () => {
      const { Complaint } = await import('../../modules/complaints/complaint.model');
      const { Attachment } = await import('../../core/storage/attachment.model');
      const { IdempotencyKey } = await import('../../core/idempotency/idempotency.service');
      for (const model of [Complaint, Attachment, IdempotencyKey]) {
        await model.createCollection().catch(() => undefined);
        await model.createIndexes();
      }
    },
    down: async () => undefined,
  },
  {
    id: '2026-11-13-003-work-orders',
    description: 'Phase 4: workOrders collection/indexes; work-order workflow v2 (system "reassign" transition)',
    up: async (db) => {
      const { WorkOrder } = await import('../../modules/work-orders/work-order.model');
      await WorkOrder.createCollection().catch(() => undefined);
      await WorkOrder.createIndexes();
      const { DEFAULT_WORKFLOWS } = await import('../../core/workflow/workflow.definitions');
      const wo = DEFAULT_WORKFLOWS.find((w) => w.entity === 'workOrder')!;
      const reassign = wo.transitions.find((t) => t.action === 'reassign')!;
      // Add the transition only if missing; admin-edited labels/flags are preserved.
      await db
        .collection('workflowDefinitions')
        .updateOne(
          { entity: 'workOrder', 'transitions.action': { $ne: 'reassign' } },
          { $push: { transitions: reassign }, $set: { version: wo.version, updatedAt: new Date() } } as never,
        );
    },
    down: async (db) => {
      await db
        .collection('workflowDefinitions')
        .updateOne({ entity: 'workOrder' }, { $pull: { transitions: { action: 'reassign' } }, $set: { version: 1 } } as never);
    },
  },
  {
    id: '2026-11-13-004-visits-inspections',
    description: 'Phase 5: visits, timeEvents, timeCorrections, inspectionTemplates, inspectionReports collections and indexes',
    up: async () => {
      const { Visit, TimeEvent, TimeCorrection } = await import('../../modules/visits/visit.models');
      const { InspectionTemplate, InspectionReport } = await import('../../modules/inspections/inspection.models');
      for (const model of [Visit, TimeEvent, TimeCorrection, InspectionTemplate, InspectionReport]) {
        await model.createCollection().catch(() => undefined);
        await model.createIndexes();
      }
    },
    down: async () => undefined,
  },
  {
    id: '2026-11-13-005-review-actions',
    description: 'Phase 6: reviewActions collection and indexes',
    up: async () => {
      const { ReviewAction } = await import('../../modules/reviews/review.model');
      await ReviewAction.createCollection().catch(() => undefined);
      await ReviewAction.createIndexes();
    },
    down: async () => undefined,
  },
];
