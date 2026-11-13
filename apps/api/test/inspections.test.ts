import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/core/audit/audit.model';
import { Notification } from '../src/core/notifications/notification.model';
import { Complaint } from '../src/modules/complaints/complaint.model';
import { InspectionReport } from '../src/modules/inspections/inspection.models';
import { Asset } from '../src/modules/masters/master.models';
import { WorkOrder } from '../src/modules/work-orders/work-order.model';
import { acceptedWorkOrder, newVisit, recordUpTo } from './field-fixtures';
import { PDF, PNG, seedLocations, type Locations } from './fixtures';
import { ADMIN_EMAIL, api, bootstrap, createUser, getApp, login } from './helpers';

let L: Locations;
let admin: string;
let sup: string;
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};

const ITEMS = [
  { key: 'VIS', section: 'General', description: 'Visual condition of enclosure', required: true, evidence: 'PHOTO' },
  { key: 'IR', section: 'Tests', description: 'Insulation resistance test', required: true, evidence: 'DOCUMENT', evidenceOnFail: true },
  { key: 'SF6', section: 'Tests', description: 'SF6 gas pressure', required: true, evidence: 'NONE', naReasonRequired: true },
  { key: 'LBL', section: 'General', description: 'Labels and signage', required: false, evidence: 'NONE' },
];

function upload(token: string, reportId: string, itemKey: string, buf: Buffer, name: string) {
  return request(getApp())
    .post(`/api/v1/inspection-reports/${reportId}/attachments`)
    .set('Authorization', `Bearer ${token}`)
    .field('data', JSON.stringify({ itemKey }))
    .attach('files', buf, name);
}

beforeAll(async () => {
  await bootstrap();
  L = await seedLocations();
  admin = (await login(ADMIN_EMAIL)).token;
  await createUser({ email: 'isup@test.local', roleKeys: ['SUPERVISOR'], scope: { global: true } });
  await createUser({ email: 'irev@test.local', roleKeys: ['REVIEWER'], scope: { global: true } });
  for (const k of ['i1', 'i2', 'iB']) {
    const u = await createUser({ email: `${k}@test.local`, roleKeys: ['ENGINEER'], scope: { regionIds: [String(k === 'iB' ? L.B.region._id : L.A.region._id)] } });
    ids[k] = String(u._id);
  }
  sup = (await login('isup@test.local')).token;
  for (const k of ['i1', 'i2', 'iB']) tok[k] = (await login(`${k}@test.local`)).token;
});

describe('INSP-01 versioned checklist templates', () => {
  let v1: any;
  it('creates, edits and publishes a draft; only admins manage templates', async () => {
    expect((await api(sup).post('/inspections/templates').send({ name: 'x', equipmentTypeId: String(L.eq._id), items: ITEMS })).status).toBe(403);
    const dupKeys = await api(admin).post('/inspections/templates').send({ name: 'RMU inspection', equipmentTypeId: String(L.eq._id), items: [ITEMS[0], ITEMS[0]] });
    expect(dupKeys.status).toBe(400);
    const d = await api(admin).post('/inspections/templates').send({ name: 'RMU inspection', equipmentTypeId: String(L.eq._id), items: ITEMS.slice(0, 3) });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ version: 1, status: 'DRAFT', equipmentType: { name: 'Ring Main Unit' } });
    const edited = await api(admin).put(`/inspections/templates/${d.body.id}`).send({ name: 'RMU inspection', equipmentTypeId: String(L.eq._id), items: ITEMS });
    expect(edited.body.items).toHaveLength(4);
    v1 = (await api(admin).post(`/inspections/templates/${d.body.id}/publish`)).body;
    expect(v1.status).toBe('ACTIVE');
    expect((await api(admin).put(`/inspections/templates/${v1.id}`).send({ name: 'Changed', equipmentTypeId: String(L.eq._id), items: ITEMS })).body.error.code).toBe('TEMPLATE_LOCKED');
  });

  it('a new version retires the previous one on publish', async () => {
    const v2 = (await api(admin).post(`/inspections/templates/${v1.id}/new-version`)).body;
    expect(v2).toMatchObject({ version: 2, status: 'DRAFT' });
    expect((await api(admin).post(`/inspections/templates/${v1.id}/new-version`)).body.error.code).toBe('DRAFT_EXISTS');
    // Keep v2 as draft for now (published later to prove report snapshots don't change).
    const list = await api(admin).get(`/inspections/templates?equipmentTypeId=${L.eq._id}`);
    expect(list.body.data.map((t: any) => [t.version, t.status])).toEqual([
      [2, 'DRAFT'],
      [1, 'ACTIVE'],
    ]);
  });
});

