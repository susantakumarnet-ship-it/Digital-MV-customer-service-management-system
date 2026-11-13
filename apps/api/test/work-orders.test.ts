import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/core/audit/audit.model';
import { capturedMail } from '../src/core/mail/mail.service';
import { Notification } from '../src/core/notifications/notification.model';
import { getSettingsGroup, updateSettingsGroup } from '../src/core/settings/settings.service';
import { Complaint } from '../src/modules/complaints/complaint.model';
import { User } from '../src/modules/users/user.model';
import { WorkOrder } from '../src/modules/work-orders/work-order.model';
import { intake, seedLocations, type Locations } from './fixtures';
import { api, bootstrap, createUser, getApp, login } from './helpers';

let L: Locations;
let sup: string;
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};
const key = () => `k${Math.random().toString(36).slice(2)}${Date.now().toString(36)}xx`;

async function newComplaint(overrides: Record<string, unknown> = {}, classify = true) {
  const r = await request(getApp())
    .post('/api/v1/complaints')
    .set('Authorization', `Bearer ${sup}`)
    .set('Idempotency-Key', key())
    .field('data', JSON.stringify({ ...intake(L), source: 'PHONE', ...overrides }));
  expect(r.status).toBe(201);
  if (classify) {
    const c = await api(sup).put(`/complaints/${r.body.id}/classification`).send({ requestTypeId: String(L.requestType._id), priorityId: String(L.p1._id) });
    expect(c.status).toBe(200);
    return c.body;
  }
  return r.body;
}

const woBody = (extra: Record<string, unknown> = {}) => ({
  title: 'Investigate RMU tripping',
  description: 'Inspect protection settings and trip history.',
  ...extra,
});

beforeAll(async () => {
  await bootstrap();
  L = await seedLocations();
  await createUser({ email: 'wsup@test.local', roleKeys: ['SUPERVISOR'], scope: { global: true } });
  for (const [k, scope] of [
    ['engA1', { regionIds: [String(L.A.region._id)] }],
    ['engA2', { regionIds: [String(L.A.region._id)] }],
    ['engB', { regionIds: [String(L.B.region._id)] }],
  ] as [string, { regionIds: string[] }][]) {
    const u = await createUser({ email: `${k}@test.local`, roleKeys: ['ENGINEER'], scope });
    ids[k] = String(u._id);
  }
  await createUser({ email: 'wcust@test.local', roleKeys: ['CUSTOMER'], scope: { organizationIds: [String(L.A.org._id)] }, organizationId: String(L.A.org._id) });
  await createUser({ email: 'wstore@test.local', roleKeys: ['STOREKEEPER'], scope: { global: true } });
  sup = (await login('wsup@test.local')).token;
  for (const k of ['engA1', 'engA2', 'engB']) tok[k] = (await login(`${k}@test.local`)).token;
  tok.cust = (await login('wcust@test.local')).token;
  tok.store = (await login('wstore@test.local')).token;
  ids.sup = String((await User.findOne({ email: 'wsup@test.local' }).lean())!._id);
});

