import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/core/audit/audit.model';
import { Asset, Site } from '../src/modules/masters/master.models';
import { ADMIN_EMAIL, api, bootstrap, login } from './helpers';

let token: string;
const ids: Record<string, string> = {};

async function create(resource: string, body: Record<string, unknown>) {
  const r = await api(token).post(`/masters/${resource}`).send(body);
  if (r.status !== 201) throw new Error(`${resource}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

beforeAll(async () => {
  await bootstrap();
  token = (await login(ADMIN_EMAIL)).token;
  ids.region = (await create('regions', { name: 'North', code: 'n1' })).id;
  ids.region2 = (await create('regions', { name: 'South', code: 's1' })).id;
  ids.city = (await create('cities', { name: 'Northfield', code: 'NF', regionId: ids.region })).id;
  ids.city2 = (await create('cities', { name: 'Southport', code: 'SP', regionId: ids.region2 })).id;
  ids.org = (await create('organizations', { name: 'Acme', code: 'ACME' })).id;
  ids.eq = (await create('equipmentTypes', { name: 'Ring Main Unit', code: 'RMU' })).id;
  ids.site = (await create('sites', { name: 'Substation 1', code: 'SS1', cityId: ids.city, organizationId: ids.org })).id;
  ids.asset = (await create('assets', { name: 'RMU 1', code: 'A1', siteId: ids.site, equipmentTypeId: ids.eq })).id;
});

describe('MD-01 hierarchy and validation', () => {
  it('upper-cases codes and derives denormalised location fields', async () => {
    const region = await api(token).get(`/masters/regions/${ids.region}`);
    expect(region.body.code).toBe('N1');
    const site = await Site.findById(ids.site).lean<Record<string, any>>();
    expect(String(site!.regionId)).toBe(ids.region);
    const asset = await Asset.findById(ids.asset).lean<Record<string, any>>();
    expect(String(asset!.regionId)).toBe(ids.region);
    expect(String(asset!.organizationId)).toBe(ids.org);
    expect(String(asset!.cityId)).toBe(ids.city);
  });

  it('ignores client-supplied derived fields', async () => {
    const r = await api(token)
      .post('/masters/sites')
      .send({ name: 'Spoof', code: 'SPOOF', cityId: ids.city, organizationId: ids.org, regionId: ids.region2 });
    expect(r.status).toBe(201);
    expect(r.body.regionId).toBe(ids.region);
  });

  it('rejects duplicate codes case-insensitively with 409', async () => {
    const r = await api(token).post('/masters/regions').send({ name: 'Dup', code: 'N1' });
    expect(r.status).toBe(409);
    expect(r.body.error.fields.code).toBeTruthy();
    const r2 = await api(token).post('/masters/regions').send({ name: 'Dup', code: 'n1' });
    expect(r2.status).toBe(409);
  });

  it('validates required fields and references', async () => {
    const missing = await api(token).post('/masters/cities').send({ name: '', code: 'X' });
    expect(missing.status).toBe(400);
    expect(Object.keys(missing.body.error.fields)).toEqual(expect.arrayContaining(['name', 'regionId']));
    const badRef = await api(token).post('/masters/cities').send({ name: 'Ghost', code: 'GH', regionId: '0123456789abcdef01234567' });
    expect(badRef.status).toBe(400);
    expect(badRef.body.error.fields.regionId).toMatch(/not found/);
  });

  it('lists with search, parent filter and ref labels', async () => {
    const r = await api(token).get(`/masters/cities?parentField=regionId&parentId=${ids.region}`);
    expect(r.status).toBe(200);
    expect(r.body.data.map((c: any) => c.code)).toEqual(['NF']);
    expect(r.body.data[0]._refs.regionId).toBe('North (N1)');
    const q = await api(token).get('/masters/sites?q=substation');
    expect(q.body.meta.total).toBe(1);
    const opts = await api(token).get(`/masters/sites/options?parentField=cityId&parentId=${ids.city}`);
    expect(opts.body[0]).toMatchObject({ label: expect.any(String), cityId: ids.city, regionId: ids.region });
  });

  it('rejects filtering by a non-relationship field', async () => {
    const r = await api(token).get(`/masters/cities?parentField=name&parentId=${ids.region}`);
    expect(r.status).toBe(400);
  });
});

describe('MD-06 / BR-018 deactivation instead of deletion', () => {
  it('blocks deactivating a parent with active children, and audits status changes', async () => {
    const r = await api(token).post(`/masters/regions/${ids.region}/deactivate`).send({ reason: 'Reorganisation' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('HAS_ACTIVE_CHILDREN');

    const eq2 = await create('equipmentTypes', { name: 'Unused', code: 'UNUSED' });
    const d = await api(token).post(`/masters/equipmentTypes/${eq2.id}/deactivate`).send({ reason: 'Not used' });
    expect(d.status).toBe(200);
    expect(d.body.status).toBe('INACTIVE');
    expect(await AuditLog.countDocuments({ entityType: 'equipmentTypes', action: 'deactivate', reason: 'Not used' })).toBe(1);

    // Inactive parents cannot be referenced by new records.
    const r2 = await api(token).post('/masters/assets').send({ name: 'X', code: 'AX', siteId: ids.site, equipmentTypeId: eq2.id });
    expect(r2.status).toBe(400);
    expect(r2.body.error.fields.equipmentTypeId).toMatch(/inactive/);
  });

  it('requires a reason to deactivate, and there is no DELETE endpoint', async () => {
    const r = await api(token).post(`/masters/equipmentTypes/${ids.eq}/deactivate`).send({});
    expect(r.status).toBe(400);
    const del = await api(token).delete(`/masters/regions/${ids.region}`);
    expect(del.status).toBe(404);
  });
});

describe('cascading denormalised fields', () => {
  it('moving a city to another region updates its sites and assets', async () => {
    const r = await api(token).patch(`/masters/cities/${ids.city}`).send({ regionId: ids.region2 });
    expect(r.status).toBe(200);
    expect(String((await Site.findById(ids.site).lean<Record<string, any>>())!.regionId)).toBe(ids.region2);
    expect(String((await Asset.findById(ids.asset).lean<Record<string, any>>())!.regionId)).toBe(ids.region2);
    const audit = await AuditLog.findOne({ entityType: 'cities', action: 'update', entityId: ids.city }).lean();
    expect(audit!.after).toEqual({ regionId: ids.region2 });
    await api(token).patch(`/masters/cities/${ids.city}`).send({ regionId: ids.region });
  });

  it('clears optional fields sent as empty strings', async () => {
    await api(token).patch(`/masters/sites/${ids.site}`).send({ address: '1 High St' });
    const r = await api(token).patch(`/masters/sites/${ids.site}`).send({ address: '' });
    expect(r.body.address).toBeUndefined();
  });
});

describe('MD-07 bulk import', () => {
  async function workbook(rows: string[][]) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Cities');
    ws.addRow(['Name', 'Code', 'Region code']);
    rows.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('serves templates', async () => {
    const x = await api(token).get('/masters/cities/import-template?format=xlsx');
    expect(x.status).toBe(200);
    expect(x.headers['content-type']).toMatch(/spreadsheetml/);
    const c = await api(token).get('/masters/cities/import-template?format=csv');
    expect(c.text.trim()).toBe('Name,Code,Region code');
  });

  it('validates per row on dry run and refuses to commit when there are errors', async () => {
    const file = await workbook([
      ['Hillcrest', 'HC', 'N1'],
      ['Nowhere', 'NW', 'ZZZ'],
      ['', 'EMPTY', 'N1'],
      ['Twice', 'HC', 'N1'],
    ]);
    const r = await api(token).post('/masters/cities/import?dryRun=true').attach('file', file, 'cities.xlsx');
    expect(r.status).toBe(200);
    expect(r.body.summary).toMatchObject({ totalRows: 4, toCreate: 1, errors: 3 });
    expect(r.body.results[1].errors['Region code']).toMatch(/No region/);
    const commit = await api(token).post('/masters/cities/import?dryRun=false').attach('file', file, 'cities.xlsx');
    expect(commit.body.committed).toBe(false);
  });

  it('creates and updates by code in one all-or-nothing transaction', async () => {
    const file = await workbook([
      ['Hillcrest', 'HC', 'N1'],
      ['Northfield (renamed)', 'NF', 'N1'],
    ]);
    const r = await api(token).post('/masters/cities/import?dryRun=false').attach('file', file, 'cities.xlsx');
    expect(r.body).toMatchObject({ committed: true, summary: { toCreate: 1, toUpdate: 1, errors: 0 } });
    const nf = await api(token).get(`/masters/cities/${ids.city}`);
    expect(nf.body.name).toBe('Northfield (renamed)');
    expect(await AuditLog.countDocuments({ action: 'master.import', entityType: 'cities' })).toBe(1);
  });

  it('rejects non-spreadsheet uploads', async () => {
    const r = await api(token).post('/masters/cities/import').attach('file', Buffer.from('MZ'), 'evil.exe');
    expect(r.status).toBe(400);
  });
});

describe('organizations alias route', () => {
  it('serves /organizations as /masters/organizations', async () => {
    const r = await api(token).get('/organizations');
    expect(r.status).toBe(200);
    expect(r.body.data.some((o: any) => o.code === 'ACME')).toBe(true);
  });
});