describe('INSP-02..07 inspection report lifecycle', () => {
  let wo: Awaited<ReturnType<typeof acceptedWorkOrder>>;
  let visitId: string;
  let report: any;

  beforeAll(async () => {
    wo = await acceptedWorkOrder(L, sup, [ids.i1, ids.i2], [tok.i1]);
    // Work order inherits the complaint asset (RMU A1).
    visitId = (await newVisit(tok.i1, wo.workOrderId)).id;
  });

  it('creates revision 1 from the ACTIVE template for the asset\'s equipment type (snapshot)', async () => {
    const r = await api(tok.i1).post(`/visits/${visitId}/inspection-reports`).send({});
    expect(r.status).toBe(201);
    report = r.body;
    expect(report).toMatchObject({ revisionNo: 1, status: 'DRAFT', locked: false, template: { name: 'RMU inspection', version: 1 }, asset: { code: 'AST-A1' } });
    expect(report.items.map((i: any) => i.key)).toEqual(['VIS', 'IR', 'SF6', 'LBL']);
    expect(report.summary).toMatchObject({ total: 4, unanswered: 4 });
    // Creating again returns the same report.
    expect((await api(tok.i1).post(`/visits/${visitId}/inspection-reports`).send({})).body.id).toBe(report.id);
    // Supervisors cannot author reports; other regions cannot see them.
    expect((await api(sup).post(`/visits/${visitId}/inspection-reports`).send({})).status).toBe(403);
    expect((await api(tok.iB).get(`/inspection-reports/${report.id}`)).status).toBe(404);
  });

  it('later template versions do not change an existing report', async () => {
    const draft = (await api(admin).get(`/inspections/templates?equipmentTypeId=${L.eq._id}&status=DRAFT`)).body.data[0];
    await api(admin).put(`/inspections/templates/${draft.id}`).send({ name: 'RMU inspection', equipmentTypeId: String(L.eq._id), items: [...ITEMS, { key: 'NEW', description: 'New check added in v2', required: true, evidence: 'NONE' }] });
    await api(admin).post(`/inspections/templates/${draft.id}/publish`);
    const r = await api(tok.i1).get(`/inspection-reports/${report.id}`);
    expect(r.body.template.version).toBe(1);
    expect(r.body.items.map((i: any) => i.key)).not.toContain('NEW');
  });

  it('BR-007/008: reports issues for missing results, reasons, evidence and time events', async () => {
    let r = (await api(tok.i1).put(`/inspection-reports/${report.id}`).send({ results: [{ itemKey: 'VIS', result: 'PASS' }, { itemKey: 'IR', result: 'NOT_CHECKED' }, { itemKey: 'SF6', result: 'NOT_APPLICABLE' }] })).body;
    expect(r.items.find((i: any) => i.key === 'VIS').issues).toEqual(['A photo is required as evidence']);
    expect(r.items.find((i: any) => i.key === 'IR').issues).toEqual(['Not Checked requires a reason']);
    expect(r.items.find((i: any) => i.key === 'SF6').issues).toEqual(['Not Applicable requires a reason for this item']);
    expect(r.items.find((i: any) => i.key === 'LBL').issues).toEqual([]); // optional
    expect(r.submissionIssues.some((i: string) => i.startsWith('Record your time events'))).toBe(true);
    expect(r.permissions.canSubmit).toBe(false);
    const submit = await api(tok.i1).post(`/inspection-reports/${report.id}/submit`);
    expect(submit.status).toBe(409);
    expect(submit.body.error.code).toBe('WORKFLOW_CONDITIONS_NOT_MET');
    expect(submit.body.error.message).toMatch(/incomplete/);
    // Unknown item keys are rejected.
    expect((await api(tok.i1).put(`/inspection-reports/${report.id}`).send({ results: [{ itemKey: 'NOPE', result: 'PASS' }] })).status).toBe(400);
    // A FAIL on an item with evidenceOnFail needs evidence.
    r = (await api(tok.i1).put(`/inspection-reports/${report.id}`).send({ results: [{ itemKey: 'IR', result: 'FAIL' }] })).body;
    expect(r.items.find((i: any) => i.key === 'IR').issues).toEqual(['A document is required as evidence']);
  });

  it('accepts item evidence with the right type, then submits once everything is complete', async () => {
    const wrongType = await upload(tok.i1, report.id, 'VIS', PDF, 'enclosure.pdf'); // PDF is not a photo
    expect(wrongType.status).toBe(200);
    expect(wrongType.body.items.find((i: any) => i.key === 'VIS').issues).toEqual(['A photo is required as evidence']);
    await upload(tok.i1, report.id, 'VIS', PNG, 'enclosure.png');
    await upload(tok.i1, report.id, 'IR', PDF, 'ir-test.pdf');
    let r = (await api(tok.i1).put(`/inspection-reports/${report.id}`).send({
      results: [
        { itemKey: 'IR', result: 'FAIL', remarks: 'Phase B 2 MΩ' },
        { itemKey: 'SF6', result: 'NOT_APPLICABLE', reason: 'Air-insulated unit' },
      ],
      findings: 'Low IR on phase B',
      recommendations: 'Replace cable termination',
    })).body;
    expect(r.items.every((i: any) => i.issues.length === 0)).toBe(true);
    expect(r.submissionIssues).toEqual(['Record your time events first: ARRIVE_SITE, START_WORK, END_WORK']);

    await recordUpTo(tok.i1, visitId, 'END_WORK');
    r = (await api(tok.i1).get(`/inspection-reports/${report.id}`)).body;
    expect(r.submissionIssues).toEqual([]);
    expect(r.permissions.canSubmit).toBe(true);
    expect(r.summary).toMatchObject({ pass: 1, fail: 1, notApplicable: 1, unanswered: 1 });

    const s = await api(tok.i1).post(`/inspection-reports/${report.id}/submit`);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ status: 'SUBMITTED', locked: true, submittedByName: 'i1' });
    expect((await WorkOrder.findById(wo.workOrderId).lean())!.status).toBe('SUBMITTED');
    expect((await Complaint.findById(wo.complaintId).lean())!.status).toBe('SUBMITTED_FOR_REVIEW');
    expect(await Notification.countDocuments({ type: 'inspectionReport.submitted', entityId: report.id })).toBeGreaterThanOrEqual(1);
    expect(await AuditLog.countDocuments({ action: 'inspectionReport.submit', entityId: report.id })).toBe(1);
  });

  it('BR-009: a submitted revision is immutable at the API, document and query level', async () => {
    const put = await api(tok.i1).put(`/inspection-reports/${report.id}`).send({ results: [{ itemKey: 'LBL', result: 'PASS' }] });
    expect(put.body.error.code).toBe('REPORT_LOCKED');
    expect((await upload(tok.i1, report.id, 'LBL', PNG, 'late.png')).body.error.code).toBe('REPORT_LOCKED');
    expect((await api(tok.i1).post(`/inspection-reports/${report.id}/submit`)).status).toBe(409);
    const doc = await InspectionReport.findById(report.id);
    doc!.findings = 'tampered';
    await expect(doc!.save()).rejects.toThrow(/immutable/);
    await expect(InspectionReport.updateOne({ _id: report.id }, { $set: { findings: 'tampered' } })).rejects.toThrow(/service/);
    await expect(InspectionReport.deleteOne({ _id: report.id })).rejects.toThrow(/cannot be deleted/);
    expect((await InspectionReport.findById(report.id).lean())!.findings).toBe('Low IR on phase B');
  });

  it('only the visit engineers may author; co-engineer who did not record time is blocked by D-33', async () => {
    const wo2 = await acceptedWorkOrder(L, sup, [ids.i1, ids.i2], [tok.i1, tok.i2]);
    const v2 = (await newVisit(tok.i1, wo2.workOrderId, { engineerIds: [ids.i1, ids.i2] })).id;
    const r2 = (await api(tok.i2).post(`/visits/${v2}/inspection-reports`).send({})).body;
    expect(r2.submissionIssues).toContain('Record your time events first: ARRIVE_SITE, START_WORK, END_WORK');
  });

  it('serves evidence to authorised users via signed URLs', async () => {
    const r = (await api(sup).get(`/inspection-reports/${report.id}`)).body;
    const fileId = r.items.find((i: any) => i.key === 'VIS').attachments.find((a: any) => a.mimeType === 'image/png').id;
    const u = await api(sup).get(`/files/${fileId}/url?inline=true`);
    expect(u.status).toBe(200);
    expect((await request(getApp()).get(u.body.url)).headers['content-disposition']).toMatch(/^inline/);
    expect((await api(tok.iB).get(`/files/${fileId}/url`)).status).toBe(404);
  });

  it('refuses to start a report when no active template exists', async () => {
    const wo3 = await acceptedWorkOrder(L, sup, [ids.i1], [tok.i1]);
    const v3 = (await newVisit(tok.i1, wo3.workOrderId)).id;
    // Asset of another equipment type (Transformer) with no template, at the same site.
    const trf = await Asset.create({ name: 'TRF A9', code: 'AST-A9', siteId: L.A.site._id, cityId: L.A.city._id, regionId: L.A.region._id, organizationId: L.A.org._id, equipmentTypeId: L.eq2._id });
    const r = await api(tok.i1).post(`/visits/${v3}/inspection-reports`).send({ assetId: String(trf._id) });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('NO_TEMPLATE');
    const otherSite = await api(tok.i1).post(`/visits/${v3}/inspection-reports`).send({ assetId: String(L.assetB._id) });
    expect(otherSite.status).toBe(400);
  });
});

