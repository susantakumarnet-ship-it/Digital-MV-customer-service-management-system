import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/core/audit/audit.model';
import { capturedMail } from '../src/core/mail/mail.service';
import { Notification } from '../src/core/notifications/notification.model';
import { Attachment } from '../src/core/storage/attachment.model';
import { Complaint } from '../src/modules/complaints/complaint.model';
import { PNG, intake, seedLocations, type Locations } from './fixtures';
import { ADMIN_EMAIL, api, bootstrap, createUser, getApp, login } from './helpers';

let L: Locations;
let sup: string; // supervisor token (global)
let admin: string;
const tok: Record<string, string> = {};
const key = () => `k${Math.random().toString(36).slice(2)}${Date.now().toString(36)}xx`;

function register(token: string, data: Record<string, unknown>, files: { buf: Buffer; name: string }[] = []) {
  let r = request(getApp()).post('/api/v1/complaints').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key()).field('data', JSON.stringify(data));
  for (const f of files) r = r.attach('files', f.buf, f.name);
  return r;
}

beforeAll(async () => {
  await bootstrap();
  L = await seedLocations();
  admin = (await login(ADMIN_EMAIL)).token;
  await createUser({ email: 'sup@test.local', roleKeys: ['SUPERVISOR'], scope: { global: true } });
  await createUser({ email: 'engA@test.local', roleKeys: ['ENGINEER'], scope: { regionIds: [String(L.A.region._id)] } });
  await createUser({ email: 'custA@test.local', roleKeys: ['CUSTOMER'], scope: { organizationIds: [String(L.A.org._id)] }, organizationId: String(L.A.org._id) });
  await createUser({ email: 'custB@test.local', roleKeys: ['CUSTOMER'], scope: { organizationIds: [String(L.B.org._id)] }, organizationId: String(L.B.org._id) });
  await createUser({ email: 'mgmt@test.local', roleKeys: ['MANAGEMENT'], scope: { global: true } });
  sup = (await login('sup@test.local')).token;
  for (const u of ['engA', 'custA', 'custB', 'mgmt']) tok[u] = (await login(`${u}@test.local`)).token;
});

describe('internal and portal registration', () => {
  it('staff register a phone complaint with the real received time', async () => {
    const receivedAt = new Date(Date.now() - 3 * 3600_000).toISOString();
    const r = await register(sup, { ...intake(L), source: 'PHONE', receivedAt });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ source: 'PHONE', status: 'NEW', statusLabel: 'New' });
    expect(new Date(r.body.receivedAt).toISOString()).toBe(receivedAt);
  });

  it('rejects a received time in the future', async () => {
    const r = await register(sup, { ...intake(L), receivedAt: new Date(Date.now() + 86400_000).toISOString() });
    expect(r.status).toBe(400);
    expect(r.body.error.fields.receivedAt).toBeTruthy();
  });

  it('portal customers can only register for their own organisation; source is forced', async () => {
    const ok = await register(tok.custA, { ...intake(L), source: 'PHONE', receivedAt: new Date(Date.now() - 86400_000).toISOString() });
    expect(ok.status).toBe(201);
    expect(ok.body.source).toBe('CUSTOMER_PORTAL');
    expect(Math.abs(new Date(ok.body.receivedAt).getTime() - Date.now())).toBeLessThan(60_000);
    const other = await register(tok.custA, intake(L, { regionId: String(L.B.region._id), cityId: String(L.B.city._id), siteId: String(L.B.site._id), assetId: undefined }));
    expect(other.status).toBe(403);
  });

  it('form options for signed-in users are limited to their scope', async () => {
    const sites = await api(tok.custA).get('/complaints/options/sites');
    expect(sites.status).toBe(200);
    expect(sites.body.map((s: any) => s.code)).toEqual(['SITE-A']);
    const regions = await api(tok.custA).get('/complaints/options/regions');
    expect(regions.body.map((r: any) => r.code)).toEqual(['REG-A']);
    const assets = await api(tok.custA).get('/complaints/options/assets');
    expect(assets.body.map((a: any) => a.code)).toEqual(['AST-A1']);
    const all = await api(sup).get('/complaints/options/sites');
    expect(all.body.length).toBeGreaterThanOrEqual(2);
    expect((await api(tok.custA).get('/complaints/options/requestTypes')).body.length).toBeGreaterThan(0);
  });

  it('dashboard summary uses configured status labels', async () => {
    const s = await api(sup).get('/complaints/summary');
    expect(s.body.statuses.find((x: any) => x.key === 'NEW')).toMatchObject({ label: 'New', tone: 'info' });
  });

  it('engineers cannot register complaints (no complaint.create)', async () => {
    expect((await register(tok.engA, intake(L))).status).toBe(403);
  });
});

