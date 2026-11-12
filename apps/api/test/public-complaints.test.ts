import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/core/audit/audit.model';
import { capturedMail } from '../src/core/mail/mail.service';
import { Notification } from '../src/core/notifications/notification.model';
import { updateSettingsGroup, getSettingsGroup } from '../src/core/settings/settings.service';
import { Attachment } from '../src/core/storage/attachment.model';
import { Complaint } from '../src/modules/complaints/complaint.model';
import { issueFormToken } from '../src/modules/complaints/public.routes';
import { City } from '../src/modules/masters/master.models';
import { User } from '../src/modules/users/user.model';
import { NOT_A_PNG, PDF, PNG, publicPayload, seedLocations, type Locations } from './fixtures';
import { ADMIN_EMAIL, bootstrap, getApp } from './helpers';

let L: Locations;
const key = () => `k${Math.random().toString(36).slice(2)}${Date.now().toString(36)}xx`;

function submit(data: Record<string, unknown>, opts: { key?: string; files?: { buf: Buffer; name: string }[] } = {}) {
  let r = request(getApp()).post('/api/v1/public/complaints').field('data', JSON.stringify(data));
  if (opts.key) r = r.set('Idempotency-Key', opts.key);
  for (const f of opts.files ?? []) r = r.attach('files', f.buf, f.name);
  return r;
}

beforeAll(async () => {
  await bootstrap();
  L = await seedLocations();
});

describe('PUB form bootstrap and cascading options', () => {
  it('serves a form token, privacy notice and attachment policy without login', async () => {
    const r = await request(getApp()).get('/api/v1/public/complaint-form');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ privacyNoticeVersion: '1.0', attachments: { maxFileSizeMb: 10 }, captchaSiteKey: null });
    expect(r.body.formToken).toMatch(/^\d+\.[a-f0-9]+\..+$/);
  });

  it('cascades active cities by region and hides inactive records', async () => {
    const inactive = await City.create({ name: 'Old City', code: 'OLD', regionId: L.A.region._id, status: 'INACTIVE' });
    const r = await request(getApp()).get(`/api/v1/public/options/cities?parentField=regionId&parentId=${L.A.region._id}`);
    expect(r.status).toBe(200);
    expect(r.body.map((c: any) => c.code)).toEqual(['CITY-A']);
    expect(r.body.some((c: any) => c.id === String(inactive._id))).toBe(false);
    const assets = await request(getApp()).get(`/api/v1/public/options/assets?parentField=siteId&parentId=${L.A.site._id}`);
    expect(assets.body[0]).toMatchObject({ code: 'AST-A1', equipmentTypeId: String(L.eq._id) });
  });

  it('does not expose other master data publicly', async () => {
    expect((await request(getApp()).get('/api/v1/public/options/organizations')).status).toBe(400);
    expect((await request(getApp()).get('/api/v1/public/options/warehouses')).status).toBe(400);
  });
});

