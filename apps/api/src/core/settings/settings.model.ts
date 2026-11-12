import { Schema } from 'mongoose';
import { defineModel } from '../../db/model';

const systemSettingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    version: { type: Number, default: 1 },
  },
  { collection: 'systemSettings', timestamps: true, versionKey: false, minimize: false },
);

export const SystemSetting = defineModel('SystemSetting', systemSettingSchema);
