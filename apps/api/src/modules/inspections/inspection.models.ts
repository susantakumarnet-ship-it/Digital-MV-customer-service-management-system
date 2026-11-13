import { Schema, type InferSchemaType, type Types } from 'mongoose';
import { INSPECTION_RESULTS } from '@mv/shared';
import { defineModel } from '../../db/model';
import { statusHistorySchema } from '../../core/workflow/workflow.model';

const ref = (model: string) => ({ type: Schema.Types.ObjectId, ref: model });

const itemSchema = new Schema(
  {
    key: { type: String, required: true },
    section: String,
    description: { type: String, required: true },
    guidance: String,
    required: { type: Boolean, default: true },
    evidence: { type: String, enum: ['NONE', 'PHOTO', 'DOCUMENT', 'ANY'], default: 'NONE' },
    naReasonRequired: { type: Boolean, default: false },
    evidenceOnFail: { type: Boolean, default: false },
  },
  { _id: false },
);

/**
 * Checklist template (HO §8 `inspectionTemplates`). Each document is ONE version. Only DRAFT
 * versions are editable; publishing makes it ACTIVE and retires the previous active version for the
 * same equipment type. Reports snapshot the template so later changes never alter history.
 */
const inspectionTemplateSchema = new Schema(
  {
    name: { type: String, required: true },
    equipmentTypeId: { ...ref('EquipmentType'), required: true },
    version: { type: Number, required: true },
    status: { type: String, enum: ['DRAFT', 'ACTIVE', 'RETIRED'], default: 'DRAFT' },
    description: String,
    items: { type: [itemSchema], default: [] },
    effectiveFrom: Date,
    publishedAt: Date,
    publishedBy: ref('User'),
    publishedByName: String,
    retiredAt: Date,
    createdBy: ref('User'),
  },
  { collection: 'inspectionTemplates', timestamps: true, versionKey: false },
);
inspectionTemplateSchema.index({ equipmentTypeId: 1, version: 1 }, { unique: true });
// At most one ACTIVE version per equipment type.
inspectionTemplateSchema.index({ equipmentTypeId: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' } });

export const InspectionTemplate = defineModel('InspectionTemplate', inspectionTemplateSchema);

const resultSchema = new Schema(
  {
    itemKey: { type: String, required: true },
    result: { type: String, enum: [...INSPECTION_RESULTS, null] },
    remarks: String,
    reason: String,
  },
  { _id: false },
);

/** Fields that may still change after submission (review workflow — Phase 6). Everything else is frozen. */
const MUTABLE_AFTER_SUBMIT = ['status', 'statusHistory', 'reviews', 'reviewedAt', 'approvedAt', 'approvedBy', 'returnedAt', 'supersededById', 'updatedAt'];

/**
 * Inspection report revision (HO §8 `inspectionReports`). One document per revision; submitted
 * revisions are immutable (BR-009) — corrections create a new revision (Phase 6).
 */
const inspectionReportSchema = new Schema(
  {
    visitId: { ...ref('Visit'), required: true },
    visitNo: String,
    workOrderId: { ...ref('WorkOrder'), required: true },
    workOrderNo: String,
    complaintId: { ...ref('Complaint'), required: true },
    complaintRef: String,
    organizationId: { ...ref('Organization'), required: true },
    regionId: { ...ref('Region'), required: true },
    siteId: { ...ref('Site'), required: true },
    siteName: String,
    assetId: ref('Asset'),
    equipmentTypeId: { ...ref('EquipmentType'), required: true },
    /** Engineers who may edit/submit (the visit's engineers). Named for the workflow guard. */
    assigneeIds: { type: [ref('User')], default: [] },
    templateId: { ...ref('InspectionTemplate'), required: true },
    templateName: String,
    templateVersion: { type: Number, required: true },
    templateItems: { type: [itemSchema], default: [] },
    revisionNo: { type: Number, required: true, default: 1 },
    previousRevisionId: ref('InspectionReport'),
    supersededById: ref('InspectionReport'),
    results: { type: [resultSchema], default: [] },
    findings: String,
    recommendations: String,
    status: { type: String, required: true, default: 'DRAFT' },
    statusHistory: { type: [statusHistorySchema], default: [] },
    submittedAt: Date,
    submittedBy: ref('User'),
    submittedByName: String,
    reviews: { type: [Schema.Types.Mixed], default: [] },
    reviewedAt: Date,
    approvedAt: Date,
    approvedBy: ref('User'),
    returnedAt: Date,
    createdBy: ref('User'),
    createdByName: String,
  },
  { collection: 'inspectionReports', timestamps: true, versionKey: false, minimize: false },
);
inspectionReportSchema.index({ visitId: 1, revisionNo: 1 }, { unique: true }); // HO §8.2
inspectionReportSchema.index({ workOrderId: 1, status: 1 });
inspectionReportSchema.index({ status: 1, submittedAt: 1 });

// BR-009 enforcement at the persistence layer: a non-draft revision can only change review fields.
inspectionReportSchema.post('init', function (doc) {
  (doc as unknown as { $locals: Record<string, unknown> }).$locals.originalStatus = doc.get('status');
});
inspectionReportSchema.pre('save', function (next) {
  const original = this.$locals.originalStatus as string | undefined;
  if (this.isNew || !original || original === 'DRAFT') return next();
  const illegal = this.modifiedPaths().filter((p) => !MUTABLE_AFTER_SUBMIT.some((m) => p === m || p.startsWith(`${m}.`)));
  if (illegal.length) return next(new Error(`Submitted inspection reports are immutable (attempted to change: ${illegal.join(', ')})`));
  next();
});
const blockQueryUpdates = function (this: { getUpdate(): Record<string, unknown> | null }) {
  const update = this.getUpdate() ?? {};
  const touched = Object.keys({ ...(update.$set as object), ...(update.$unset as object), ...update }).filter((k) => !k.startsWith('$'));
  if (touched.some((k) => ['results', 'findings', 'recommendations', 'templateItems'].some((f) => k === f || k.startsWith(`${f}.`)))) {
    throw new Error('Inspection report content must be changed through the service (draft revisions only)');
  }
};
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate'] as const) inspectionReportSchema.pre(op, blockQueryUpdates);
for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  inspectionReportSchema.pre(op, function () {
    throw new Error('Inspection reports cannot be deleted');
  });
}

export type InspectionReportDoc = InferSchemaType<typeof inspectionReportSchema> & { _id: Types.ObjectId };
export const InspectionReport = defineModel('InspectionReport', inspectionReportSchema);
export const REPORT_SCOPE = { organization: 'organizationId', region: 'regionId', site: 'siteId', personal: ['assigneeIds', 'createdBy'] };
