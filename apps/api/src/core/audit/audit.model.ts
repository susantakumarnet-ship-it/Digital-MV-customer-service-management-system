import { Schema, type InferSchemaType } from 'mongoose';
import { defineModel } from '../../db/model';

/**
 * Immutable audit log (HO §8, §11; BRF §21). Append-only: every update/delete path throws.
 * In production the DB user should additionally be granted only insert+find on this collection.
 */
const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorName: String,
    actorRoles: [String],
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId },
    /** Human-readable reference such as MV-2026-000001 or a user email. */
    entityRef: String,
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    reason: String,
    outcome: { type: String, enum: ['SUCCESS', 'FAILURE'], default: 'SUCCESS' },
    ip: String,
    userAgent: String,
    requestId: String,
    meta: Schema.Types.Mixed,
    timestamp: { type: Date, required: true, default: () => new Date() },
  },
  { collection: 'auditLogs', versionKey: false },
);

auditLogSchema.index({ entityType: 1, entityId: 1, timestamp: -1 });
auditLogSchema.index({ actorId: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ timestamp: -1 });

const immutable = function () {
  throw new Error('Audit log entries are immutable');
};
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const) {
  auditLogSchema.pre(op, immutable);
}
auditLogSchema.pre('save', function (next) {
  if (!this.isNew) return next(new Error('Audit log entries are immutable'));
  next();
});

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema>;
export const AuditLog = defineModel('AuditLog', auditLogSchema);
