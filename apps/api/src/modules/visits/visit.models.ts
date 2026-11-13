import { Schema, type InferSchemaType, type Types } from 'mongoose';
import { TIME_EVENT_TYPES } from '@mv/shared';
import { defineModel } from '../../db/model';
import { statusHistorySchema } from '../../core/workflow/workflow.model';

const ref = (model: string) => ({ type: Schema.Types.ObjectId, ref: model });

const gpsSchema = new Schema(
  { latitude: Number, longitude: Number, accuracy: Number, capturedAt: Date },
  { _id: false },
);

/** Site visit (HO §8 `visits`). Status is derived from the engineers' time events (D-34). */
const visitSchema = new Schema(
  {
    visitNo: { type: String, required: true },
    workOrderId: { ...ref('WorkOrder'), required: true },
    workOrderNo: { type: String, required: true },
    complaintId: { ...ref('Complaint'), required: true },
    complaintRef: { type: String, required: true },
    organizationId: { ...ref('Organization'), required: true },
    regionId: { ...ref('Region'), required: true },
    siteId: { ...ref('Site'), required: true },
    siteName: String,
    engineerIds: { type: [ref('User')], default: [] },
    plannedAt: Date,
    purpose: { type: String, required: true },
    attendees: String,
    notes: String,
    status: { type: String, required: true, default: 'PLANNED' },
    statusHistory: { type: [statusHistorySchema], default: [] },
    startedAt: Date,
    completedAt: Date,
    cancelledAt: Date,
    createdBy: ref('User'),
  },
  { collection: 'visits', timestamps: true, versionKey: false },
);
visitSchema.index({ visitNo: 1 }, { unique: true });
visitSchema.index({ workOrderId: 1, createdAt: 1 }); // HO §8.2
visitSchema.index({ engineerIds: 1, status: 1 }); // HO §8.2 (engineerId + status)
visitSchema.index({ plannedAt: 1 });

export type VisitDoc = InferSchemaType<typeof visitSchema> & { _id: Types.ObjectId };
export const Visit = defineModel('Visit', visitSchema);
export const VISIT_SCOPE = { organization: 'organizationId', region: 'regionId', site: 'siteId', personal: ['engineerIds', 'createdBy'] };

/**
 * One of the six ordered time events (BR-010). The server timestamp is authoritative and is never
 * modified; an approved correction is stored alongside as `correctedTimestamp` (BR-011). Events are
 * never deleted (TIME-08).
 */
const timeEventSchema = new Schema(
  {
    visitId: { ...ref('Visit'), required: true },
    workOrderId: { ...ref('WorkOrder'), required: true },
    userId: { ...ref('User'), required: true },
    eventType: { type: String, enum: TIME_EVENT_TYPES, required: true },
    sequence: { type: Number, required: true, min: 1, max: 6 },
    serverTimestamp: { type: Date, required: true, immutable: true },
    clientTimestamp: Date,
    gps: gpsSchema,
    note: String,
    correctedTimestamp: Date,
    correctionId: ref('TimeCorrection'),
    recordedByName: String,
    ip: String,
  },
  { collection: 'timeEvents', timestamps: true, versionKey: false },
);
// Makes duplicate events impossible even under concurrent requests (TIME-03).
timeEventSchema.index({ visitId: 1, userId: 1, eventType: 1 }, { unique: true });
timeEventSchema.index({ visitId: 1, serverTimestamp: 1 }); // HO §8.2
timeEventSchema.index({ userId: 1, serverTimestamp: 1 }); // HO §8.2
const noDelete = function () {
  throw new Error('Time events cannot be deleted');
};
for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete'] as const) timeEventSchema.pre(op, noDelete);

export type TimeEventDoc = InferSchemaType<typeof timeEventSchema> & { _id: Types.ObjectId };
export const TimeEvent = defineModel('TimeEvent', timeEventSchema);

/** Time correction request & decision (TIME-07). */
const timeCorrectionSchema = new Schema(
  {
    timeEventId: { ...ref('TimeEvent'), required: true },
    visitId: { ...ref('Visit'), required: true },
    workOrderId: { ...ref('WorkOrder'), required: true },
    engineerId: { ...ref('User'), required: true },
    eventType: { type: String, enum: TIME_EVENT_TYPES, required: true },
    originalTimestamp: { type: Date, required: true },
    proposedTimestamp: { type: Date, required: true },
    reason: { type: String, required: true },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
    requestedBy: { ...ref('User'), required: true },
    requestedByName: String,
    reviewerId: ref('User'),
    reviewerName: String,
    decidedAt: Date,
    decisionComment: String,
    // Scope fields copied from the visit for record-level authorisation.
    organizationId: ref('Organization'),
    regionId: ref('Region'),
    siteId: ref('Site'),
  },
  { collection: 'timeCorrections', timestamps: true, versionKey: false },
);
timeCorrectionSchema.index({ status: 1, createdAt: 1 });
timeCorrectionSchema.index({ visitId: 1 });
timeCorrectionSchema.index({ timeEventId: 1, status: 1 });
for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete'] as const) timeCorrectionSchema.pre(op, noDelete);

export const TimeCorrection = defineModel('TimeCorrection', timeCorrectionSchema);