describe('RBAC-05 record-level scoping and masking', () => {
  let idA: string;
  let idB: string;
  beforeAll(async () => {
    idA = (await register(sup, intake(L, { email: 'a-scope@example.com' }))).body.id;
    idB = (await register(sup, intake(L, { email: 'b-scope@example.com', regionId: String(L.B.region._id), cityId: String(L.B.city._id), siteId: String(L.B.site._id), assetId: String(L.assetB._id) }))).body.id;
  });

  it('region-scoped engineer and org-scoped customer see only their complaints', async () => {
    const eng = await api(tok.engA).get('/complaints?limit=100');
    expect(eng.body.data.map((c: any) => c.id)).toContain(idA);
    expect(eng.body.data.map((c: any) => c.id)).not.toContain(idB);
    const cust = await api(tok.custB).get('/complaints?limit=100');
    expect(cust.body.data.map((c: any) => c.id)).toEqual([idB]);
  });

  it('direct access outside scope is 404 (no IDOR)', async () => {
    expect((await api(tok.engA).get(`/complaints/${idB}`)).status).toBe(404);
    expect((await api(tok.custA).get(`/complaints/${idB}`)).status).toBe(404);
  });

  it('masks contact details for management, not for supervisors, engineers or the customer', async () => {
    const m = await api(tok.mgmt).get(`/complaints/${idA}`);
    expect(m.body.contactMasked).toBe(true);
    expect(m.body.email).toBe('a***@example.com');
    expect(m.body.mobile).not.toContain('7700');
    for (const t of [sup, tok.engA, tok.custA]) {
      const r = await api(t).get(`/complaints/${idA}`);
      expect(r.body.contactMasked).toBe(false);
      expect(r.body.email).toBe('a-scope@example.com');
    }
  });

  it('customers never see internal notes or staff actions', async () => {
    await api(sup).post(`/complaints/${idA}/notes`).send({ text: 'Customer is difficult — handle with care' });
    const c = await api(tok.custA).get(`/complaints/${idA}`);
    expect(c.body.internalNotes).toBeUndefined();
    expect(JSON.stringify(c.body)).not.toContain('difficult');
    expect(c.body.availableActions).toEqual([]);
    expect((await api(tok.custA).post(`/complaints/${idA}/notes`).send({ text: 'x' })).status).toBe(403);
    const s = await api(sup).get(`/complaints/${idA}`);
    expect(s.body.internalNotes[0].text).toContain('difficult');
  });
});

