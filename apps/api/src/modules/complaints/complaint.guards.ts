import mongoose from 'mongoose';
import { registerGuard } from '../../core/workflow/workflow.engine';
import { inScope } from '../../core/scope/scope.service';
import { COMPLAINT_SCOPE, Complaint } from './complaint.model';

/**
 * Business-rule guards for complaint transitions (WF-02). Each returns null when satisfied or a
 * human-readable reason. Registered at startup; unregistered guards fail closed.
 */
export function registerComplaintGuards() {
  // BR-003: link to a valid master; never to itself, to another duplicate, or to a closed-out record.
  registerGuard('duplicateTargetValid', async ({ record, payload, ctx, session }) => {
    const id = payload.duplicateOfId as string | undefined;
    if (!id) return 'Select the original complaint this one duplicates.';
    if (String(record._id) === id) return 'A complaint cannot be a duplicate of itself.';
    const master = await Complaint.findById(id).session(session ?? null).lean();
    if (!master || !ctx.auth || !inScope(ctx.auth, master, COMPLAINT_SCOPE)) return 'The original complaint was not found.';
    if (master.status === 'DUPLICATE') return `Complaint ${master.referenceNo} is itself a duplicate — link to its original instead.`;
    if (['REJECTED', 'CANCELLED'].includes(master.status)) return `Complaint ${master.referenceNo} was ${master.status.toLowerCase()} and cannot be used as the original.`;
    return null;
  });

  // BR-002: mandatory intake fields.
  registerGuard('intakeComplete', ({ record }) => {
    const r = record as Record<string, any>;
    const missing = ['siteId', 'requestTypeId', 'description', 'customerName'].filter((k) => !r[k]);
    if (!r.email && !r.mobile) missing.push('contact details');
    if (!r.consent?.accepted) missing.push('privacy consent');
    return missing.length ? `Complete the complaint intake first (missing: ${missing.join(', ')}).` : null;
  });

  // BR-002: classification before assignment.
  registerGuard('classificationComplete', ({ record }) => {
    const r = record as Record<string, any>;
    return r.classifiedAt && r.priorityId && r.requestTypeId ? null : 'Classify the complaint (request type and priority) before assigning it.';
  });

  // Cancellation only when no work order is still active. Work orders arrive in Phase 4; until the
  // collection exists this check passes.
  registerGuard('noActiveWorkOrders', async ({ record, session }) => {
    const db = mongoose.connection.db;
    if (!db) return null;
    const n = await db
      .collection('workOrders')
      .countDocuments({ complaintId: record._id, status: { $nin: ['CLOSED', 'CANCELLED'] } }, { session });
    return n ? `Cancel or close the ${n} active work order(s) first.` : null;
  });
}