describe('PUB-01/07/09 successful submission', () => {
  it('creates one complaint with an atomic reference, stores the attachment, acknowledges by email and alerts reviewers', async () => {
    const mailBefore = capturedMail().length;
    const r = await submit(publicPayload(L), { key: key(), files: [{ buf: PNG, name: 'photo.PNG' }, { buf: PDF, name: 'report.pdf' }] });
    expect(r.status).toBe(201);
    expect(r.body.referenceNo).toMatch(new RegExp(`^MV-${new Date().getUTCFullYear()}-\\d{6}$`));

    const c = await Complaint.findOne({ referenceNo: r.body.referenceNo }).lean();
    expect(c).toMatchObject({ source: 'PUBLIC_FORM', status: 'NEW', email: 'jane@example.com' });
    expect(String(c!.organizationId)).toBe(String(L.A.org._id)); // derived from the site, not the client
    expect(String(c!.equipmentTypeId)).toBe(String(L.eq._id)); // auto-filled from the asset
    expect(c!.snapshot).toMatchObject({ siteName: 'Site A', regionName: 'Region A', assetName: 'RMU A1' });
    expect(c!.consent).toMatchObject({ accepted: true, version: '1.0' });

    const files = await Attachment.find({ ownerId: c!._id }).lean();
    expect(files.map((f) => [f.originalName, f.mimeType]).sort()).toEqual([
      ['photo.PNG', 'image/png'],
      ['report.pdf', 'application/pdf'],
    ]);
    expect(files.every((f) => f.uploaderType === 'PUBLIC')).toBe(true);

    const mail = capturedMail().slice(mailBefore).find((m) => m.to === 'jane@example.com');
    expect(mail?.subject).toContain(r.body.referenceNo);
    expect(mail?.text).not.toMatch(/internal/i);

    const admin = await User.findOne({ email: ADMIN_EMAIL }).lean();
    expect(await Notification.countDocuments({ recipientId: admin!._id, type: 'complaint.submitted', entityId: c!._id })).toBe(1);
    expect(await AuditLog.countDocuments({ entityType: 'complaint', entityId: c!._id, action: 'create' })).toBe(1);
  });

  it('accepts a submission without asset or attachments', async () => {
    const { assetId: _a, ...noAsset } = publicPayload(L, { email: 'noasset@example.com' });
    const r = await submit(noAsset);
    expect(r.status).toBe(201);
  });
});

describe('PUB-03 / PUB-02 validation', () => {
  it('rejects invalid email, phone and short description with field errors', async () => {
    const r = await submit(publicPayload(L, { email: 'not-an-email', mobile: '12', description: 'short' }));
    expect(r.status).toBe(400);
    expect(Object.keys(r.body.error.fields)).toEqual(expect.arrayContaining(['email', 'mobile', 'description']));
  });

  it('requires privacy consent', async () => {
    const r = await submit(publicPayload(L, { consentAccepted: false }));
    expect(r.status).toBe(400);
    expect(r.body.error.fields.consentAccepted).toBeTruthy();
  });

  it('re-validates the Region › City › Site › Asset chain server-side', async () => {
    const wrongCity = await submit(publicPayload(L, { cityId: String(L.B.city._id) }));
    expect(wrongCity.status).toBe(400);
    expect(wrongCity.body.error.fields.cityId).toMatch(/not in the selected region/);
    const wrongAsset = await submit(publicPayload(L, { assetId: String(L.assetB._id) }));
    expect(wrongAsset.status).toBe(400);
    expect(wrongAsset.body.error.fields.assetId).toMatch(/not at the selected site/);
    const wrongEq = await submit(publicPayload(L, { equipmentTypeId: String(L.eq2._id) }));
    expect(wrongEq.body.error.fields.equipmentTypeId).toMatch(/does not match/);
  });

  it('rejects an outdated privacy notice version', async () => {
    const r = await submit(publicPayload(L, { consentVersion: '0.9' }));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CONSENT_OUTDATED');
  });
});

