import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/core/audit/audit.model';
import { Organization } from '../src/modules/masters/master.models';
import { Role } from '../src/modules/roles/role.model';
import { User } from '../src/modules/users/user.model';
import { ADMIN_EMAIL, api, bootstrap, createRole, createUser, login } from './helpers';

let admin: Awaited<ReturnType<typeof login>>;
let orgA: string;
let orgB: string;

beforeAll(async () => {
  await bootstrap();
  admin = await login(ADMIN_EMAIL);
  orgA = String((await Organization.create({ name: 'Org A', code: 'ORGA' }))._id);
  orgB = String((await Organization.create({ name: 'Org B', code: 'ORGB' }))._id);
});

describe('RBAC-03 default deny', () => {
  it('returns 401 without a token', async () => {
    expect((await api().get('/users')).status).toBe(401);
    expect((await api().get('/masters/regions')).status).toBe(401);
    expect((await api().get('/audit-logs')).status).toBe(401);
  });

  it('a role with no permissions can reach nothing protected', async () => {
    const empty = await createRole('Empty role', []);
    await createUser({ email: 'nobody-perms@test.local', roleIds: [String(empty._id)], scope: { global: true } });
    const s = await login('nobody-perms@test.local');
    expect(s.body.user.permissions).toEqual([]);
    for (const url of ['/users', '/roles', '/masters/regions', '/settings', '/audit-logs', '/notifications', '/dashboard/admin', '/workflows']) {
      const r = await api(s.token).get(url);
      expect(r.status, url).toBe(403);
    }
  });

  it('engineer cannot manage users, roles, master data or configuration', async () => {
    await createUser({ email: 'eng-rbac@test.local', roleKeys: ['ENGINEER'], scope: { global: true } });
    const s = await login('eng-rbac@test.local');
    expect((await api(s.token).get('/users')).status).toBe(403);
    expect((await api(s.token).post('/roles').send({ name: 'x', permissions: [] })).status).toBe(403);
    expect((await api(s.token).post('/masters/regions').send({ name: 'R', code: 'R1' })).status).toBe(403);
    expect((await api(s.token).put('/settings/general').send({ value: {} })).status).toBe(403);
    // But can read master data (needed for dropdowns)
    expect((await api(s.token).get('/masters/regions')).status).toBe(200);
  });

  it('management viewer is read-only', async () => {
    await createUser({ email: 'mgmt@test.local', roleKeys: ['MANAGEMENT'], scope: { global: true } });
    const s = await login('mgmt@test.local');
    expect((await api(s.token).get('/masters/sites')).status).toBe(200);
    expect((await api(s.token).post('/masters/regions').send({ name: 'R', code: 'MG1' })).status).toBe(403);
  });

  it('effective permissions are the union of multiple roles; inactive roles grant nothing', async () => {
    const r1 = await createRole('Union A', ['master.read']);
    const r2 = await createRole('Union B', ['audit.read']);
    await createUser({ email: 'union@test.local', roleIds: [String(r1._id), String(r2._id)], scope: { global: true } });
    let s = await login('union@test.local');
    expect(s.body.user.permissions).toEqual(['audit.read', 'master.read']);
    await Role.updateOne({ _id: r2._id }, { $set: { status: 'INACTIVE' } });
    s = await login('union@test.local');
    expect(s.body.user.permissions).toEqual(['master.read']);
    expect((await api(s.token).get('/audit-logs')).status).toBe(403);
  });
});

