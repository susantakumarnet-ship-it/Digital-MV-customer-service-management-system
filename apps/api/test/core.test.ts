import mongoose from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/core/audit/audit.model';
import { audit, redact } from '../src/core/audit/audit.service';
import { nextReference } from '../src/core/counters/counter.service';
import { registerGuard, transition, type WorkflowRecord } from '../src/core/workflow/workflow.engine';
import { Role } from '../src/modules/roles/role.model';
import { ADMIN_EMAIL, api, bootstrap, createUser, getApp, login } from './helpers';

let admin: Awaited<ReturnType<typeof login>>;

beforeAll(async () => {
  await bootstrap();
  admin = await login(ADMIN_EMAIL);
});

describe('BR-001 atomic reference numbers', () => {
  it('50 concurrent allocations produce 50 unique, gap-free references in MV-YYYY-000001 format', async () => {
    const year = new Date().getUTCFullYear();
    const refs = await Promise.all(Array.from({ length: 50 }, () => nextReference('complaint')));
    expect(new Set(refs).size).toBe(50);
    const nums = refs.map((r) => Number(r.split('-')[2])).sort((a, b) => a - b);
    expect(nums[0]).toBe(1);
    expect(nums[49]).toBe(50);
    expect(refs.every((r) => new RegExp(`^MV-${year}-\\d{6}$`).test(r))).toBe(true);
  });

  it('uses the configured numbering per document type', async () => {
    const wo = await nextReference('workOrder');
    expect(wo).toMatch(/^WO-\d{4}-000001$/);
  });

  it('rolls back the sequence with an aborted transaction', async () => {
    const session = await mongoose.startSession();
    session.startTransaction();
    await nextReference('ncr', session);
    await session.abortTransaction();
    await session.endSession();
    expect(await nextReference('ncr')).toMatch(/-000001$/);
  });
});

describe('AUD-01 immutable audit log', () => {
  it('cannot be updated or deleted through the model', async () => {
    await audit({ requestId: 't' }, { action: 'test.event', entityType: 'test' });
    const e = await AuditLog.findOne({ action: 'test.event' });
    await expect(AuditLog.updateOne({ _id: e!._id }, { $set: { action: 'tampered' } })).rejects.toThrow(/immutable/);
    await expect(AuditLog.deleteOne({ _id: e!._id })).rejects.toThrow(/immutable/);
    e!.action = 'tampered';
    await expect(e!.save()).rejects.toThrow(/immutable/);
  });

  it('redacts secrets from payloads', () => {
    const out = redact({ name: 'x', password: 'p', nested: { refreshToken: 't', mfa: { secretEnc: 's' } }, passwordHash: 'h' }) as any;
    expect(out).toEqual({ name: 'x', password: '[REDACTED]', nested: { refreshToken: '[REDACTED]', mfa: { secretEnc: '[REDACTED]' } }, passwordHash: '[REDACTED]' });
  });

  it('records actor, role, IP, user agent and request id from HTTP requests', async () => {
    await api(admin.token).post('/masters/regions').set('User-Agent', 'vitest-agent').send({ name: 'Audit Region', code: 'AUDR' });
    const e = await AuditLog.findOne({ entityType: 'regions', action: 'create' }).sort({ timestamp: -1 }).lean();
    expect(e).toMatchObject({ actorName: 'System Administrator', actorRoles: ['ADMIN'], userAgent: 'vitest-agent' });
    expect(e!.ip).toBeTruthy();
    expect(e!.requestId).toBeTruthy();
  });

  it('audit search requires audit.read and never returns payloads in list view', async () => {
    await createUser({ email: 'noaudit@test.local', roleKeys: ['SUPERVISOR'], scope: { global: true } });
    const s = await login('noaudit@test.local');
    expect((await api(s.token).get('/audit-logs')).status).toBe(403);
    const list = await api(admin.token).get('/audit-logs?entityType=regions');
    expect(list.status).toBe(200);
    expect(list.body.data[0].before).toBeUndefined();
    const one = await api(admin.token).get(`/audit-logs/${list.body.data[0].id}`);
    expect(one.body).toHaveProperty('after');
  });
});

