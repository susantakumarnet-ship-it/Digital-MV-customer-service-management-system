import { Schema } from 'mongoose';
import { defineModel } from '../../db/model';

/** Single-use, expiring, hashed tokens for password reset and account activation. */
const oneTimeTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: ['PASSWORD_RESET', 'ACTIVATION'], required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
    createdIp: String,
  },
  { collection: 'passwordResetTokens', timestamps: true, versionKey: false },
);
oneTimeTokenSchema.index({ userId: 1, purpose: 1 });
oneTimeTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

export const OneTimeToken = defineModel('OneTimeToken', oneTimeTokenSchema);
