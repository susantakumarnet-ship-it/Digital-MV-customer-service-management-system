import { Schema } from 'mongoose';
import { STATUS_TONES, WORKFLOW_ENTITIES } from '@mv/shared';
import { defineModel } from '../../db/model';

const stateSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    tone: { type: String, enum: STATUS_TONES, default: 'neutral' },
    terminal: { type: Boolean, default: false },
    locked: { type: Boolean, default: false },
  },
  { _id: false },
);

const transitionSchema = new Schema(
  {
    action: { type: String, required: true },
    label: { type: String, required: true },
    from: { type: [String], required: true },
    to: { type: String, required: true },
    permission: { type: String, required: true },
    requiresReason: { type: Boolean, default: false },
    guards: { type: [String], default: [] },
    optional: { type: Boolean, default: false },
    enabled: { type: Boolean, default: true },
    systemOnly: { type: Boolean, default: false },
    confirm: { type: Boolean, default: false },
  },
  { _id: false },
);

const workflowDefinitionSchema = new Schema(
  {
    entity: { type: String, enum: WORKFLOW_ENTITIES, required: true, unique: true },
    name: { type: String, required: true },
    version: { type: Number, required: true, default: 1 },
    initialState: { type: String, required: true },
    states: { type: [stateSchema], required: true },
    transitions: { type: [transitionSchema], required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { collection: 'workflowDefinitions', timestamps: true, versionKey: false },
);

export const WorkflowDefinition = defineModel('WorkflowDefinition', workflowDefinitionSchema);

/** Embedded in every workflow-managed record. */
export const statusHistorySchema = new Schema(
  {
    from: String,
    to: { type: String, required: true },
    action: { type: String, required: true },
    by: { type: Schema.Types.ObjectId, ref: 'User' },
    byName: String,
    at: { type: Date, required: true },
    reason: String,
  },
  { _id: false },
);
