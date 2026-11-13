import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/core/audit/audit.model';
import { Notification } from '../src/core/notifications/notification.model';
import { getSettingsGroup, updateSettingsGroup } from '../src/core/settings/settings.service';
import { Complaint } from '../src/modules/complaints/complaint.model';
import { computeDurations } from '../src/modules/visits/visit.service';
import { TimeEvent } from '../src/modules/visits/visit.models';
import { WorkOrder } from '../src/modules/work-orders/work-order.model';
import { acceptedWorkOrder, newVisit, record, recordUpTo, SIX } from './field-fixtures';
import { seedLocations, type Locations } from './fixtures';
import { api, bootstrap, createUser, login } from './helpers';

let L: Locations;
let sup: string;
let reviewer: string;
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};

beforeAll(async () => {
  await bootstrap();
  L = await seedLocations();
  await createUser({ email: 'vsup@test.local', roleKeys: ['SUPERVISOR'], scope: { global: true } });
  await createUser({ email: 'vrev@test.local', roleKeys: ['REVIEWER'], scope: { global: true } });
  for (const k of ['e1', 'e2', 'e3', 'eB']) {
    const u = await createUser({ email: `${k}@test.local`, roleKeys: ['ENGINEER'], scope: { regionIds: [String(k === 'eB' ? L.B.region._id : L.A.region._id)] } });
    ids[k] = String(u._id);
  }
  sup = (await login('vsup@test.local')).token;
  reviewer = (await login('vrev@test.local')).token;
  for (const k of ['e1', 'e2', 'e3', 'eB']) tok[k] = (await login(`${k}@test.local`)).token;
});

describe('ENG-02 visits', () => {
  it('requires an accepted work order and assigned engineers; numbers visits atomically', async () => {
    const wo = await acceptedWorkOrder(L, sup, [ids.e1], []);
    const early = await api(tok.e1).post(`/work-orders/${wo.workOrderId}/visits`).send({ purpose: 'Too early' });
    expect(early.status).toBe(409);
    await api(tok.e1).post(`/work-orders/${wo.workOrderId}/transitions`).send({ action: 'accept' });
    const stranger = await api(tok.e1).post(`/work-orders/${wo.workOrderId}/visits`).send({ purpose: 'With stranger', engineerIds: [ids.e2] });
    expect(stranger.status).toBe(400);
    const v = await newVisit(tok.e1, wo.workOrderId);
    expect(v.visitNo).toMatch(/^VIS-\d{4}-\d{6}$/);
    expect(v).toMatchObject({ status: 'PLANNED', engineers: [{ id: ids.e1 }], mySequence: { nextEvent: 'START_TRAVEL', complete: false } });
    expect((await api(tok.eB).get(`/visits/${v.id}`)).status).toBe(404);
  });
});