describe('WO-01/02/03 creation rules', () => {
  it('requires a classified complaint (BR-002)', async () => {
    const c = await newComplaint({}, false);
    const r = await api(sup).post(`/complaints/${c.id}/work-orders`).send(woBody());
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('NOT_CLASSIFIED');
    const d = await api(sup).get(`/complaints/${c.id}`);
    expect(d.body.permissions.canCreateWorkOrder).toBe(false);
  });

  it('creates a DRAFT work order with an atomic number, complaint location and SLA defaults', async () => {
    const c = await newComplaint();
    const r = await api(sup).post(`/complaints/${c.id}/work-orders`).send(woBody());
    expect(r.status).toBe(201);
    expect(r.body.workOrderNo).toMatch(new RegExp(`^WO-${new Date().getUTCFullYear()}-\\d{6}$`));
    expect(r.body).toMatchObject({ status: 'DRAFT', statusLabel: 'Draft', complaint: { id: c.id, referenceNo: c.referenceNo }, site: { name: 'Site A' } });
    expect(r.body.dueAt).toBe(c.dueAt); // complaint SLA due date
    expect(r.body.priority.name).toBe('Critical'); // complaint priority
    expect(r.body.supervisor.id).toBe(ids.sup);
    // Complaint is still under review until someone is assigned.
    expect((await api(sup).get(`/complaints/${c.id}`)).body.status).toBe('UNDER_REVIEW');
    expect(await AuditLog.countDocuments({ entityType: 'workOrder', action: 'create', entityRef: r.body.workOrderNo })).toBe(1);
  });

  it('validates shutdown/material details and planned dates', async () => {
    const c = await newComplaint();
    const r = await api(sup)
      .post(`/complaints/${c.id}/work-orders`)
      .send(woBody({ shutdownRequired: true, materialRequired: true, plannedVisitAt: '2026-12-02T10:00:00Z', plannedEndAt: '2026-12-02T08:00:00Z' }));
    expect(r.status).toBe(400);
    expect(Object.keys(r.body.error.fields)).toEqual(expect.arrayContaining(['shutdownDetails', 'materialNotes', 'plannedEndAt']));
  });

  it('honours the single-work-order configuration (D-03 / BR-004)', async () => {
    const c = await newComplaint();
    expect((await api(sup).post(`/complaints/${c.id}/work-orders`).send(woBody())).status).toBe(201);
    expect((await api(sup).post(`/complaints/${c.id}/work-orders`).send(woBody({ title: 'Second visit' }))).status).toBe(201);
    const s = await getSettingsGroup('workflow');
    await updateSettingsGroup({}, 'workflow', { ...s, allowMultipleWorkOrdersPerComplaint: false });
    try {
      const third = await api(sup).post(`/complaints/${c.id}/work-orders`).send(woBody({ title: 'Third' }));
      expect(third.status).toBe(409);
      expect(third.body.error.code).toBe('SINGLE_WORK_ORDER');
    } finally {
      await updateSettingsGroup({}, 'workflow', s);
    }
  });

  it('only supervisors create work orders; engineers and customers cannot', async () => {
    const c = await newComplaint();
    expect((await api(tok.engA1).post(`/complaints/${c.id}/work-orders`).send(woBody())).status).toBe(403);
    expect((await api(tok.cust).post(`/complaints/${c.id}/work-orders`).send(woBody())).status).toBe(403);
  });
});

