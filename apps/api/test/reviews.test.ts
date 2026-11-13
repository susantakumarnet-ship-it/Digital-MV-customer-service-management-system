import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/core/audit/audit.model';
import { Notification } from '../src/core/notifications/notification.model';
import { getSettingsGroup, updateSettingsGroup } from '../src/core/settings/settings.service';
import { Attachment } from '../src/core/storage/attachment.model';
import { Complaint } from '../src/modules/complaints/complaint.model';
import { InspectionReport } from '../src/modules/inspections/inspection.models';
import { ReviewAction } from '../src/modules/reviews/review.model';
import { WorkOrder } from '../src/modules/work-orders/work-order.model';
import { acceptedWorkOrder, newVisit, recordUpTo } from './field-fixtures';
import { PNG, seedLocations, type Locations } from './fixtures';
import { ADMIN_EMAIL, api, bootstrap, createUser, getApp, login } from './helpers';

let L: Locations;
let sup: string;
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};

const ITEMS = [
  { key: 'VIS', section: 'General', description: 'Visual condition', required: true, evidence: 'PHOTO' },
  { key: 'OPS', section: 'Tests', description: 'Switch operation', required: true, evidence: 'NONE' },
];

/** Accepted WO → visit → time through END_WORK → report answered with photo → submitted. */
async function submittedReport(finishTrip = true) {
  const wo = await acceptedWorkOrder(L, sup, [ids.eng], [tok.eng]);
  const visitId = (await newVisit(tok.eng, wo.workOrderId)).id;
  await recordUpTo(tok.eng, visitId, 'END_WORK');
  const report = (await api(tok.eng).post(`/visits/${visitId}/inspection-reports`).send({})).body;
  await request(getApp())
    .post(`/api/v1/inspection-reports/${report.id}/attachments`)
    .set('Authorization', `Bearer ${tok.eng}`)
    .field('data', JSON.stringify({ itemKey: 'VIS' }))
    .attach('files', PNG, 'enclosure.png');
  await api(tok.eng).put(`/inspection-reports/${report.id}`).send({ results: [{ itemKey: 'VIS', result: 'PASS' }, { itemKey: 'OPS', result: 'FAIL', remarks: 'Stiff mechanism' }], findings: 'Mechanism stiff' });
  const s = await api(tok.eng).post(`/inspection-reports/${report.id}/submit`);
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  // Close the trip so the engineer can start the next job (one active sequence per engineer).
  if (finishTrip) await finish(visitId);
  return { ...wo, visitId, reportId: report.id as string };
}

async function finish(visitId: string) {
  for (const e of ['START_RETURN', 'ARRIVE_BASE']) expect((await api(tok.eng).post(`/visits/${visitId}/time-events`).send({ eventType: e })).status).toBe(200);
}

function act(token: string, reportId: string, body: Record<string, unknown>) {
  return api(token).post(`/inspection-reports/${reportId}/review-actions`).send(body);
}

beforeAll(async () => {
  await bootstrap();
  L = await seedLocations();
  const admin = (await login(ADMIN_EMAIL)).token;
  const t = await api(admin).post('/inspections/templates').send({ name: 'RMU check', equipmentTypeId: String(L.eq._id), items: ITEMS });
  await api(admin).post(`/inspections/templates/${t.body.id}/publish`);
  await createUser({ email: 'rsup@test.local', roleKeys: ['SUPERVISOR'], scope: { global: true } });
  for (const k of ['rev1', 'rev2']) await createUser({ email: `${k}@test.local`, roleKeys: ['REVIEWER'], scope: { global: true } });
  // An engineer who also holds the reviewer role: must not review own work (BR-012).
  const eng = await createUser({ email: 'reng@test.local', roleKeys: ['ENGINEER', 'REVIEWER'], scope: { regionIds: [String(L.A.region._id)] } });
  ids.eng = String(eng._id);
  sup = (await login('rsup@test.local')).token;
  for (const k of ['rev1', 'rev2']) tok[k] = (await login(`${k}@test.local`)).token;
  tok.eng = (await login('reng@test.local')).token;
});