describe('anti-escalation and lock-out protection', () => {
  it('a user administrator cannot assign roles granting permissions they lack', async () => {
    const limited = await createRole('User admin (limited)', ['user.read', 'user.create', 'user.update', 'user.administer', 'role.read']);
    await createUser({ email: 'useradmin@test.local', roleIds: [String(limited._id)], scope: { global: true } });
    const s = await login('useradmin@test.local');
    const adminRole = await Role.findOne({ key: 'ADMIN' }).lean();
    const r = await api(s.token)
      .post('/users')
      .send({ name: 'Escalate', email: 'esc@test.local', roleIds: [String(adminRole!._id)], scope: { global: true }, password: 'Escalate-Passw0rd' });
    expect(r.status).toBe(403);
    // …but may assign a role within their own permissions
    const ok = await api(s.token)
      .post('/users')
      .send({ name: 'Fine', email: 'fine@test.local', roleIds: [String(limited._id)], scope: { global: true }, password: 'Fine-Passw0rd-12' });
    expect(ok.status).toBe(201);
  });

  it('a role editor cannot grant permissions they do not hold', async () => {
    const editor = await createRole('Role editor', ['role.read', 'role.create', 'role.update']);
    await createUser({ email: 'roleeditor@test.local', roleIds: [String(editor._id)], scope: { global: true } });
    const s = await login('roleeditor@test.local');
    const r = await api(s.token).post('/roles').send({ name: 'Sneaky', permissions: ['settings.update'] });
    expect(r.status).toBe(403);
  });

  it('administrator role keeps its floor permissions', async () => {
    const adminRole = await Role.findOne({ key: 'ADMIN' }).lean();
    const r = await api(admin.token)
      .patch(`/roles/${adminRole!._id}`)
      .send({ permissions: adminRole!.permissions.filter((p) => p !== 'user.administer') });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ADMIN_FLOOR');
  });

  it('cannot deactivate yourself or the last administrator', async () => {
    const me = await User.findOne({ email: ADMIN_EMAIL }).lean();
    const self = await api(admin.token).post(`/users/${me!._id}/deactivate`).send({ reason: 'test' });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('SELF_DEACTIVATION');

    const adminRole = await Role.findOne({ key: 'ADMIN' }).lean();
    const engRole = await Role.findOne({ key: 'ENGINEER' }).lean();
    const demote = await api(admin.token).put(`/users/${me!._id}/roles`).send({ roleIds: [String(engRole!._id)] });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe('LAST_ADMIN');
    void adminRole;
  });

  it('customer role cannot be combined with internal roles and requires an organization', async () => {
    const roles = await Role.find({ key: { $in: ['CUSTOMER', 'ENGINEER'] } }).lean();
    const combined = await api(admin.token)
      .post('/users')
      .send({ name: 'Mix', email: 'mix@test.local', roleIds: roles.map((r) => String(r._id)), scope: { global: false }, organizationId: orgA, password: 'Mixed-Passw0rd-1' });
    expect(combined.status).toBe(400);
    const cust = roles.find((r) => r.key === 'CUSTOMER')!;
    const noOrg = await api(admin.token)
      .post('/users')
      .send({ name: 'NoOrg', email: 'noorg@test.local', roleIds: [String(cust._id)], scope: { global: true }, password: 'NoOrg-Passw0rd-1' });
    expect(noOrg.status).toBe(400);
    const ok = await api(admin.token)
      .post('/users')
      .send({ name: 'Cust', email: 'cust@test.local', roleIds: [String(cust._id)], scope: { global: true }, organizationId: orgA, password: 'Custo-Passw0rd-1' });
    expect(ok.status).toBe(201);
    // Scope is forced to the customer's own organization, global ignored.
    expect(ok.body.scope).toEqual({ global: false, organizationIds: [orgA], regionIds: [], siteIds: [] });
  });

  it('PUBLIC_REPORTER cannot be assigned to accounts', async () => {
    const pr = await Role.findOne({ key: 'PUBLIC_REPORTER' }).lean();
    const r = await api(admin.token)
      .post('/users')
      .send({ name: 'Pub', email: 'pub@test.local', roleIds: [String(pr!._id)], scope: { global: true }, password: 'Publi-Passw0rd-1' });
    expect(r.status).toBe(400);
  });
});

describe('RBAC-05 data scoping (users)', () => {
  it('a scoped administrator sees only users of organizations in scope and cannot grant wider scope', async () => {
    const scopedAdmin = await createRole('Scoped user admin', ['user.read', 'user.update', 'user.create', 'user.administer']);
    await createUser({ email: 'scoped-admin@test.local', roleIds: [String(scopedAdmin._id)], scope: { organizationIds: [orgA] }, organizationId: orgA });
    await createUser({ email: 'in-a@test.local', roleKeys: [], organizationId: orgA });
    const inB = await createUser({ email: 'in-b@test.local', roleKeys: [], organizationId: orgB });
    const s = await login('scoped-admin@test.local');

    const list = await api(s.token).get('/users?limit=100');
    const emails = list.body.data.map((u: any) => u.email);
    expect(emails).toContain('in-a@test.local');
    expect(emails).not.toContain('in-b@test.local');

    // IDOR: direct access by id outside scope is 404 (not leaked as 403)
    expect((await api(s.token).get(`/users/${inB._id}`)).status).toBe(404);

    const wider = await api(s.token)
      .post('/users')
      .send({ name: 'W', email: 'wider@test.local', roleIds: [String(scopedAdmin._id)], scope: { global: false, organizationIds: [orgB] }, organizationId: orgA, password: 'Wider-Passw0rd-1' });
    expect(wider.status).toBe(403);
  });
});

describe('RBAC-08 permission changes are audited', () => {
  it('records role permission changes with added/removed keys', async () => {
    const r = await createRole('Audited role', ['master.read']);
    const res = await api(admin.token).patch(`/roles/${r._id}`).send({ permissions: ['master.read', 'audit.read'], reason: 'Needs audit access' });
    expect(res.status).toBe(200);
    const entry = await AuditLog.findOne({ action: 'role.permissions.changed', entityId: r._id }).lean();
    expect(entry).toBeTruthy();
    expect(entry!.after).toEqual({ added: ['audit.read'] });
    expect(entry!.reason).toBe('Needs audit access');
  });
});