describe('CMP-03 classification and SLA', () => {
  it('classifying a NEW complaint starts review, sets the SLA due date and acknowledgement, and is audited', async () => {
    const receivedAt = new Date(Date.now() - 3600_000);
    const c = (await register(sup, { ...intake(L), source: 'EMAIL', receivedAt: receivedAt.toISOString() })).body;
    const r = await api(sup).put(`/complaints/${c.id}/classification`).send({ requestTypeId: String(L.requestType._id), priorityId: String(L.p1._id), category: 'Protection' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('UNDER_REVIEW');
    expect(r.body.priority).toMatchObject({ name: 'Critical', tone: 'danger' });
    expect(new Date(r.body.dueAt).getTime()).toBe(receivedAt.getTime() + 24 * 3600_000);
    expect(r.body.acknowledgedAt).toBeTruthy();
    expect(r.body.supervisor.name).toBe('sup');
    expect(await AuditLog.countDocuments({ entityId: c.id, action: { $in: ['complaint.startReview', 'complaint.classified'] } })).toBe(2);
  });

  it('rejects an invalid supervisor and denies engineers', async () => {
    const c = (await register(sup, intake(L))).body;
    const engUser = (await api(admin).get('/users?q=engA')).body.data[0];
    const bad = await api(sup).put(`/complaints/${c.id}/classification`).send({ requestTypeId: String(L.requestType._id), priorityId: String(L.p3._id), supervisorId: engUser.id });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.supervisorId).toBeTruthy();
    expect((await api(tok.engA).put(`/complaints/${c.id}/classification`).send({ requestTypeId: String(L.requestType._id), priorityId: String(L.p3._id) })).status).toBe(403);
  });

  it('flags overdue complaints and filters by overdue / open', async () => {
    const c = (await register(sup, { ...intake(L, { email: 'late@example.com' }), receivedAt: new Date(Date.now() - 48 * 3600_000).toISOString() })).body;
    await api(sup).put(`/complaints/${c.id}/classification`).send({ requestTypeId: String(L.requestType._id), priorityId: String(L.p1._id) });
    const overdue = await api(sup).get('/complaints?overdue=true&limit=100');
    const row = overdue.body.data.find((x: any) => x.id === c.id);
    expect(row.overdue).toBe(true);
    const summary = await api(sup).get('/complaints/summary');
    expect(summary.body.overdue).toBeGreaterThanOrEqual(1);
    expect(summary.body.byMonth).toHaveLength(12);
  });
});

describe('workflow actions (WF-02 via API)', () => {
  it('reject requires a reason, then notifies the customer by email', async () => {
    const c = (await register(sup, intake(L, { email: 'reject@example.com' }))).body;
    const noReason = await api(sup).post(`/complaints/${c.id}/transitions`).send({ action: 'reject' });
    expect(noReason.status).toBe(400);
    const before = capturedMail().length;
    const ok = await api(sup).post(`/complaints/${c.id}/transitions`).send({ action: 'reject', reason: 'Not our equipment' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('REJECTED');
    expect(capturedMail().slice(before).some((m) => m.to === 'reject@example.com' && m.text.includes('Not our equipment'))).toBe(true);
    // Terminal: no more edits.
    expect((await api(sup).patch(`/complaints/${c.id}`).send({ description: 'Changed after rejection' })).status).toBe(409);
  });

  it('request-for-information round trip with a portal customer', async () => {
    const c = (await register(sup, intake(L))).body;
    const req = await api(sup).post(`/complaints/${c.id}/transitions`).send({ action: 'requestInfo', reason: 'Need photos', messageToCustomer: 'Please send photos of the RMU panel.' });
    expect(req.body.status).toBe('AWAITING_CUSTOMER_INFO');
    const custUser = await (await import('../src/modules/users/user.model')).User.findOne({ email: 'custA@test.local' }).lean();
    expect(await Notification.countDocuments({ recipientId: custUser!._id, type: 'complaint.infoRequested' })).toBe(1);

    const resp = await request(getApp())
      .post(`/api/v1/complaints/${c.id}/customer-response`)
      .set('Authorization', `Bearer ${tok.custA}`)
      .field('data', JSON.stringify({ message: 'Photos attached.' }))
      .attach('files', PNG, 'panel.png');
    expect(resp.status).toBe(200);
    expect(resp.body.status).toBe('UNDER_REVIEW');
    expect(resp.body.customerMessages.map((m: any) => m.direction)).toEqual(['TO_CUSTOMER', 'FROM_CUSTOMER']);
    expect(resp.body.attachments.some((a: any) => a.context === 'customerResponse')).toBe(true);

    const again = await request(getApp())
      .post(`/api/v1/complaints/${c.id}/customer-response`)
      .set('Authorization', `Bearer ${tok.custA}`)
      .field('data', JSON.stringify({ message: 'More' }));
    expect(again.status).toBe(409);
  });

  it('system-only and not-yet-implemented transitions cannot be forced', async () => {
    const c = (await register(sup, intake(L))).body;
    const assign = await api(sup).post(`/complaints/${c.id}/transitions`).send({ action: 'assign' });
    expect(assign.body.error.code).toBe('SYSTEM_TRANSITION');
    const close = await api(sup).post(`/complaints/${c.id}/transitions`).send({ action: 'close' });
    expect(close.status).toBe(409);
    const unknown = await api(sup).post(`/complaints/${c.id}/transitions`).send({ action: 'deleteEverything' });
    expect(unknown.status).toBe(422);
  });
});

describe('BR-003 duplicates are linked, never deleted', () => {
  it('links a duplicate to its original and keeps both records', async () => {
    const master = (await register(sup, intake(L, { email: 'm@example.com' }))).body;
    const dup = (await register(sup, intake(L, { email: 'd@example.com' }))).body;
    const total = await Complaint.countDocuments();

    const poss = await api(sup).get(`/complaints/${dup.id}/possible-duplicates`);
    expect(poss.body.map((p: any) => p.id)).toContain(master.id);

    const missing = await api(sup).post(`/complaints/${dup.id}/transitions`).send({ action: 'markDuplicate', reason: 'Same fault' });
    expect(missing.status).toBe(409);
    const self = await api(sup).post(`/complaints/${dup.id}/transitions`).send({ action: 'markDuplicate', reason: 'x', duplicateOfId: dup.id });
    expect(self.body.error.message).toMatch(/itself/);

    const ok = await api(sup).post(`/complaints/${dup.id}/transitions`).send({ action: 'markDuplicate', reason: 'Same fault', duplicateOfId: master.id });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'DUPLICATE', duplicateOf: { id: master.id, referenceNo: master.referenceNo } });
    const m = await api(sup).get(`/complaints/${master.id}`);
    expect(m.body.linkedDuplicates.map((d: any) => d.id)).toEqual([dup.id]);
    expect(await Complaint.countDocuments()).toBe(total);

    // Cannot link to a duplicate.
    const third = (await register(sup, intake(L))).body;
    const chain = await api(sup).post(`/complaints/${third.id}/transitions`).send({ action: 'markDuplicate', reason: 'x', duplicateOfId: dup.id });
    expect(chain.body.error.message).toMatch(/itself a duplicate/);
  });
});

describe('SEC-05 attachment access', () => {
  let complaintId: string;
  let fileId: string;
  beforeAll(async () => {
    const c = (await register(sup, intake(L), [{ buf: PNG, name: 'evidence.png' }])).body;
    complaintId = c.id;
    fileId = c.attachments[0].id;
  });

  it('issues a signed URL only to users who can see the complaint, and serves the exact bytes', async () => {
    const u = await api(tok.engA).get(`/files/${fileId}/url`);
    expect(u.status).toBe(200);
    const dl = await request(getApp()).get(u.body.url).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect(Buffer.compare(dl.body as Buffer, PNG)).toBe(0);
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect((await api(tok.custB).get(`/files/${fileId}/url`)).status).toBe(404);
    expect(await AuditLog.countDocuments({ action: 'attachment.download', entityId: complaintId })).toBe(1);
  });

  it('rejects tampered and expired links', async () => {
    const u = (await api(sup).get(`/files/${fileId}/url`)).body.url as string;
    const tampered = u.replace(/sig=([^&]+)/, (_m, s: string) => `sig=${s.slice(0, -2)}AA`);
    expect((await request(getApp()).get(tampered)).status).toBe(403);
    const expired = u.replace(/exp=\d+/, `exp=${Math.floor(Date.now() / 1000) - 10}`);
    expect((await request(getApp()).get(expired)).status).toBe(403);
    const otherFile = u.replace(fileId, '0123456789abcdef01234567');
    expect((await request(getApp()).get(otherFile)).status).toBe(403);
  });

  it('internal attachments are hidden from customers', async () => {
    const r = await request(getApp())
      .post(`/api/v1/complaints/${complaintId}/attachments`)
      .set('Authorization', `Bearer ${sup}`)
      .field('data', JSON.stringify({ context: 'internal' }))
      .attach('files', PNG, 'internal-sketch.png');
    expect(r.status).toBe(200);
    const internal = await Attachment.findOne({ ownerId: complaintId, context: 'internal' }).lean();
    const cust = await api(tok.custA).get(`/complaints/${complaintId}`);
    expect(cust.body.attachments.map((a: any) => a.id)).not.toContain(String(internal!._id));
    expect((await api(tok.custA).get(`/files/${internal!._id}/url`)).status).toBe(404);
  });
});

describe('list, search and export', () => {
  it('searches by reference and filters OPEN', async () => {
    const c = (await register(sup, intake(L))).body;
    const r = await api(sup).get(`/complaints?q=${c.referenceNo}`);
    expect(r.body.data.map((x: any) => x.id)).toEqual([c.id]);
    const open = await api(sup).get('/complaints?status=OPEN&limit=100');
    expect(open.body.data.every((x: any) => !['CLOSED', 'DUPLICATE', 'REJECTED', 'CANCELLED'].includes(x.status))).toBe(true);
  });

  it('exports CSV with formula-injection protection, masking for management, and an audit entry', async () => {
    await register(sup, intake(L, { customerName: '=HYPERLINK("http://evil")', email: 'csv@example.com' }));
    const s = await api(sup).get('/complaints/export?q=csv@example.com');
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toMatch(/text\/csv/);
    expect(s.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(s.text).toContain('csv@example.com');
    expect((await api(tok.mgmt).get('/complaints/export')).text).toContain('(masked)');
    expect((await api(tok.engA).get('/complaints/export')).status).toBe(403);
    expect(await AuditLog.countDocuments({ action: 'export', entityType: 'complaint' })).toBeGreaterThanOrEqual(2);
  });

  it('edits intake details with an audited diff', async () => {
    const c = (await register(sup, intake(L))).body;
    const r = await api(sup).patch(`/complaints/${c.id}`).send({ description: 'Updated: RMU trips under load only.', reason: 'Clarified with caller' });
    expect(r.status).toBe(200);
    const e = await AuditLog.findOne({ entityId: c.id, action: 'update' }).lean();
    expect(e!.after).toEqual({ description: 'Updated: RMU trips under load only.' });
    expect(e!.reason).toBe('Clarified with caller');
  });
});