describe('WO-04/05 assignment', () => {
  let c: any;
  let wo: any;
  beforeAll(async () => {
    c = await newComplaint({ email: 'assign@example.com' });
    wo = (await api(sup).post(`/complaints/${c.id}/work-orders`).send(woBody({ plannedVisitAt: '2026-12-03T08:00:00Z' }))).body;
  });

  it('rejects non-engineers as assignees', async () => {
    const store = await User.findOne({ email: 'wstore@test.local' }).lean();
    const r = await api(sup).patch(`/work-orders/${wo.id}/assignment`).send({ assigneeIds: [String(store!._id)] });
    expect(r.status).toBe(400);
    expect(r.body.error.fields.assigneeIds).toBeTruthy();
    const lead = await api(sup).patch(`/work-orders/${wo.id}/assignment`).send({ assigneeIds: [ids.engA1], leadEngineerId: ids.engA2 });
    expect(lead.status).toBe(400);
  });

  it('assigns engineers: WO → Assigned, complaint → Assigned, history, in-app + email notifications', async () => {
    const mailBefore = capturedMail().length;
    const r = await api(sup).patch(`/work-orders/${wo.id}/assignment`).send({ assigneeIds: [ids.engA1, ids.engA2], leadEngineerId: ids.engA1 });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ASSIGNED');
    expect(r.body.assignees.map((a: any) => [a.name, a.lead, a.accepted])).toEqual([
      ['engA1', true, false],
      ['engA2', false, false],
    ]);
    expect(r.body.assignmentHistory[0]).toMatchObject({ byName: 'wsup', added: [{ name: 'engA1' }, { name: 'engA2' }], removed: [] });
    expect((await api(sup).get(`/complaints/${c.id}`)).body.status).toBe('ASSIGNED');
    expect(await Notification.countDocuments({ type: 'workOrder.assigned', entityId: wo.id })).toBe(2);
    const mails = capturedMail().slice(mailBefore).filter((m) => m.subject.includes(wo.workOrderNo));
    expect(mails.map((m) => m.to).sort()).toEqual(['enga1@test.local', 'enga2@test.local']); // emails are stored lower-case
    expect(await AuditLog.countDocuments({ action: 'complaint.assign', entityId: c.id })).toBe(1);
  });

  it('assigned engineers see the work order in their list and can open its complaint; other regions cannot', async () => {
    const mine = await api(tok.engA1).get('/engineer/work-orders');
    expect(mine.body.data.map((w: any) => w.id)).toContain(wo.id);
    expect((await api(tok.engA1).get(`/complaints/${c.id}`)).status).toBe(200);
    // Region B engineer cannot see it.
    expect((await api(tok.engB).get(`/work-orders/${wo.id}`)).status).toBe(404);
  });

  it('only an assignee can accept; acceptance is recorded per engineer', async () => {
    const outsider = await api(tok.engB).post(`/work-orders/${wo.id}/transitions`).send({ action: 'accept' });
    expect(outsider.status).toBe(404);
    const d = await api(tok.engA1).get(`/work-orders/${wo.id}`);
    expect(d.body.permissions.canAccept).toBe(true);
    const a1 = await api(tok.engA1).post(`/work-orders/${wo.id}/transitions`).send({ action: 'accept' });
    expect(a1.body.status).toBe('ACCEPTED');
    const again = await api(tok.engA1).post(`/work-orders/${wo.id}/transitions`).send({ action: 'accept' });
    expect(again.body.error.code).toBe('ALREADY_ACCEPTED');
    const a2 = await api(tok.engA2).post(`/work-orders/${wo.id}/transitions`).send({ action: 'accept' });
    expect(a2.status).toBe(200);
    expect(a2.body.assignees.every((x: any) => x.accepted)).toBe(true);
    expect(await Notification.countDocuments({ type: 'workOrder.accepted', entityId: wo.id })).toBe(1);
  });

  it('supervisors cannot accept on behalf of engineers', async () => {
    const r = await api(sup).post(`/work-orders/${wo.id}/transitions`).send({ action: 'accept' });
    expect([403, 409]).toContain(r.status);
  });

  it('reassigning accepted work requires a reason and returns it to Assigned for re-acceptance', async () => {
    const noReason = await api(sup).patch(`/work-orders/${wo.id}/assignment`).send({ assigneeIds: [ids.engA1] });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.fields.reason).toBeTruthy();
    const r = await api(sup).patch(`/work-orders/${wo.id}/assignment`).send({ assigneeIds: [ids.engA1], reason: 'engA2 on leave' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ASSIGNED');
    expect(r.body.assignmentHistory[0]).toMatchObject({ removed: [{ name: 'engA2' }], reason: 'engA2 on leave' });
    expect(await Notification.countDocuments({ type: 'workOrder.unassigned', recipientId: ids.engA2 })).toBe(1);
    // engA2 no longer has personal access to the complaint (region A scope still applies, so use engB check via WO list)
    const c2 = await Complaint.findById(c.id).lean();
    expect((c2!.engineerIds ?? []).map(String)).toEqual([ids.engA1]);
  });

  it('schedule requires a planned date; cancel requires a reason and notifies the team', async () => {
    await api(tok.engA1).post(`/work-orders/${wo.id}/transitions`).send({ action: 'accept' });
    const sch = await api(sup).post(`/work-orders/${wo.id}/transitions`).send({ action: 'schedule' });
    expect(sch.body.status).toBe('SCHEDULED');
    const noReason = await api(sup).post(`/work-orders/${wo.id}/transitions`).send({ action: 'cancel' });
    expect(noReason.status).toBe(400);
    const cancel = await api(sup).post(`/work-orders/${wo.id}/transitions`).send({ action: 'cancel', reason: 'Customer fixed it' });
    expect(cancel.body.status).toBe('CANCELLED');
    expect(await Notification.countDocuments({ type: 'workOrder.cancelled', entityId: wo.id })).toBe(1);
    // Cancelled work orders are locked.
    expect((await api(sup).patch(`/work-orders/${wo.id}`).send({ title: 'New title' })).status).toBe(409);
  });

  it('schedule is refused without a planned date', async () => {
    const c3 = await newComplaint();
    const w = (await api(sup).post(`/complaints/${c3.id}/work-orders`).send(woBody({ assigneeIds: [ids.engA1] }))).body;
    expect(w.status).toBe('ASSIGNED'); // assigned at creation
    await api(tok.engA1).post(`/work-orders/${w.id}/transitions`).send({ action: 'accept' });
    const r = await api(sup).post(`/work-orders/${w.id}/transitions`).send({ action: 'schedule' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/planned visit date/);
  });
});

describe('planning edits', () => {
  it('changing the due date requires a reason and is audited; engineers are notified', async () => {
    const c = await newComplaint();
    const w = (await api(sup).post(`/complaints/${c.id}/work-orders`).send(woBody({ assigneeIds: [ids.engA1] }))).body;
    const noReason = await api(sup).patch(`/work-orders/${w.id}`).send({ dueAt: '2027-01-15T12:00:00Z' });
    expect(noReason.status).toBe(400);
    const ok = await api(sup).patch(`/work-orders/${w.id}`).send({ dueAt: '2027-01-15T12:00:00Z', plannedVisitAt: '2027-01-10T08:00:00Z', reason: 'Parts lead time' });
    expect(ok.status).toBe(200);
    expect(ok.body.dueAt).toBe('2027-01-15T12:00:00.000Z');
    const e = await AuditLog.findOne({ entityType: 'workOrder', entityId: w.id, action: 'update' }).lean();
    expect(e!.reason).toBe('Parts lead time');
    expect(await Notification.countDocuments({ type: 'workOrder.updated', entityId: w.id })).toBe(1);
    expect((await api(tok.engA1).patch(`/work-orders/${w.id}`).send({ title: 'Engineer edit' })).status).toBe(403);
  });
});

describe('board, workload and dashboards', () => {
  it('calendar returns planned work overlapping the range, and unplanned work separately', async () => {
    const c = await newComplaint();
    const planned = (await api(sup).post(`/complaints/${c.id}/work-orders`).send(woBody({ assigneeIds: [ids.engA2], plannedVisitAt: '2027-02-02T08:00:00Z', plannedEndAt: '2027-02-03T17:00:00Z' }))).body;
    const unplanned = (await api(sup).post(`/complaints/${c.id}/work-orders`).send(woBody({ title: 'Follow-up' }))).body;
    const r = await api(sup).get('/work-orders/calendar?from=2027-02-03T00:00:00Z&to=2027-02-10T00:00:00Z&includeUnplanned=true');
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: any) => i.id)).toContain(planned.id); // multi-day overlap
    expect(r.body.unplanned.map((i: any) => i.id)).toContain(unplanned.id);
    const tooLong = await api(sup).get('/work-orders/calendar?from=2027-01-01&to=2027-06-01');
    expect(tooLong.status).toBe(400);
  });

  it('workload counts active work per engineer and flags site eligibility', async () => {
    const r = await api(sup).get(`/work-orders/workload?siteId=${L.A.site._id}`);
    expect(r.status).toBe(200);
    const a2 = r.body.find((e: any) => e.id === ids.engA2);
    const b = r.body.find((e: any) => e.id === ids.engB);
    expect(a2.activeWorkOrders).toBeGreaterThanOrEqual(1);
    expect(a2.eligible).toBe(true);
    expect(b.eligible).toBe(false);
    expect((await api(tok.engA1).get('/work-orders/workload')).status).toBe(403);
    // Administrators hold every permission but are not field engineers.
    expect(r.body.some((e: any) => e.email === 'admin@test.local')).toBe(false);
  });

  it('flags overdue work orders and summarises by engineer', async () => {
    const c = await newComplaint();
    const w = (await api(sup).post(`/complaints/${c.id}/work-orders`).send(woBody({ assigneeIds: [ids.engA1], dueAt: new Date(Date.now() - 3600_000).toISOString() }))).body;
    expect(w.overdue).toBe(true);
    const list = await api(sup).get('/work-orders?overdue=true&limit=100');
    expect(list.body.data.map((x: any) => x.id)).toContain(w.id);
    const s = await api(sup).get('/work-orders/summary');
    expect(s.body.overdue).toBeGreaterThanOrEqual(1);
    expect(s.body.byEngineer.find((x: any) => x.engineer === 'engA1').count).toBeGreaterThanOrEqual(1);
    expect(s.body.statuses.find((x: any) => x.key === 'ASSIGNED').label).toBe('Assigned');
  });

  it('complaint detail lists its work orders for staff, not for customers', async () => {
    const c = await newComplaint();
    await api(sup).post(`/complaints/${c.id}/work-orders`).send(woBody());
    const staff = await api(sup).get(`/complaints/${c.id}`);
    expect(staff.body.workOrders).toHaveLength(1);
    expect(staff.body.permissions.canCreateWorkOrder).toBe(true);
    const cust = await api(tok.cust).get(`/complaints/${c.id}`);
    expect(cust.body.workOrders).toEqual([]);
  });

  it('a complaint with an active work order cannot be cancelled (noActiveWorkOrders guard)', async () => {
    const c = await newComplaint();
    await api(sup).post(`/complaints/${c.id}/work-orders`).send(woBody());
    const r = await api(sup).post(`/complaints/${c.id}/transitions`).send({ action: 'cancel', reason: 'Duplicate call' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/active work order/);
    expect(await WorkOrder.countDocuments({ complaintId: c.id })).toBe(1);
  });
});