describe('REV-01 queue and context', () => {
  it('lists submitted reports with context, flags own reports, and shows time-log flags', async () => {
    const r = await submittedReport(false);
    const q = await api(tok.rev1).get('/reviews');
    const row = q.body.data.find((x: any) => x.id === r.reportId);
    expect(row).toMatchObject({ status: 'SUBMITTED', isOwn: false, approvalLevels: 1, approvalsSoFar: 0, summary: { fail: 1, notChecked: 0 } });
    const own = (await api(tok.eng).get('/reviews')).body.data.find((x: any) => x.id === r.reportId);
    expect(own.isOwn).toBe(true);

    const ctx = (await api(tok.rev1).get(`/reviews/${r.reportId}`)).body;
    expect(ctx.report.items).toHaveLength(2);
    expect(ctx.sequences[0].events).toHaveLength(4);
    expect(ctx.workOrder.status).toBe('SUBMITTED');
    expect(ctx.complaint.status).toBe('SUBMITTED_FOR_REVIEW');
    expect(ctx.permissions).toMatchObject({ canStartReview: true, canApprove: true, canReturn: true });
    // Return travel not yet recorded + work lasting under 5 min in tests → warnings.
    expect(ctx.timeFlags.map((f: any) => f.code)).toEqual(expect.arrayContaining(['MISSING_EVENTS', 'SHORT_WORK']));
    expect(ctx.revisions).toHaveLength(1);

    const self = (await api(tok.eng).get(`/reviews/${r.reportId}`)).body;
    expect(self.permissions.canApprove).toBe(false);
    expect(self.permissions.reasonIfNot).toMatch(/authored/);
    await finish(r.visitId);
  });
});

describe('BR-012 segregation of duties', () => {
  it('the engineer who wrote the report cannot start review, approve or return it, even with reviewer rights', async () => {
    const r = await submittedReport();
    for (const action of ['startReview', 'approve']) {
      const res = await act(tok.eng, r.reportId, { action });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SELF_APPROVAL');
    }
    expect((await act(tok.eng, r.reportId, { action: 'return', comments: 'x' })).status).toBe(403);
    expect((await act(sup, r.reportId, { action: 'approve' })).status).toBe(403); // supervisors lack inspection.approve
  });
});