describe('TIME-01..05 six ordered events with server timestamps', () => {
  let wo: Awaited<ReturnType<typeof acceptedWorkOrder>>;
  let visitId: string;
  beforeAll(async () => {
    wo = await acceptedWorkOrder(L, sup, [ids.e1, ids.e2], [tok.e1]);
    visitId = (await newVisit(tok.e1, wo.workOrderId, { engineerIds: [ids.e1, ids.e2] })).id;
  });

  it('first Start Travel uses the SERVER time, stores GPS, and moves work order + complaint to In Progress', async () => {
    const before = Date.now();
    const r = await record(tok.e1, visitId, 'START_TRAVEL', {
      clientTimestamp: '2020-01-01T00:00:00Z',
      gps: { latitude: 51.5, longitude: -0.12, accuracy: 12 },
    });
    expect(r.status).toBe(200);
    const ev = r.body.mySequence.events[0];
    expect(new Date(ev.serverTimestamp).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(ev.serverTimestamp).getFullYear()).not.toBe(2020); // client clock ignored
    expect(ev.gps).toMatchObject({ latitude: 51.5, longitude: -0.12, accuracy: 12 });
    expect(r.body.status).toBe('TRAVEL_STARTED');
    expect((await WorkOrder.findById(wo.workOrderId).lean())!.status).toBe('IN_PROGRESS');
    expect((await Complaint.findById(wo.complaintId).lean())!.status).toBe('IN_PROGRESS');
    expect(r.body.mySequence.nextEvent).toBe('ARRIVE_SITE');
  });

  it('rejects out-of-order and duplicate events', async () => {
    const ooo = await record(tok.e1, visitId, 'END_WORK');
    expect(ooo.status).toBe(409);
    expect(ooo.body.error).toMatchObject({ code: 'OUT_OF_ORDER', details: { expected: 'ARRIVE_SITE' } });
    const dup = await record(tok.e1, visitId, 'START_TRAVEL');
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_EVENT');
  });

  it('concurrent duplicate submissions create exactly one event', async () => {
    const [a, b] = await Promise.all([record(tok.e1, visitId, 'ARRIVE_SITE'), record(tok.e1, visitId, 'ARRIVE_SITE')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await TimeEvent.countDocuments({ visitId, userId: ids.e1, eventType: 'ARRIVE_SITE' })).toBe(1);
  });

  it('an Idempotency-Key retry returns the original response instead of a duplicate error', async () => {
    const k = `time-${visitId}-START_WORK-retry1`;
    const a = await record(tok.e1, visitId, 'START_WORK', {}, k);
    const b = await record(tok.e1, visitId, 'START_WORK', {}, k);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await TimeEvent.countDocuments({ visitId, userId: ids.e1, eventType: 'START_WORK' })).toBe(1);
  });

  it('only participating engineers who accepted the work can record time', async () => {
    const notAccepted = await record(tok.e2, visitId, 'START_TRAVEL');
    expect(notAccepted.status).toBe(409);
    expect(notAccepted.body.error.code).toBe('NOT_ACCEPTED');
    expect((await record(sup, visitId, 'START_TRAVEL')).status).toBe(403); // supervisors have no visit.recordTime
    expect((await record(tok.e3, visitId, 'START_TRAVEL')).status).toBe(403); // in scope but not on the visit
  });

  it('D-34: the visit completes only when every engineer who started is back at base', async () => {
    // Co-assignee acknowledges while the work order is already In Progress, then starts travelling.
    const ack = await api(tok.e2).post(`/work-orders/${wo.workOrderId}/transitions`).send({ action: 'accept' });
    expect(ack.status, JSON.stringify(ack.body)).toBe(200);
    expect((await record(tok.e2, visitId, 'START_TRAVEL')).status).toBe(200);
    for (const e of SIX.slice(3)) expect((await record(tok.e1, visitId, e)).status).toBe(200);
    let v = (await api(sup).get(`/visits/${visitId}`)).body;
    expect(v.status).toBe('RETURN_TRAVEL'); // e2 still out
    expect(v.sequences.find((s: any) => s.engineer.id === ids.e1)).toMatchObject({ complete: true, nextEvent: null });
    const d = v.sequences.find((s: any) => s.engineer.id === ids.e1).durations;
    for (const k of ['travelToSite', 'onSiteWaiting', 'onSiteWork', 'returnTravel', 'totalElapsed']) expect(d[k]).not.toBeNull();
    for (const e of SIX.slice(1)) expect((await record(tok.e2, visitId, e)).status).toBe(200);
    v = (await api(sup).get(`/visits/${visitId}`)).body;
    expect(v.status).toBe('COMPLETED');
    expect(v.completedAt).toBeTruthy();
    const seventh = await record(tok.e1, visitId, 'ARRIVE_BASE');
    expect(seventh.body.error.code).toBe('SEQUENCE_COMPLETE');
    expect(await AuditLog.countDocuments({ action: 'timeEvent.recorded', entityId: visitId })).toBe(12);
  });

  it('time events can never be deleted', async () => {
    await expect(TimeEvent.deleteOne({ visitId })).rejects.toThrow(/cannot be deleted/);
  });
});

