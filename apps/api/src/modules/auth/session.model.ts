import { Schema, type InferSchemaType, type Types } from 'mongoose';
import { defineModel } from '../../db/model';

/**
 * One document per login session. The refresh token rotates in place: the current token hash is
 * `tokenHash`; previous hashes are kept in `rotatedHashes` so a replayed (stolen) token can be detected
 * and the whole session revoked.
 */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true },
    rotatedHashes: { type: [{ hash: String, at: Date }], default: [] },
    userAgent: String,
    ip: String,
    lastSeenAt: { type: Date, required: true },
    lastRotatedAt: Date,
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    revokedReason: String,
    /** Restricted session: only MFA setup / password change endpoints are reachable. */
    restriction: { type: String, enum: ['MFA_SETUP_REQUIRED', 'PASSWORD_CHANGE_REQUIRED', null], default: null },
  },
  { collection: 'sessions', timestamps: true, versionKey: false },
);
sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ 'rotatedHashes.hash': 1 });
sessionSchema.index({ userId: 1, revokedAt: 1 });
// Remove expired sessions 30 days after expiry (login history is retained in the audit log).
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export type SessionDoc = InferSchemaType<typeof sessionSchema> & { _id: Types.ObjectId };
export const Session = defineModel('Session', sessionSchema);
