import { Schema } from 'mongoose';
import { defineModel } from '../../db/model';

const notificationSchema = new Schema(
  {
    recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    channel: { type: String, enum: ['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP'], required: true, default: 'IN_APP' },
    /** Trigger key, e.g. workOrder.assigned (NOT-03). */
    type: { type: String, required: true },
    templateKey: String,
    title: { type: String, required: true },
    body: { type: String, default: '' },
    /** Relative app link, e.g. /work-orders/123. */
    link: String,
    entityType: String,
    entityId: Schema.Types.ObjectId,
    severity: { type: String, enum: ['info', 'success', 'warning', 'danger'], default: 'info' },
    readAt: Date,
    status: { type: String, enum: ['PENDING', 'SENT', 'FAILED', 'SKIPPED'], default: 'SENT' },
    attempts: { type: Number, default: 0 },
    sentAt: Date,
    failureReason: String,
  },
  { collection: 'notifications', timestamps: true, versionKey: false },
);
notificationSchema.index({ recipientId: 1, channel: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ status: 1, channel: 1, createdAt: 1 });

export const Notification = defineModel('Notification', notificationSchema);
