import { Schema, type InferSchemaType } from 'mongoose';
import { defineModel } from '../../db/model';

const roleSchema = new Schema(
  {
    /** Stable key for system roles (ADMIN, SUPERVISOR, …). Custom roles have no key. */
    key: { type: String, sparse: true, unique: true },
    name: { type: String, required: true, trim: true },
    description: String,
    permissions: { type: [String], default: [] },
    /** Default permissions already offered by the seed (so admin removals are not re-added). */
    seededPermissions: { type: [String], default: undefined },
    isSystem: { type: Boolean, default: false },
    assignable: { type: Boolean, default: true },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { collection: 'roles', timestamps: true, versionKey: false },
);
roleSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

export type RoleDoc = InferSchemaType<typeof roleSchema> & { _id: Schema.Types.ObjectId };
export const Role = defineModel('Role', roleSchema);