describe('migration 003 (work-order workflow v2)', () => {
  it('adds the reassign transition to an existing v1 definition exactly once, keeping admin edits', async () => {
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db!;
    const { MIGRATIONS } = await import('../src/db/migrations');
    const { invalidateWorkflowCache } = await import('../src/core/workflow/workflow.engine');
    const m = MIGRATIONS.find((x) => x.id === '2026-11-13-003-work-orders')!;
    // Simulate a database seeded before Phase 4, with an admin-renamed state.
    await db.collection('workflowDefinitions').updateOne(
      { entity: 'workOrder' },
      { $pull: { transitions: { action: 'reassign' } }, $set: { version: 1, 'states.$[s].label': 'Paused' } } as never,
      { arrayFilters: [{ 's.key': 'ON_HOLD' }] },
    );
    await m.up(db);
    await m.up(db); // idempotent
    const def = await db.collection('workflowDefinitions').findOne({ entity: 'workOrder' });
    const reassign = def!.transitions.filter((t: any) => t.action === 'reassign');
    expect(reassign).toHaveLength(1);
    expect(reassign[0]).toMatchObject({ from: ['ACCEPTED', 'SCHEDULED'], to: 'ASSIGNED', systemOnly: true });
    expect(def!.version).toBe(2);
    expect(def!.states.find((s: any) => s.key === 'ON_HOLD').label).toBe('Paused');
    invalidateWorkflowCache();
  });
});