describe('WF-01/WF-02 workflow engine', () => {
  const ctxFor = (perms: string[]) => ({
    auth: {
      userId: new mongoose.Types.ObjectId().toString(),
      sessionId: 'x',
      name: 'Tester',
      email: 't@t',
      roles: [{ id: 'r', key: 'SUPERVISOR', name: 'Supervisor' }],
      permissions: new Set(perms) as never,
      scope: { global: true, organizationIds: [], regionIds: [], siteIds: [] },
    },
    requestId: 'wf-test',
  });
  const rec = (status: string): WorkflowRecord => ({ _id: new mongoose.Types.ObjectId(), status, statusHistory: [] });

  it('applies a valid transition, appends history and audits it', async () => {
    const r = rec('NEW');
    const out = await transition({ entity: 'complaint', record: r, action: 'startReview', ctx: ctxFor(['complaint.classify']), entityRef: 'MV-TEST' });
    expect(out).toMatchObject({ from: 'NEW', to: 'UNDER_REVIEW' });
    expect(r.status).toBe('UNDER_REVIEW');
    expect(r.statusHistory).toHaveLength(1);
    expect(await AuditLog.countDocuments({ action: 'complaint.startReview', entityRef: 'MV-TEST' })).toBe(1);
  });

  it('rejects transitions from the wrong state (409), without permission (403), and without a mandatory reason (400)', async () => {
    await expect(transition({ entity: 'complaint', record: rec('CLOSED'), action: 'startReview', ctx: ctxFor(['complaint.classify']) })).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
    await expect(transition({ entity: 'complaint', record: rec('NEW'), action: 'startReview', ctx: ctxFor([]) })).rejects.toMatchObject({ status: 403 });
    await expect(transition({ entity: 'complaint', record: rec('NEW'), action: 'reject', ctx: ctxFor(['complaint.reject']) })).rejects.toMatchObject({ status: 400 });
    await expect(transition({ entity: 'complaint', record: rec('NEW'), action: 'teleport', ctx: ctxFor(['complaint.reject']) })).rejects.toMatchObject({ status: 422 });
  });

  it('system-only transitions cannot be triggered directly', async () => {
    await expect(transition({ entity: 'complaint', record: rec('ASSIGNED'), action: 'startWork', ctx: ctxFor(['complaint.classify']) })).rejects.toMatchObject({ code: 'SYSTEM_TRANSITION' });
    const r = rec('ASSIGNED');
    await transition({ entity: 'complaint', record: r, action: 'startWork', ctx: ctxFor([]), system: true });
    expect(r.status).toBe('IN_PROGRESS');
  });

  it('fails closed when a guard is not implemented, and enforces registered guards', async () => {
    // closureConditionsMet is implemented in Phase 8 → currently unregistered.
    await expect(transition({ entity: 'complaint', record: rec('CUSTOMER_ACCEPTED'), action: 'close', ctx: ctxFor(['complaint.close']) })).rejects.toMatchObject({
      status: 409,
      code: 'WORKFLOW_CONDITIONS_NOT_MET',
    });
    registerGuard('noActiveWorkOrders', (g) => (g.record.blocked ? 'Close the open work orders first.' : null));
    const blocked = { ...rec('NEW'), blocked: true };
    await expect(transition({ entity: 'complaint', record: blocked, action: 'cancel', ctx: ctxFor(['complaint.reject']), reason: 'dup' })).rejects.toMatchObject({
      message: 'Close the open work orders first.',
    });
    const fine = rec('NEW');
    await transition({ entity: 'complaint', record: fine, action: 'cancel', ctx: ctxFor(['complaint.reject']), reason: 'Customer withdrew' });
    expect(fine.status).toBe('CANCELLED');
    expect(fine.statusHistory![0].reason).toBe('Customer withdrew');
  });

  it('API: optional transitions can be disabled; mandatory ones cannot; reason is required', async () => {
    const noReason = await api(admin.token).patch('/workflows/workOrder').send({ transitions: [{ action: 'hold', label: 'Hold', enabled: false }] });
    expect(noReason.status).toBe(400);
    const mand = await api(admin.token).patch('/workflows/workOrder').send({ transitions: [{ action: 'cancel', label: 'Cancel', enabled: false }], reason: 'try' });
    expect(mand.status).toBe(409);
    const ok = await api(admin.token)
      .patch('/workflows/workOrder')
      .send({ transitions: [{ action: 'hold', label: 'Put on hold', enabled: false }], states: [{ key: 'ON_HOLD', label: 'Paused', tone: 'warning' }], reason: 'Not used by operations' });
    expect(ok.status).toBe(200);
    expect(ok.body.states.find((s: any) => s.key === 'ON_HOLD').label).toBe('Paused');
    expect(await AuditLog.countDocuments({ action: 'workflow.changed', entityRef: 'workOrder' })).toBe(1);
  });
});