describe('REV-02/03 approve', () => {
  it('approval locks the report and moves work order and complaint to Approved; comments optional (D-29)', async () => {
    const r = await submittedReport();
    const res = await act(tok.rev1, r.reportId, { action: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('approved');
    const rep = await InspectionReport.findById(r.reportId).lean();
    expect(rep).toMatchObject({ status: 'APPROVED' });
    expect(rep!.approvedAt).toBeTruthy();
    expect((await WorkOrder.findById(r.workOrderId).lean())!.status).toBe('APPROVED');
    expect((await Complaint.findById(r.complaintId).lean())!.status).toBe('APPROVED');
    expect(await ReviewAction.countDocuments({ reportId: r.reportId, action: 'approve', level: 1 })).toBe(1);
    expect(await Notification.countDocuments({ type: 'inspectionReport.approved', entityId: r.reportId })).toBeGreaterThanOrEqual(1);
    expect(await AuditLog.countDocuments({ action: 'inspectionReport.approve', entityId: r.reportId })).toBe(1);
    // Terminal & immutable.
    expect((await act(tok.rev2, r.reportId, { action: 'return', comments: 'Too late' })).body.error.code).toBe('INVALID_STATE');
    const doc = await InspectionReport.findById(r.reportId);
    doc!.findings = 'tampered';
    await expect(doc!.save()).rejects.toThrow(/immutable/);
  });

  it('D-17: two approval levels need two different reviewers', async () => {
    const s = await getSettingsGroup('workflow');
    await updateSettingsGroup({}, 'workflow', { ...s, inspectionApprovalLevels: 2 });
    try {
      const r = await submittedReport();
      const first = await act(tok.rev1, r.reportId, { action: 'approve', comments: 'Level 1 OK' });
      expect(first.body.outcome).toBe('levelApproved');
      expect((await InspectionReport.findById(r.reportId).lean())!.status).toBe('UNDER_REVIEW');
      const again = await act(tok.rev1, r.reportId, { action: 'approve' });
      expect(again.body.error.code).toBe('ALREADY_APPROVED_BY_YOU');
      const ctx = (await api(tok.rev2).get(`/reviews/${r.reportId}`)).body;
      expect(ctx.approval).toMatchObject({ levels: 2, approvalsSoFar: 1, approvedBy: ['rev1'] });
      const second = await act(tok.rev2, r.reportId, { action: 'approve' });
      expect(second.body.outcome).toBe('approved');
      expect((await InspectionReport.findById(r.reportId).lean())!.status).toBe('APPROVED');
      expect(await ReviewAction.countDocuments({ reportId: r.reportId, action: 'approve' })).toBe(2);
    } finally {
      await updateSettingsGroup({}, 'workflow', s);
    }
  });
});

describe('REV-02 return → new revision → resubmit (BR-009, INSP-07)', () => {
  it('requires comments, creates the next draft revision with answers and evidence, and supersedes the returned one', async () => {
    const r = await submittedReport();
    expect((await act(tok.rev1, r.reportId, { action: 'return' })).status).toBe(400);
    const bad = await act(tok.rev1, r.reportId, { action: 'return', comments: 'Fix it', itemFeedback: [{ itemKey: 'NOPE', comment: 'x' }] });
    expect(bad.status).toBe(400);
    const res = await act(tok.rev1, r.reportId, {
      action: 'return',
      comments: 'Retest the switch and add a photo of the mechanism.',
      itemFeedback: [{ itemKey: 'OPS', comment: 'Attach evidence of the retest' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('returned');
    const nextId = res.body.reportId;
    expect(nextId).not.toBe(r.reportId);

    const old = await InspectionReport.findById(r.reportId).lean();
    expect(old).toMatchObject({ status: 'SUPERSEDED', revisionNo: 1 });
    expect(String(old!.supersededById)).toBe(nextId);
    expect(old!.findings).toBe('Mechanism stiff'); // previous submission intact
    expect((await WorkOrder.findById(r.workOrderId).lean())!.status).toBe('IN_PROGRESS');
    expect((await Complaint.findById(r.complaintId).lean())!.status).toBe('RETURNED_FOR_CORRECTION');
    expect(await Notification.countDocuments({ type: 'inspectionReport.returned', entityId: nextId })).toBe(1);

    // Engineer sees the new draft with answers, evidence and the reviewer's feedback.
    const draft = (await api(tok.eng).get(`/inspection-reports/${nextId}`)).body;
    expect(draft).toMatchObject({ revisionNo: 2, status: 'DRAFT', previousRevisionId: r.reportId, reviewFeedback: { reviewerName: 'rev1', comments: 'Retest the switch and add a photo of the mechanism.' } });
    expect(draft.items.find((i: any) => i.key === 'OPS')).toMatchObject({ result: 'FAIL', remarks: 'Stiff mechanism', feedback: 'Attach evidence of the retest' });
    expect(draft.items.find((i: any) => i.key === 'VIS').attachments).toHaveLength(1);
    expect(await Attachment.countDocuments({ ownerId: r.reportId })).toBe(1); // original evidence untouched

    // Correct and resubmit → back to Submitted for Review.
    await api(tok.eng).put(`/inspection-reports/${nextId}`).send({ results: [{ itemKey: 'OPS', result: 'PASS', remarks: 'Lubricated, operates freely' }] });
    const resub = await api(tok.eng).post(`/inspection-reports/${nextId}/submit`);
    expect(resub.status).toBe(200);
    expect((await WorkOrder.findById(r.workOrderId).lean())!.status).toBe('SUBMITTED');
    expect((await Complaint.findById(r.complaintId).lean())!.status).toBe('SUBMITTED_FOR_REVIEW');

    // REV-04: revision list and comparison.
    const revs = (await api(tok.rev1).get(`/inspection-reports/${nextId}/revisions`)).body;
    expect(revs.map((x: any) => [x.revisionNo, x.status])).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'SUBMITTED'],
    ]);
    const cmp = (await api(tok.rev1).get(`/inspection-reports/${nextId}/compare?with=${r.reportId}`)).body;
    const ops = cmp.items.find((i: any) => i.key === 'OPS');
    expect(ops).toMatchObject({ changed: true, from: { result: 'FAIL' }, to: { result: 'PASS' }, feedback: 'Attach evidence of the retest' });
    expect(cmp.items.find((i: any) => i.key === 'VIS').changed).toBe(false);

    const ctx = (await api(tok.rev2).get(`/reviews/${nextId}`)).body;
    expect(ctx.feedbackFromPreviousReview.comments).toMatch(/Retest the switch/);
    expect(ctx.reviewHistory.map((h: any) => h.action)).toEqual(['return']);

    // Final approval of revision 2.
    expect((await act(tok.rev2, nextId, { action: 'approve' })).body.outcome).toBe('approved');
    expect((await Complaint.findById(r.complaintId).lean())!.status).toBe('APPROVED');
  });

  it('review actions are immutable', async () => {
    await expect(ReviewAction.updateOne({}, { $set: { comments: 'tampered' } })).rejects.toThrow(/immutable/);
  });
});

describe('reviewer KPIs', () => {
  it('summary counts pending and approved-this-week reports within scope', async () => {
    const s = await api(tok.rev1).get('/reviews/summary');
    expect(s.status).toBe(200);
    expect(s.body.approvedThisWeek).toBeGreaterThanOrEqual(3); // approved earlier in this file
    expect(s.body.approvedTotal).toBeGreaterThanOrEqual(s.body.approvedThisWeek);
    expect(s.body).toHaveProperty('waitingOver24h');
    // Supervisors hold inspection.read, so they can see the counts (their dashboard shows them).
    expect((await api(sup).get('/reviews/summary')).status).toBe(200);
  });
});
