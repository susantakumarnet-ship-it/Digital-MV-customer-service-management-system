import { Schema, type InferSchemaType, type Types } from 'mongoose';
import { defineModel } from '../../db/model';
import { statusHistorySchema } from '../../core/workflow/workflow.model';

const ref = (model: string) => ({ type: Schema.Types.ObjectId, ref: model });

/** One entry per assignment change (WO-04 "maintain complete assignment history"). */
const assignmentEventSchema = new Schema(
  {
    at: { type: Date, required: true },
    by: ref('User'),
    byName: String,
    added: [ref('User')],
    removed: [ref('User')],
    assigneeIdsAfter: [ref('User')],
    leadEngineerId: ref('User'),
    reason: String,
  },
  { _id: false },
);

const acceptanceSchema = new Schema({ userId: ref('User'), at: Date }, { _id: false });

/**
 * Work order (HO §8 `workOrders`, BRF §9). Belongs to a complaint (BR-004); location fields are
 * copied from the complaint for record-level scoping. Assignees also get personal access.
 */
const workOrderSchema = new Schema(
  {
    workOrderNo: { type: String, required: true },
    complaintId: { ...ref('Complaint'), required: true },
    complaintRef: { type: String, required: true },

    organizationId: { ...ref('Organization'), required: true },
    regionId: { ...ref('Region'), required: true },
    cityId: { ...ref('City'), required: true },
    siteId: { ...ref('Site'), required: true },
    assetId: ref('Asset'),
    equipmentTypeId: ref('EquipmentType'),
    snapshot: { siteName: String, siteCode: String, regionName: String, cityName: String, assetName: String },

    title: { type: String, required: true },
    description: { type: String, required: true },
    workScope: String,
    priorityId: ref('Priority'),

    supervisorId: ref('User'),
    assigneeIds: { type: [ref('User')], default: [] },
    leadEngineerId: ref('User'),
    acceptedBy: { type: [acceptanceSchema], default: [] },
    assignmentHistory: { type: [assignmentEventSchema], default: [] },

    plannedVisitAt: Date,
    plannedEndAt: Date,
    dueAt: Date,
    shutdownRequired: { type: Boolean, default: false },
    shutdownDetails: String,
    materialRequired: { type: Boolean, default: false },
    materialNotes: String,

    status: { type: String, required: true, default: 'DRAFT' },
    statusHistory: { type: [statusHistorySchema], default: [] },
    assignedAt: Date,
    acceptedAt: Date,
    completedAt: Date,
    cancelledAt: Date,

    createdBy: ref('User'),
    updatedBy: ref('User'),
  },
  { collection: 'workOrders', timestamps: true, versionKey: false },
);

// HO §8.2
workOrderSchema.index({ workOrderNo: 1 }, { unique: true });
workOrderSchema.index({ assigneeIds: 1, status: 1 });
workOrderSchema.index({ supervisorId: 1, status: 1 });
workOrderSchema.index({ dueAt: 1 });
workOrderSchema.index({ complaintId: 1, createdAt: 1 });
workOrderSchema.index({ plannedVisitAt: 1, status: 1 });
workOrderSchema.index({ regionId: 1, status: 1 });
workOrderSchema.index({ siteId: 1, status: 1 });

export type WorkOrderDoc = InferSchemaType<typeof workOrderSchema> & { _id: Types.ObjectId };
export const WorkOrder = defineModel('WorkOrder', workOrderSchema);

export const WORK_ORDER_SCOPE = {
  organization: 'organizationId',
  region: 'regionId',
  site: 'siteId',
  personal: ['assigneeIds', 'supervisorId', 'createdBy'],
};
