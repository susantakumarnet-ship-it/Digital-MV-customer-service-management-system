import { Asset, City, EquipmentType, Organization, Priority, Region, RequestType, Site } from '../src/modules/masters/master.models';
import { issueFormToken } from '../src/modules/complaints/public.routes';

type Doc = Record<string, any>;

/** Builds two independent location hierarchies (A and B) for scope tests. */
export async function seedLocations() {
  const mk = async (tag: string) => {
    const org = await Organization.create({ name: `Customer ${tag}`, code: `ORG-${tag}`, type: 'CUSTOMER' });
    const region = await Region.create({ name: `Region ${tag}`, code: `REG-${tag}` });
    const city = await City.create({ name: `City ${tag}`, code: `CITY-${tag}`, regionId: region._id });
    const site = await Site.create({ name: `Site ${tag}`, code: `SITE-${tag}`, cityId: city._id, regionId: region._id, organizationId: org._id });
    return { org, region, city, site };
  };
  const A = await mk('A');
  const B = await mk('B');
  const eq = await EquipmentType.create({ name: 'Ring Main Unit', code: 'RMU' });
  const eq2 = await EquipmentType.create({ name: 'Transformer', code: 'TRF' });
  const asset = await Asset.create({
    name: 'RMU A1', code: 'AST-A1', siteId: A.site._id, cityId: A.city._id, regionId: A.region._id, organizationId: A.org._id, equipmentTypeId: eq._id,
  });
  const assetB = await Asset.create({
    name: 'TRF B1', code: 'AST-B1', siteId: B.site._id, cityId: B.city._id, regionId: B.region._id, organizationId: B.org._id, equipmentTypeId: eq2._id,
  });
  const requestType = await RequestType.create({ name: 'Breakdown', code: 'BRK' });
  const p1 = await Priority.create({ name: 'Critical', code: 'P1', rank: 1, tone: 'danger', slaAcknowledgeHours: 2, slaAssignHours: 4, slaResolveHours: 24 });
  const p3 = await Priority.create({ name: 'Medium', code: 'P3', rank: 3, tone: 'info', slaResolveHours: 168 });
  return { A, B, eq, eq2, asset, assetB, requestType, p1, p3 };
}
export type Locations = Awaited<ReturnType<typeof seedLocations>>;

export function intake(L: Locations, overrides: Doc = {}) {
  return {
    customerName: 'Jane Reporter',
    organizationName: 'Acme',
    contactPerson: 'Jane',
    mobile: '+44 7700 900123',
    email: 'jane@example.com',
    regionId: String(L.A.region._id),
    cityId: String(L.A.city._id),
    siteId: String(L.A.site._id),
    assetId: String(L.asset._id),
    requestTypeId: String(L.requestType._id),
    description: 'The RMU is tripping repeatedly since this morning.',
    ...overrides,
  };
}

/** A form token issued long enough ago to pass the minimum fill time. */
export function agedFormToken() {
  return issueFormToken(Date.now() - 60_000);
}

export function publicPayload(L: Locations, overrides: Doc = {}) {
  return { ...intake(L), consentAccepted: true, consentVersion: '1.0', formToken: agedFormToken(), website: '', ...overrides };
}

// Minimal valid file bodies (magic bytes are what the server checks).
export const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a9f6e0f00000000049454e44ae426082',
  'hex',
);
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
export const NOT_A_PNG = Buffer.from('<script>alert(1)</script> definitely not an image');
