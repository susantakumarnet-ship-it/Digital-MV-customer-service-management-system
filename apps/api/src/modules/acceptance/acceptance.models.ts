import { Schema, type Types } from 'mongoose';
import { defineModel } from '../../db/model';

const ref = (model: string) => ({ type: Schema.Types.ObjectId, ref: model });

/**
 * Secure acceptance link (D-12, BR-015). Only the SHA-256 of the token is stored; the token itself is
 * sent once by email. Single use, expiring, superseded by a newer request or a reopen.
 */
const acceptanceTokenSchema = new Schema(
  {
    tokenHash: { type: String, required: true },
    complaintId: { ...ref('Complaint'), required: true },
    recipientEmail: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: ['PENDING', 'USED', 'SUPERSEDED'], default: 'PENDING' },
    requestedBy: ref('User'),
    requestedByName: String,
    viewedAt: Date,
    usedAt: Date,
  },
  { collection: 'acceptanceTokens', timestamps: true, versionKey: false },
);
acceptanceTokenSchema.index({ tokenHash: 1 }, { unique: true });
acceptanceTokenSchema.index({ complaintId: 1, status: 1 });

export const AcceptanceToken = defineModel('AcceptanceToken', acceptanceTokenSchema);

/** Immutable record of every acceptance decision or waiver (HO §8 `customerAcceptances`). */
const customerAcceptanceSchema = new Schema(
  {
    complaintId: { ...ref('Complaint'), required: true },
    complaintRef: String,
    organizationId: { ...ref('Organization'), required: true },
    decision: { type: String, enum: ['ACCEPT', 'REJECT', 'WAIVED'], required: true },
    method: { type: String, enum: ['TOKEN', 'PORTAL', 'WAIVER'], required: true },
    comments: String,
    rating: Number,
    feedback: String,
    decidedByName: { type: String, required: true },
    customerUserId: ref('User'),
    tokenId: ref('AcceptanceToken'),
    recipientEmail: String,
    ip: String,
    userAgent: String,
    decidedAt: { type: Date, required: true },
  },
  { collection: 'customerAcceptances', timestamps: true, versionKey: false },
);
customerAcceptanceSchema.index({ complaintId: 1, decidedAt: -1 });
customerAcceptanceSchema.index({ organizationId: 1, decidedAt: -1 });
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  customerAcceptanceSchema.pre(op, function () {
    throw new Error('Acceptance records are immutable');
  });
}

export type CustomerAcceptanceDoc = { _id: Types.ObjectId } & Record<string, unknown>;
export const CustomerAcceptance = defineModel('CustomerAcceptance', customerAcceptanceSchema);
