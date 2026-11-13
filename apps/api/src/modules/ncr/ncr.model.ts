import { Schema, type InferSchemaType, type Types } from 'mongoose';
import { defineModel } from '../../db/model';
import { statusHistorySchema } from '../../core/workflow/workflow.model';

const ref = (model: string) => ({ type: Schema.Types.ObjectId, ref: model });

/** Non-conformance report (HO §8 `ncrs`, BRF §15). */
const ncrSchema = new Schema(
  {
    ncrNo: { type: String, required: true },
    complaintId: { ...ref('Complaint'), required: true },
    complaintRef: String,
    workOrderId: ref('WorkOrder'),
    workOrderNo: String,
    assetId: ref('Asset'),
    inspectionReportId: ref('InspectionReport'),
    itemKey: String,
    organizationId: { ...ref('Organization'), required: true },
    regionId: { ...ref('Region'), required: true },
    siteId: { ...ref('Site'), required: true },
    siteName: String,
    category: { type: String, required: true },
    severity: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    raisedBy: { ...ref('User'), required: true },
    raisedByName: String,
    ownerId: ref('User'),
    dueAt: Date,
    containmentAction: String,
    rootCause: String,
    correctiveAction: String,
    disposition: { type: String, enum: ['REWORK', 'REPAIR', 'REPLACE', 'USE_AS_IS', 'SCRAP', 'RETURN_TO_SUPPLIER', 'OTHER'] },
    verification: { by: ref('User'), byName: String, at: Date, comment: String },
    comments: { type: [{ text: String, by: ref('User'), byName: String, at: Date }], default: [] },
    /** NCR-04: every change to the action fields is kept. */
    revisions: { type: [{ at: Date, by: ref('User'), byName: String, changes: Schema.Types.Mixed, _id: false }], default: [] },
    status: { type: String, required: true, default: 'OPEN' },
    statusHistory: { type: [statusHistorySchema], default: [] },
    closedAt: Date,
  },
  { collection: 'ncrs', timestamps: true, versionKey: false },
);
// HO §8.2
ncrSchema.index({ ncrNo: 1 }, { unique: true });
ncrSchema.index({ status: 1, dueAt: 1 });
ncrSchema.index({ ownerId: 1, status: 1 });
ncrSchema.index({ complaintId: 1, status: 1 });
ncrSchema.index({ workOrderId: 1 });
for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  ncrSchema.pre(op, function () {
    throw new Error('NCRs cannot be deleted');
  });
}

export type NcrDoc = InferSchemaType<typeof ncrSchema> & { _id: Types.ObjectId };
export const Ncr = defineModel('Ncr', ncrSchema);
export const NCR_SCOPE = { organization: 'organizationId', region: 'regionId', site: 'siteId', personal: ['ownerId', 'raisedBy'] };