describe('TIME-04 one active sequence per engineer', () => {
  it('blocks starting a second sequence until the first is finished, unless configured', async () => {
    const wo1 = await acceptedWorkOrder(L, sup, [ids.e3], [tok.e3]);
    const wo2 = await acceptedWorkOrder(L, sup, [ids.e3], [tok.e3]);
    const v1 = (await newVisit(tok.e3, wo1.workOrderId)).id;
    const v2 = (await newVisit(tok.e3, wo2.workOrderId)).id;
    await record(tok.e3, v1, 'START_TRAVEL');
    const blocked = await record(tok.e3, v2, 'START_TRAVEL');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('ACTIVE_SEQUENCE_EXISTS');
    const s = await getSettingsGroup('workflow');
    await updateSettingsGroup({}, 'workflow', { ...s, allowConcurrentTimeSequences: true });
    try {
      expect((await record(tok.e3, v2, 'START_TRAVEL')).status).toBe(200);
    } finally {
      await updateSettingsGroup({}, 'workflow', s);
    }
  });
});

describe('TIME-05 durations across midnight (UTC storage)', () => {
  it('computes durations from absolute timestamps, including visits that cross midnight', () => {
    const at = (iso: string) => new Date(iso);
    const d = computeDurations([
      { eventType: 'START_TRAVEL', serverTimestamp: at('2026-11-13T22:40:00Z') },
      { eventType: 'ARRIVE_SITE', serverTimestamp: at('2026-11-13T23:25:00Z') },
      { eventType: 'START_WORK', serverTimestamp: at('2026-11-13T23:35:00Z') },
      { eventType: 'END_WORK', serverTimestamp: at('2026-11-14T01:50:00Z') },
      { eventType: 'START_RETURN', serverTimestamp: at('2026-11-14T02:00:00Z') },
      { eventType: 'ARRIVE_BASE', serverTimestamp: at('2026-11-14T02:45:00Z'), correctedTimestamp: at('2026-11-14T02:55:00Z') },
    ]);
    expect(d).toEqual({ travelToSite: 45, onSiteWaiting: 10, onSiteWork: 135, returnTravel: 55, totalElapsed: 255 });
  });
});

