import { Schema, type InferSchemaType, type Types } from 'mongoose';
import { defineModel } from '../../db/model';

/** File metadata (HO §4.3, §7.1). Binary content lives in private object storage under `storageKey`. */
const attachmentSchema = new Schema(
  {
    ownerType: { type: String, required: true }, // 'complaint', later 'visit', 'inspectionReport', 'ncr', …
    ownerId: { type: Schema.Types.ObjectId, required: true },
    /** Where in the owner it belongs, e.g. 'intake', 'internal', 'customerResponse', or a checklist item id. */
    context: { type: String, default: 'general' },
    originalName: { type: String, required: true },
    extension: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    storageKey: { type: String, required: true, select: false },
    scanStatus: { type: String, enum: ['NOT_SCANNED', 'PENDING', 'CLEAN', 'INFECTED'], default: 'NOT_SCANNED' },
    uploaderType: { type: String, enum: ['USER', 'PUBLIC'], required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    uploadedByName: String,
    uploadedIp: String,
    /** Soft removal only — the record and file are retained for audit. */
    removedAt: Date,
    removedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    removalReason: String,
  },
  { collection: 'attachments', timestamps: true, versionKey: false },
);
attachmentSchema.index({ ownerType: 1, ownerId: 1, createdAt: 1 });
attachmentSchema.index({ sha256: 1 });

export type AttachmentDoc = InferSchemaType<typeof attachmentSchema> & { _id: Types.ObjectId };
export const Attachment = defineModel('Attachment', attachmentSchema);

export function toAttachmentDto(a: Record<string, any>) {
  return {
    id: String(a._id),
    originalName: a.originalName,
    mimeType: a.mimeType,
    size: a.size,
    uploadedAt: a.createdAt,
    uploadedByName: a.uploadedByName ?? undefined,
    scanStatus: a.scanStatus,
    context: a.context,
  };
}