describe('settings', () => {
  it('validates, audits, and exposes only public values without auth', async () => {
    const bad = await api(admin.token).put('/settings/attachments').send({ value: { allowedExtensions: [], maxFileSizeMb: 0 } });
    expect(bad.status).toBe(400);
    const cur = (await api(admin.token).get('/settings')).body.general;
    const ok = await api(admin.token).put('/settings/general').send({ value: { ...cur, timezone: 'Asia/Dubai' }, reason: 'Go-live timezone' });
    expect(ok.status).toBe(200);
    const pub = await request(getApp()).get('/api/v1/settings/public');
    expect(pub.status).toBe(200);
    expect(pub.body.timezone).toBe('Asia/Dubai');
    expect(pub.body).not.toHaveProperty('security');
    const e = await AuditLog.findOne({ action: 'settings.changed', entityRef: 'general' }).lean();
    expect(e!.after).toEqual({ timezone: 'Asia/Dubai' });
  });
});

describe('API conventions & hardening', () => {
  it('returns the standard error shape with a request id', async () => {
    const r = await api(admin.token).get('/users/not-an-id');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'VALIDATION_FAILED', requestId: expect.any(String) });
    expect(r.headers['x-request-id']).toBe(r.body.error.requestId);
    const nf = await api(admin.token).get('/nope');
    expect(nf.status).toBe(404);
  });

  it('strips MongoDB operators from bodies (NoSQL injection)', async () => {
    const r = await request(getApp()).post('/api/v1/auth/login').send({ identifier: { $ne: null }, password: { $ne: null } });
    expect(r.status).toBe(400);
  });

  it('never exposes password hashes or MFA secrets', async () => {
    const list = await api(admin.token).get('/users?limit=100');
    const text = JSON.stringify(list.body);
    expect(text).not.toMatch(/passwordHash|secretEnc|recoveryCode|\$argon2/);
  });

  it('enforces the maximum page size', async () => {
    const r = await api(admin.token).get('/users?limit=1000');
    expect(r.status).toBe(400);
  });

  it('sets security headers and no-store caching', async () => {
    const r = await request(getApp()).get('/api/v1/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
    const me = await api(admin.token).get('/auth/me');
    expect(me.headers['cache-control']).toBe('no-store');
  });

  it('readiness reports a replica set (transactions available)', async () => {
    const r = await request(getApp()).get('/api/v1/health/ready');
    expect(r.body.database).toEqual({ ok: true, replicaSet: true });
  });

  it('publishes an OpenAPI document covering the routes', async () => {
    const r = await request(getApp()).get('/api/v1/openapi.json');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.paths)).toEqual(expect.arrayContaining(['/api/v1/auth/login', '/api/v1/users/{id}', '/api/v1/masters/{resource}']));
  });

  it('seed is idempotent and does not re-add permissions an admin removed', async () => {
    const { seedRoles } = await import('../src/db/seeds/base');
    await Role.updateOne({ key: 'ENGINEER' }, { $pull: { permissions: 'ncr.create' } });
    await seedRoles(() => undefined);
    const eng = await Role.findOne({ key: 'ENGINEER' }).lean();
    expect(eng!.permissions).not.toContain('ncr.create');
    expect(await Role.countDocuments({ key: 'ENGINEER' })).toBe(1);
  });
});