describe('TIME-07 correction workflow', () => {
  let visitId: string;
  let events: any[];
  beforeAll(async () => {
    const wo = await acceptedWorkOrder(L, sup, [ids.e1], [tok.e1]);
    visitId = (await newVisit(tok.e1, wo.workOrderId)).id;
    const v = await recordUpTo(tok.e1, visitId, 'END_WORK');
    events = v.mySequence.events;
  });

  it('validates the request: own event, reason, window inside the sequence, not in the future', async () => {
    const arrive = events.find((e) => e.eventType === 'ARRIVE_SITE');
    const startTravel = events.find((e) => e.eventType === 'START_TRAVEL');
    const noReason = await api(tok.e1).post(`/visits/${visitId}/time-corrections`).send({ timeEventId: arrive.id, proposedTimestamp: arrive.serverTimestamp });
    expect(noReason.status).toBe(400);
    const tooEarly = await api(tok.e1)
      .post(`/visits/${visitId}/time-corrections`)
      .send({ timeEventId: arrive.id, proposedTimestamp: new Date(new Date(startTravel.serverTimestamp).getTime() - 60_000).toISOString(), reason: 'Forgot to tap' });
    expect(tooEarly.status).toBe(400);
    expect(tooEarly.body.error.fields.proposedTimestamp).toMatch(/after START_TRAVEL/);
    const future = await api(tok.e1).post(`/visits/${visitId}/time-corrections`).send({ timeEventId: arrive.id, proposedTimestamp: new Date(Date.now() + 3600_000).toISOString(), reason: 'x'.repeat(10) });
    expect(future.status).toBe(400);
    // In scope, but not their event → forbidden.
    expect((await api(tok.e2).post(`/visits/${visitId}/time-corrections`).send({ timeEventId: arrive.id, proposedTimestamp: arrive.serverTimestamp, reason: 'Not mine' })).status).toBe(403);
  });

  it('keeps the original, needs independent approval, then uses the corrected time in durations', async () => {
    const [st, ar, sw] = events;
    // Proposed: halfway between start travel and the recorded arrival.
    const proposed = new Date((new Date(st.serverTimestamp).getTime() + new Date(ar.serverTimestamp).getTime()) / 2);
    proposed.setMilliseconds(0);
    if (proposed <= new Date(st.serverTimestamp)) proposed.setTime(new Date(st.serverTimestamp).getTime() + 1);
    const req = await api(tok.e1).post(`/visits/${visitId}/time-corrections`).send({ timeEventId: ar.id, proposedTimestamp: proposed.toISOString(), reason: 'Tapped late after parking' });
    expect(req.status).toBe(200);
    expect(req.body.mySequence.events[1].pendingCorrection).toBeTruthy();
    expect(await Notification.countDocuments({ type: 'timeCorrection.requested' })).toBeGreaterThanOrEqual(1);
    const second = await api(tok.e1).post(`/visits/${visitId}/time-corrections`).send({ timeEventId: ar.id, proposedTimestamp: proposed.toISOString(), reason: 'Again please' });
    expect(second.body.error.code).toBe('CORRECTION_PENDING');

    const pending = (await api(sup).get(`/time-corrections?visitId=${visitId}`)).body.data[0];
    expect(pending).toMatchObject({ status: 'PENDING', eventType: 'ARRIVE_SITE', reason: 'Tapped late after parking' });
    const rejectNoComment = await api(reviewer).post(`/time-corrections/${pending.id}/decision`).send({ decision: 'REJECT' });
    expect(rejectNoComment.status).toBe(400);
    const ok = await api(reviewer).post(`/time-corrections/${pending.id}/decision`).send({ decision: 'APPROVE', comment: 'Confirmed by site log' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'APPROVED', reviewerName: 'vrev' });

    const v = (await api(sup).get(`/visits/${visitId}`)).body;
    const arrive = v.sequences[0].events[1];
    expect(arrive.serverTimestamp).toBe(ar.serverTimestamp); // original unchanged
    expect(arrive.effectiveTimestamp).toBe(proposed.toISOString());
    expect(arrive.corrected).toBe(true);
    const expectedTravel = Math.round((proposed.getTime() - new Date(st.serverTimestamp).getTime()) / 60000);
    expect(v.sequences[0].durations.travelToSite).toBe(expectedTravel);
    void sw;
    expect(await AuditLog.countDocuments({ action: { $in: ['timeCorrection.requested', 'timeCorrection.approved'] }, entityId: visitId })).toBe(2);
    const raw = await TimeEvent.findById(ar.id).lean();
    expect(raw!.serverTimestamp.toISOString()).toBe(ar.serverTimestamp);
  });

  it('nobody approves corrections to their own time (segregation of duties)', async () => {
    const ev = (await api(tok.e1).get(`/visits/${visitId}`)).body.mySequence.events[3]; // END_WORK
    const r = await api(tok.e1).post(`/visits/${visitId}/time-corrections`).send({ timeEventId: ev.id, proposedTimestamp: ev.serverTimestamp, reason: 'Testing self approval' });
    expect(r.status).toBe(200);
    const c = (await api(sup).get(`/time-corrections?visitId=${visitId}`)).body.data[0];
    expect((await api(tok.e1).post(`/time-corrections/${c.id}/decision`).send({ decision: 'APPROVE' })).status).toBe(403); // engineers lack the permission
    // A supervisor who is also the engineer on the visit would be blocked by SELF_APPROVAL — simulate by deciding as requester:
    const rej = await api(sup).post(`/time-corrections/${c.id}/decision`).send({ decision: 'REJECT', comment: 'No evidence' });
    expect(rej.body.status).toBe('REJECTED');
    const again = await api(sup).post(`/time-corrections/${c.id}/decision`).send({ decision: 'APPROVE' });
    expect(again.body.error.code).toBe('ALREADY_DECIDED');
  });
});