describe('MD-08 temporary assets', () => {
  it('engineers record a temporary asset on site; supervisors approve or reject it', async () => {
    const wo = await acceptedWorkOrder(L, sup, [ids.i1], [tok.i1]);
    const v = (await newVisit(tok.i1, wo.workOrderId)).id;
    const a = await api(tok.i1).post(`/visits/${v}/temporary-assets`).send({ name: 'Unlabelled RMU', equipmentTypeId: String(L.eq._id), serialNumber: 'X-77' });
    expect(a.status).toBe(201);
    expect(a.body.code).toMatch(/^TMP-\d{4}-\d{5}$/);
    const pending = await api(sup).get('/inspections/temporary-assets');
    expect(pending.body.map((x: any) => x.code)).toContain(a.body.code);
    expect((await api(tok.i1).get('/inspections/temporary-assets')).status).toBe(403);
    // Usable immediately in an inspection report.
    const r = await api(tok.i1).post(`/visits/${v}/inspection-reports`).send({ assetId: a.body.id });
    expect(r.body.asset.code).toBe(a.body.code);
    const noComment = await api(sup).post(`/inspections/temporary-assets/${a.body.id}/review`).send({ decision: 'REJECT' });
    expect(noComment.status).toBe(400);
    const ok = await api(sup).post(`/inspections/temporary-assets/${a.body.id}/review`).send({ decision: 'APPROVE', code: 'AST-A1-RMU2' });
    expect(ok.body).toMatchObject({ code: 'AST-A1-RMU2', isTemporary: false, status: 'ACTIVE' });
    expect((await api(sup).get('/inspections/temporary-assets')).body.map((x: any) => x.id)).not.toContain(a.body.id);
  });
});
