import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/core/audit/audit.model';
import { capturedMail } from '../src/core/mail/mail.service';
import { Notification } from '../src/core/notifications/notification.model';
import { AcceptanceToken, CustomerAcceptance } from '../src/modules/acceptance/acceptance.models';
import { Complaint } from '../src/modules/complaints/complaint.model';
import { Ncr } from '../src/modules/ncr/ncr.model';
import { WorkOrder } from '../src/modules/work-orders/work-order.model';
import { acceptedWorkOrder, newVisit, recordUpTo } from './field-fixtures';
import { PNG, seedLocations, type Locations } from './fixtures';
import { ADMIN_EMAIL, api, bootstrap, createUser, getApp, login } from './helpers';

let L: Locations;
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};

const ITEMS = [
  { key: 'VIS', section: 'General', description: 'Visual condition', required: true, evidence: 'NONE' },
  { key: 'OPS', section: 'Tests', description: 'Switch operation', required: true, evidence: 'NONE' },
];

/** Accepted WO â†’ visit â†’ report (OPS failed) â†’ submitted â†’ approved by rev1 â†’ complaint APPROVED. */
async function approvedComplaint(finishTrip = true) {
  const wo = await acceptedWorkOrder(L, tok.sup, [ids.eng], [tok.eng]);
  const visitId = (await newVisit(tok.eng, wo.workOrderId)).id;
  await recordUpTo(tok.eng, visitId, 'END_WORK');
  const report = (await api(tok.eng).post(`/visits/${visitId}/inspection-reports`).send({})).body;
  await api(tok.eng)
    .put(`/inspection-reports/${report.id}`)
    .send({ results: [{ itemKey: 'VIS', result: 'PASS' }, { itemKey: 'OPS', result: 'FAIL', remarks: 'Stiff mechanism' }], findings: 'Mechanism stiff', recommendations: 'Lubricate' });
  expect((await api(tok.eng).post(`/inspection-reports/${report.id}/submit`)).status).toBe(200);
  if (finishTrip) for (const e of ['START_RETURN', 'ARRIVE_BASE']) expect((await api(tok.eng).post(`/visits/${visitId}/time-events`).send({ eventType: e })).status).toBe(200);
  for (const action of ['startReview', 'approve']) {
    const r = await api(tok.rev).post(`/inspection-reports/${report.id}/review-actions`).send({ action });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  expect((await Complaint.findById(wo.complaintId).lean())!.status).toBe('APPROVED');
  return { ...wo, visitId, reportId: report.id as string };
}

function raise(token: string, body: Record<string, unknown>, file = true) {
  let r = request(getApp()).post('/api/v1/ncrs').set('Authorization', `Bearer ${token}`).field('data', JSON.stringify(body));
  if (file) r = r.attach('files', PNG, 'defect.png');
  return r;
}

function verificationEvidence(token: string, ncrId: string) {
  return request(getApp())
    .post(`/api/v1/ncrs/${ncrId}/attachments`)
    .set('Authorization', `Bearer ${token}`)
    .field('data', JSON.stringify({ context: 'verification' }))
    .attach('files', PNG, 'after.png');
}

const ncrBody = (c: { complaintId: string; workOrderId: string; reportId: string }) => ({
  complaintId: c.complaintId,
  workOrderId: c.workOrderId,
  inspectionReportId: c.reportId,
  itemKey: 'OPS',
  category: 'Workmanship',
  severity: 'Major',
  title: 'Switch mechanism stiff',
  description: 'Operating handle requires excessive force.',
});

const ACTIONS = { containmentAction: 'Isolated panel', rootCause: 'Dry lubrication', correctiveAction: 'Lubricated and tested', disposition: 'REWORK' };

const transition = (token: string, id: string, body: Record<string, unknown>) => api(token).post(`/complaints/${id}/transitions`).send(body);
const linkToken = (since: number, to = 'jane@example.com') => {
  const m = capturedMail().slice(since).reverse().find((x) => x.to === to && /acceptance\//.test(x.text));
  return m?.text.match(/acceptance\/([A-Za-z0-9_-]{20,})/)?.[1];
};

beforeAll(async () => {
  await bootstrap();
  L = await seedLocations();
  tok.admin = (await login(ADMIN_EMAIL)).token;
  const t = await api(tok.admin).post('/inspections/templates').send({ name: 'RMU check', equipmentTypeId: String(L.eq._id), items: ITEMS });
  await api(tok.admin).post(`/inspections/templates/${t.body.id}/publish`);
  ids.sup = String((await createUser({ email: 'nsup@test.local', roleKeys: ['SUPERVISOR'], scope: { global: true } }))._id);
  ids.rev = String((await createUser({ email: 'nrev@test.local', roleKeys: ['REVIEWER'], scope: { global: true } }))._id);
  ids.rev2 = String((await createUser({ email: 'nrev2@test.local', roleKeys: ['REVIEWER'], scope: { global: true } }))._id);
  ids.eng = String((await createUser({ email: 'neng@test.local', roleKeys: ['ENGINEER'], scope: { regionIds: [String(L.A.region._id)] } }))._id);
  ids.eng2 = String((await createUser({ email: 'neng2@test.local', roleKeys: ['ENGINEER'], scope: { regionIds: [String(L.A.region._id)] } }))._id);
  await createUser({ email: 'ncustA@test.local', roleKeys: ['CUSTOMER'], scope: { organizationIds: [String(L.A.org._id)] }, organizationId: String(L.A.org._id) });
  await createUser({ email: 'ncustB@test.local', roleKeys: ['CUSTOMER'], scope: { organizationIds: [String(L.B.org._id)] }, organizationId: String(L.B.org._id) });
  for (const [k, e] of Object.entries({ sup: 'nsup', rev: 'nrev', rev2: 'nrev2', eng: 'neng', eng2: 'neng2', custA: 'ncustA', custB: 'ncustB' })) tok[k] = (await login(`${e}@test.local`)).token;
});

describe('NCR-01..05 lifecycle', () => {
  it('raises, assigns, records actions with history, returns, verifies with evidence and closes', async () => {
    const c = await approvedComplaint();
    // Configured lists are enforced.
    const bad = await raise(tok.eng, { ...ncrBody(c), category: 'Nonsense' });
    expect(bad.status).toBe(400);
    const r = await raise(tok.eng, ncrBody(c));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id;
    expect(r.body).toMatchObject({ status: 'OPEN', severity: 'Major', inspection: { itemKey: 'OPS', itemDescription: 'Switch operation' } });
    expect(r.body.ncrNo).toMatch(/^NCR-\d{4}-\d+/);
    expect(r.body.evidence).toHaveLength(1);
    expect(await Notification.countDocuments({ recipientId: ids.sup, type: 'ncr.raised' })).toBe(1);

    // Engineers cannot assign owners.
    expect((await api(tok.eng).post(`/ncrs/${id}/assign`).send({ ownerId: ids.eng })).status).toBe(403);
    // Owner must be able to work NCRs (customers / storekeepers cannot).
    const a = await api(tok.sup).post(`/ncrs/${id}/assign`).send({ ownerId: ids.eng, comment: 'Please fix' });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({ status: 'ASSIGNED', owner: { id: ids.eng } });

    // Only the owner records actions.
    expect((await api(tok.eng2).put(`/ncrs/${id}/actions`).send({ rootCause: 'x' })).status).toBe(403); // same region, but not the owner
    const part = await api(tok.eng).put(`/ncrs/${id}/actions`).send({ containmentAction: 'Isolated panel' });
    expect(part.body.status).toBe('ACTION_IN_PROGRESS');
    // Submit needs all action fields.
    const early = await api(tok.eng).post(`/ncrs/${id}/transition`).send({ action: 'submitForVerification' });
    expect(early.status).toBe(409);
    expect(early.body.error.message).toMatch(/root cause/);
    await api(tok.eng).put(`/ncrs/${id}/actions`).send(ACTIONS);
    const sub = await api(tok.eng).post(`/ncrs/${id}/transition`).send({ action: 'submitForVerification' });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.status).toBe('SUBMITTED_FOR_VERIFICATION');
    expect(sub.body.revisions.length).toBeGreaterThanOrEqual(3);
    expect(sub.body.permissions.canEditActions).toBe(false);

    // Return requires a reason, then owner restarts.
    expect((await api(tok.rev).post(`/ncrs/${id}/transition`).send({ action: 'return' })).status).toBe(400);
    const ret = await api(tok.rev).post(`/ncrs/${id}/transition`).send({ action: 'return', reason: 'Show torque test result' });
    expect(ret.body.status).toBe('RETURNED');
    const re = await api(tok.eng).put(`/ncrs/${id}/actions`).send({ correctiveAction: 'Lubricated, torque tested at 12 Nm' });
    expect(re.body.status).toBe('ACTION_IN_PROGRESS');
    expect(re.body.revisions.some((x: any) => x.changes.correctiveAction?.from === 'Lubricated and tested')).toBe(true);
    await api(tok.eng).post(`/ncrs/${id}/transition`).send({ action: 'submitForVerification' });

    // BR-014: verification needs verification evidence.
    const noEv = await api(tok.rev).post(`/ncrs/${id}/transition`).send({ action: 'verify', comment: 'OK' });
    expect(noEv.status).toBe(409);
    expect(noEv.body.error.message).toMatch(/verification evidence/);
    expect((await verificationEvidence(tok.eng, id)).status).toBe(403); // engineers are not verifiers
    expect((await verificationEvidence(tok.rev, id)).status).toBe(200);
    const v = await api(tok.rev).post(`/ncrs/${id}/transition`).send({ action: 'verify', comment: 'Torque within limits' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body).toMatchObject({ status: 'VERIFIED', verification: { comment: 'Torque within limits' } });
    expect(v.body.verificationEvidence).toHaveLength(1);
    const cl = await api(tok.rev).post(`/ncrs/${id}/transition`).send({ action: 'close' });
    expect(cl.body.status).toBe('CLOSED');
    // Closed NCRs are locked; NCRs are never deleted.
    expect((await api(tok.eng).put(`/ncrs/${id}/actions`).send({ rootCause: 'changed' })).status).toBe(409);
    await expect(Ncr.deleteOne({ _id: id })).rejects.toThrow(/cannot be deleted/);
    expect(await AuditLog.countDocuments({ entityType: 'ncr', entityId: id })).toBeGreaterThanOrEqual(5);

    // Review context lists the work order's NCRs.
    const ctx = (await api(tok.rev).get(`/reviews/${c.reportId}`)).body;
    expect(ctx.ncrs).toEqual([expect.objectContaining({ id, status: 'CLOSED', itemKey: 'OPS' })]);
  });

  it('D-08: an owner who is also a reviewer cannot verify their own NCR', async () => {
    const c = await approvedComplaint();
    const n = (await raise(tok.rev, { ...ncrBody(c), title: 'Reviewer-raised' })).body;
    // Reviewer holds ncr.update, so can be owner.
    await api(tok.sup).post(`/ncrs/${n.id}/assign`).send({ ownerId: ids.rev });
    await api(tok.rev).put(`/ncrs/${n.id}/actions`).send(ACTIONS);
    await api(tok.rev).post(`/ncrs/${n.id}/transition`).send({ action: 'submitForVerification' });
    const own = (await api(tok.rev).get(`/ncrs/${n.id}`)).body;
    expect(own.permissions.canVerify).toBe(false);
    expect(own.permissions.reasonIfNotVerify).toMatch(/another reviewer/);
    expect((await verificationEvidence(tok.rev, n.id)).status).toBe(403);
    expect((await verificationEvidence(tok.rev2, n.id)).status).toBe(200);
    const self = await api(tok.rev).post(`/ncrs/${n.id}/transition`).send({ action: 'verify' });
    expect(self.status).toBe(409);
    expect(self.body.error.message).toMatch(/cannot verify their own/);
    expect((await api(tok.rev2).post(`/ncrs/${n.id}/transition`).send({ action: 'verify' })).body.status).toBe('VERIFIED');
  });

  it('lists, filters and summarises NCRs within scope', async () => {
    const list = await api(tok.sup).get('/ncrs?status=OPEN');
    expect(list.status).toBe(200);
    const mine = await api(tok.eng).get('/ncrs?mine=true');
    expect(mine.body.data.every((x: any) => x.owner?.id === ids.eng)).toBe(true);
    const s = (await api(tok.sup).get('/ncrs/summary')).body;
    expect(s).toHaveProperty('awaitingVerification');
    expect(s.closed).toBeGreaterThanOrEqual(1);
    // Options: configured lists for workers; owner candidates only for assigners.
    const engOpt = (await api(tok.eng).get('/ncrs/options')).body;
    expect(engOpt.categories).toContain('Workmanship');
    expect(engOpt.owners).toBeUndefined();
    const supOpt = (await api(tok.sup).get('/ncrs/options')).body;
    const names = supOpt.owners.map((o: any) => o.id);
    expect(names).toEqual(expect.arrayContaining([ids.eng, ids.rev, ids.sup]));
    expect((await api(tok.custA).get('/ncrs/options')).status).toBe(403);
    // Customers have no NCR access.
    expect((await api(tok.custA).get('/ncrs')).status).toBe(403);
  });
});

describe('BR-016 resolve/close guards and BR-015 secure-link acceptance', () => {
  it('blocks resolve while an NCR is open, then runs token acceptance and closure', async () => {
    const c = await approvedComplaint();
    const n = (await raise(tok.eng, ncrBody(c))).body;
    const blocked = await transition(tok.sup, c.complaintId, { action: 'resolve' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain(n.ncrNo);
    // Finish the NCR.
    await api(tok.sup).post(`/ncrs/${n.id}/assign`).send({ ownerId: ids.eng });
    await api(tok.eng).put(`/ncrs/${n.id}/actions`).send(ACTIONS);
    await api(tok.eng).post(`/ncrs/${n.id}/transition`).send({ action: 'submitForVerification' });
    await verificationEvidence(tok.rev, n.id);
    await api(tok.rev).post(`/ncrs/${n.id}/transition`).send({ action: 'verify' });

    expect((await transition(tok.sup, c.complaintId, { action: 'resolve' })).body.status).toBe('RESOLVED');
    const since = capturedMail().length;
    const req = await api(tok.sup).post(`/complaints/${c.complaintId}/request-acceptance`).send({ message: 'Thanks for your patience.' });
    expect(req.status, JSON.stringify(req.body)).toBe(200);
    expect(req.body).toMatchObject({ status: 'PENDING', canResend: true, pendingLink: { recipientEmail: 'jane@example.com', viewedAt: null } });
    const token = linkToken(since)!;
    expect(token).toBeTruthy();
    // Only the hash is stored.
    expect(await AcceptanceToken.countDocuments({ tokenHash: token })).toBe(0);

    // Opening the link never accepts.
    const view = await request(getApp()).get(`/api/v1/customer-acceptance/${token}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ complaint: { customerName: 'Jane Reporter' }, decided: null, serviceCompletion: { visits: 1 } });
    expect(view.body.approvedReports[0].summary).toMatchObject({ pass: 1, fail: 1 });
    expect((await Complaint.findById(c.complaintId).lean())!.status).toBe('CUSTOMER_ACCEPTANCE_PENDING');
    expect((await api(tok.sup).get(`/complaints/${c.complaintId}/acceptance`)).body.pendingLink.viewedAt).toBeTruthy();

    // Close is blocked before acceptance.
    const early = (await api(tok.sup).get(`/complaints/${c.complaintId}/closure-checklist`)).body;
    expect(early.canClose).toBe(false);
    expect(early.conditions.find((x: any) => x.key === 'acceptanceRecorded').met).toBe(false);

    // Name required for the token flow; garbage tokens are rejected.
    expect((await request(getApp()).post(`/api/v1/customer-acceptance/${token}`).send({ decision: 'ACCEPT' })).status).toBe(400);
    expect((await request(getApp()).get(`/api/v1/customer-acceptance/${'x'.repeat(43)}`)).body.error.code).toBe('LINK_INVALID');
    const ok = await request(getApp()).post(`/api/v1/customer-acceptance/${token}`).send({ decision: 'ACCEPT', signerName: 'Jane Reporter', rating: 5, feedback: 'Quick work' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.decided.decision).toBe('ACCEPT');
    // Single use.
    const again = await request(getApp()).post(`/api/v1/customer-acceptance/${token}`).send({ decision: 'REJECT', comments: 'changed my mind', signerName: 'Jane' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('LINK_USED');
    const rec = await CustomerAcceptance.findOne({ complaintId: c.complaintId }).lean();
    expect(rec).toMatchObject({ decision: 'ACCEPT', method: 'TOKEN', decidedByName: 'Jane Reporter', rating: 5 });
    await expect(CustomerAcceptance.updateOne({ _id: rec!._id }, { decision: 'REJECT' })).rejects.toThrow(/immutable/);

    const cl = (await api(tok.sup).get(`/complaints/${c.complaintId}/closure-checklist`)).body;
    expect(cl, JSON.stringify(cl)).toMatchObject({ canClose: true });
    const closed = await transition(tok.sup, c.complaintId, { action: 'close' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.status).toBe('CLOSED');
    expect((await WorkOrder.findById(c.workOrderId).lean())!.status).toBe('CLOSED');
    expect(capturedMail().some((m) => m.to === 'jane@example.com' && /closed/.test(m.subject))).toBe(true);

    // Reopen after close clears the acceptance cycle.
    const ro = await transition(tok.sup, c.complaintId, { action: 'reopen', reason: 'Fault returned' });
    expect(ro.body.status).toBe('REOPENED');
    expect((await Complaint.findById(c.complaintId).lean())!.acceptance?.status).toBeUndefined();
  });

  it('rejection reopens; resolution recorded; resent links supersede old ones; expired links are refused', async () => {
    const c = await approvedComplaint();
    await transition(tok.sup, c.complaintId, { action: 'resolve' });
    let since = capturedMail().length;
    await transition(tok.sup, c.complaintId, { action: 'requestAcceptance' }); // generic button also issues a link
    const first = linkToken(since)!;
    since = capturedMail().length;
    await api(tok.sup).post(`/complaints/${c.complaintId}/acceptance/resend`).send({ recipientEmail: 'ops@example.com' });
    const second = linkToken(since, 'ops@example.com')!;
    expect((await request(getApp()).get(`/api/v1/customer-acceptance/${first}`)).body.error.code).toBe('LINK_SUPERSEDED');

    expect((await request(getApp()).post(`/api/v1/customer-acceptance/${second}`).send({ decision: 'REJECT', signerName: 'Ops' })).status).toBe(400); // comments required
    const rej = await request(getApp()).post(`/api/v1/customer-acceptance/${second}`).send({ decision: 'REJECT', signerName: 'Ops Manager', comments: 'Panel door still sticks' });
    expect(rej.status).toBe(200);
    const after = await Complaint.findById(c.complaintId).lean();
    expect(after!.status).toBe('REOPENED');
    expect(after!.statusHistory.at(-1)!.reason).toContain('Panel door still sticks');
    expect(await Notification.countDocuments({ recipientId: ids.sup, type: 'acceptance.rejected' })).toBeGreaterThanOrEqual(1);

    // Record how it was addressed (no new field work) â†’ resolved again.
    expect((await transition(tok.sup, c.complaintId, { action: 'recordResolution' })).status).toBe(400); // reason required
    const res = await transition(tok.sup, c.complaintId, { action: 'recordResolution', reason: 'Door hinge adjusted during follow-up call' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('RESOLVED');

    since = capturedMail().length;
    await api(tok.sup).post(`/complaints/${c.complaintId}/request-acceptance`).send({});
    const third = linkToken(since)!;
    await AcceptanceToken.updateOne({ complaintId: c.complaintId, status: 'PENDING' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const exp = await request(getApp()).get(`/api/v1/customer-acceptance/${third}`);
    expect(exp.status).toBe(410);
    expect(exp.body.error.code).toBe('LINK_EXPIRED');
    expect((await api(tok.sup).get(`/complaints/${c.complaintId}/acceptance`)).body.pendingLink.expired).toBe(true);
  });

  it('D-12 portal decision is bound to the customer organisation', async () => {
    const c = await approvedComplaint();
    await transition(tok.sup, c.complaintId, { action: 'resolve' });
    await api(tok.sup).post(`/complaints/${c.complaintId}/request-acceptance`).send({});
    expect(await Notification.countDocuments({ type: 'acceptance.requested', entityId: c.complaintId })).toBe(1); // custA only

    expect((await api(tok.custB).get(`/complaints/${c.complaintId}/acceptance`)).status).toBe(404);
    const admin = await api(tok.admin).post(`/complaints/${c.complaintId}/acceptance`).send({ decision: 'ACCEPT' });
    expect(admin.status).toBe(403);
    expect(admin.body.error.code).toBe('NOT_CUSTOMER');
    const view = (await api(tok.custA).get(`/complaints/${c.complaintId}/acceptance`)).body;
    expect(view).toMatchObject({ status: 'PENDING', canDecide: true, pendingLink: null });
    const ok = await api(tok.custA).post(`/complaints/${c.complaintId}/acceptance`).send({ decision: 'ACCEPT', rating: 4 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'ACCEPTED', canDecide: false, records: [expect.objectContaining({ method: 'PORTAL', decidedByName: 'ncustA' })] });
    // The emailed link no longer works once decided in the portal.
    expect(await AcceptanceToken.countDocuments({ complaintId: c.complaintId, status: 'PENDING' })).toBe(0);
  });

  it('D-24 waiver needs a reason; closure still checks time logs', async () => {
    const c = await approvedComplaint(false); // visit not completed (return trip not recorded)
    await transition(tok.sup, c.complaintId, { action: 'resolve' });
    expect((await transition(tok.sup, c.complaintId, { action: 'waiveAcceptance' })).status).toBe(400);
    expect((await transition(tok.eng, c.complaintId, { action: 'waiveAcceptance', reason: 'Customer unreachable' })).status).toBe(403);
    const w = await transition(tok.sup, c.complaintId, { action: 'waiveAcceptance', reason: 'Customer unreachable after three attempts' });
    expect(w.body.status).toBe('CUSTOMER_ACCEPTED');
    expect(await CustomerAcceptance.findOne({ complaintId: c.complaintId }).lean()).toMatchObject({ decision: 'WAIVED', method: 'WAIVER' });

    const blocked = await transition(tok.sup, c.complaintId, { action: 'close' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/Visits completed/);
    for (const e of ['START_RETURN', 'ARRIVE_BASE']) await api(tok.eng).post(`/visits/${c.visitId}/time-events`).send({ eventType: e });
    expect((await transition(tok.sup, c.complaintId, { action: 'close' })).body.status).toBe('CLOSED');
  });
});
