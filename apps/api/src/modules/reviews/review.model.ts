import { Schema } from 'mongoose';
import { defineModel } from '../../db/model';

const ref = (model: string) => ({ type: Schema.Types.ObjectId, ref: model });

/**
 * Review actions (HO §8 `reviewActions`): one document per start-review / approve / return on a
 * report revision. Append-only — the review history is evidence (REV-03).
 */
const reviewActionSchema = new Schema(
  {
    reportId: { ...ref('InspectionReport'), required: true },
    revisionNo: { type: Number, required: true },
    visitId: { ...ref('Visit'), required: true },
    workOrderId: { ...ref('WorkOrder'), required: true },
    action: { type: String, enum: ['startReview', 'approve', 'return'], required: true },
    /** Approval level (1..n) for multi-level approval (D-17). */
    level: Number,
    reviewerId: { ...ref('User'), required: true },
    reviewerName: String,
    reviewerRoles: [String],
    comments: String,
    itemFeedback: { type: [{ itemKey: String, comment: String }], default: [] },
    actionAt: { type: Date, required: true },
    // Scope (copied from the report)
    organizationId: ref('Organization'),
    regionId: ref('Region'),
    siteId: ref('Site'),
  },
  { collection: 'reviewActions', timestamps: true, versionKey: false },
);
reviewActionSchema.index({ reportId: 1, actionAt: 1 });
reviewActionSchema.index({ visitId: 1, actionAt: 1 });
reviewActionSchema.index({ reviewerId: 1, actionAt: -1 });
const immutable = function () {
  throw new Error('Review actions are immutable');
};
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  reviewActionSchema.pre(op, immutable);
}

export const ReviewAction = defineModel('ReviewAction', reviewActionSchema);
