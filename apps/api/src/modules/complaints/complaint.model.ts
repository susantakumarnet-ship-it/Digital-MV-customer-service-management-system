import { Schema, type InferSchemaType, type Types } from 'mongoose';
import { defineModel } from '../../db/model';
import { statusHistorySchema } from '../../core/workflow/workflow.model';

const ref = (model: string) => ({ type: Schema.Types.ObjectId, ref: model });

const noteSchema = new Schema(
  { text: { type: String, required: true }, by: ref('User'), byName: String, at: { type: Date, required: true } },
  { _id: true },
);

const customerMessageSchema = new Schema(
  {
    direction: { type: String, enum: ['TO_CUSTOMER', 'FROM_CUSTOMER'], required: true },
    text: { type: String, required: true },
    by: ref('User'),
    byName: String,
    at: { type: Date, required: true },
  },
  { _id: true },
);

/**
 * Complaint (HO §8 `complaints`). Location fields are denormalised (organizationId/regionId/cityId/
 * siteId) for record-level scoping. Names are snapshotted at intake so history stays accurate even if
 * master data is later renamed.
 */
const complaintSchema = new Schema(
  {
    referenceNo: { type: String, required: true },
    source: {
      type: String,
      enum: ['PUBLIC_FORM', 'CUSTOMER_PORTAL', 'PHONE', 'EMAIL', 'WALK_IN', 'OTHER'],
      required: true,
    },
    status: { type: String, required: true, default: 'NEW' },
    statusHistory: { type: [statusHistorySchema], default: [] },

    // Reporter / customer (as submitted)
    customerName: { type: String, required: true },
    organizationName: String,
    contactPerson: String,
    mobile: { type: String, required: true },
    email: { type: String, required: true, lowercase: true },

    // Location & asset (validated against master data)
    organizationId: { ...ref('Organization'), required: true },
    regionId: { ...ref('Region'), required: true },
    cityId: { ...ref('City'), required: true },
    siteId: { ...ref('Site'), required: true },
    assetId: ref('Asset'),
    equipmentTypeId: ref('EquipmentType'),
    snapshot: {
      organizationName: String,
      regionName: String,
      cityName: String,
      siteName: String,
      siteCode: String,
      assetName: String,
      assetCode: String,
      equipmentTypeName: String,
    },

    requestTypeId: { ...ref('RequestType'), required: true },
    suggestedPriorityId: ref('Priority'),
    description: { type: String, required: true },
    receivedAt: { type: Date, required: true },

    // Review & classification (CMP-03)
    priorityId: ref('Priority'),
    category: String,
    classifiedAt: Date,
    classifiedBy: ref('User'),
    classifiedByName: String,
    classificationNotes: String,
    supervisorId: ref('User'),
    acknowledgedAt: Date,
    dueAt: Date,
    resolvedAt: Date,
    closedAt: Date,

    // Duplicates (BR-003): originals are linked, never deleted.
    duplicateOfId: ref('Complaint'),
    linkedDuplicateIds: [ref('Complaint')],

    // Engineers assigned through any active work order (personal access, kept in sync by Phase 4).
    engineerIds: { type: [ref('User')], default: [] },

    consent: {
      accepted: { type: Boolean, required: true },
      version: String,
      at: Date,
      ip: String,
    },
    internalNotes: { type: [noteSchema], default: [] },
    customerMessages: { type: [customerMessageSchema], default: [] },

    submittedIp: String,
    createdBy: ref('User'),
    updatedBy: ref('User'),
  },
  { collection: 'complaints', timestamps: true, versionKey: false },
);

// HO §8.2 indexes
complaintSchema.index({ referenceNo: 1 }, { unique: true });
complaintSchema.index({ status: 1, priorityId: 1, receivedAt: -1 });
complaintSchema.index({ siteId: 1, status: 1 });
complaintSchema.index({ dueAt: 1, status: 1 });
// Scoping & queue filters
complaintSchema.index({ organizationId: 1, receivedAt: -1 });
complaintSchema.index({ regionId: 1, receivedAt: -1 });
complaintSchema.index({ supervisorId: 1, status: 1 });
complaintSchema.index({ email: 1, siteId: 1, receivedAt: -1 });
complaintSchema.index({ receivedAt: -1 });
complaintSchema.index({ duplicateOfId: 1 });
complaintSchema.index({ engineerIds: 1 });

export type ComplaintDoc = InferSchemaType<typeof complaintSchema> & { _id: Types.ObjectId };
export const Complaint = defineModel('Complaint', complaintSchema);

/** Scope fields for record-level authorisation (RBAC-05). */
export const COMPLAINT_SCOPE = {
  organization: 'organizationId',
  region: 'regionId',
  site: 'siteId',
  personal: ['supervisorId', 'createdBy', 'engineerIds'],
};