describe('PUB-05 anti-spam and idempotency', () => {
  it('rejects a filled honeypot field', async () => {
    const r = await submit(publicPayload(L, { website: 'http://spam.example' }));
    expect(r.status).toBe(400);
  });

  it('rejects forms submitted faster than the minimum fill time, and forged tokens', async () => {
    const fast = await submit(publicPayload(L, { formToken: issueFormToken(Date.now()) }));
    expect(fast.status).toBe(400);
    expect(fast.body.error.code).toBe('FORM_TOKEN_INVALID');
    const forged = await submit(publicPayload(L, { formToken: `${Date.now() - 60000}.abcdef.forgedsignature` }));
    expect(forged.status).toBe(400);
  });

  it('a retried submission with the same Idempotency-Key returns the same reference and creates nothing new', async () => {
    const k = key();
    const data = publicPayload(L, { email: 'retry@example.com' });
    const a = await submit(data, { key: k, files: [{ buf: PNG, name: 'a.png' }] });
    const b = await submit({ ...data, formToken: publicPayload(L).formToken }, { key: k, files: [{ buf: PNG, name: 'a.png' }] });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.referenceNo).toBe(a.body.referenceNo);
    expect(await Complaint.countDocuments({ email: 'retry@example.com' })).toBe(1);
    const different = await submit(publicPayload(L, { email: 'other@example.com' }), { key: k });
    expect(different.status).toBe(422);
    expect(different.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('warns the same reporter about their own recent complaint for the same site only', async () => {
    const first = await submit(publicPayload(L, { email: 'dup@example.com' }), { key: key() });
    const again = await submit(publicPayload(L, { email: 'dup@example.com', description: 'Still tripping after the reset this afternoon.' }), { key: key() });
    expect(again.body.possibleDuplicateOf).toBe(first.body.referenceNo);
    const stranger = await submit(publicPayload(L, { email: 'stranger@example.com' }), { key: key() });
    expect(stranger.body.possibleDuplicateOf).toBeUndefined();
  });

  it('returns 404 when the public form is disabled', async () => {
    const s = await getSettingsGroup('publicForm');
    await updateSettingsGroup({}, 'publicForm', { ...s, enabled: false });
    try {
      expect((await request(getApp()).get('/api/v1/public/complaint-form')).status).toBe(404);
      expect((await submit(publicPayload(L))).status).toBe(404);
    } finally {
      await updateSettingsGroup({}, 'publicForm', { ...s, enabled: true });
    }
  });
});

describe('SEC-05 upload security', () => {
  it('rejects content that does not match its extension (spoofed image)', async () => {
    const before = await Complaint.countDocuments();
    const r = await submit(publicPayload(L, { email: 'spoof@example.com' }), { files: [{ buf: NOT_A_PNG, name: 'photo.png' }] });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/does not match/);
    expect(await Complaint.countDocuments()).toBe(before); // nothing created
  });

  it('rejects disallowed extensions and path tricks', async () => {
    const exe = await submit(publicPayload(L), { files: [{ buf: Buffer.from('MZ\x90\x00'), name: 'invoice.exe' }] });
    expect(exe.status).toBe(400);
    const html = await submit(publicPayload(L), { files: [{ buf: Buffer.from('<html></html>'), name: 'page.html' }] });
    expect(html.status).toBe(400);
  });

  it('enforces per-record file count and per-file size from configuration', async () => {
    const s = await getSettingsGroup('attachments');
    await updateSettingsGroup({}, 'attachments', { ...s, maxFilesPerRecord: 1, maxFileSizeMb: 1 });
    try {
      const two = await submit(publicPayload(L), { files: [{ buf: PNG, name: 'a.png' }, { buf: PNG, name: 'b.png' }] });
      expect(two.status).toBe(400);
      expect(two.body.error.message).toMatch(/At most 1 file/);
      const big = Buffer.concat([PDF, Buffer.alloc(1.5 * 1024 * 1024, 0x20)]);
      const tooBig = await submit(publicPayload(L), { files: [{ buf: big, name: 'big.pdf' }] });
      expect(tooBig.status).toBe(400);
      expect(tooBig.body.error.message).toMatch(/larger than 1 MB/);
    } finally {
      await updateSettingsGroup({}, 'attachments', s);
    }
  });

  it('sanitises file names', async () => {
    const r = await submit(publicPayload(L, { email: 'names@example.com' }), { key: key(), files: [{ buf: PNG, name: '..\\..\\evil<script>.png' }] });
    expect(r.status).toBe(201);
    const c = await Complaint.findOne({ referenceNo: r.body.referenceNo }).lean();
    const a = await Attachment.findOne({ ownerId: c!._id }).lean();
    expect(a!.originalName).toBe('evil_script_.png');
  });
});
