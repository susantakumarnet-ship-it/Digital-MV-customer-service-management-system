import type { ClientSession } from 'mongoose';
import { validationFailed } from '../../common/errors';
import { Asset, City, EquipmentType, Organization, Priority, Region, RequestType, Site } from '../masters/master.models';

type Doc = Record<string, any>;

export interface LocationInput {
  regionId: string;
  cityId: string;
  siteId: string;
  assetId?: string | null;
  equipmentTypeId?: string | null;
  requestTypeId?: string;
  suggestedPriorityId?: string;
}

export interface ResolvedLocation {
  organizationId: unknown;
  regionId: unknown;
  cityId: unknown;
  siteId: unknown;
  assetId?: unknown;
  equipmentTypeId?: unknown;
  requestTypeId?: unknown;
  suggestedPriorityId?: unknown;
  snapshot: Record<string, string | undefined>;
}

/**
 * Validates the Region › City › Site › Asset › Equipment chain server-side (PUB-02, HO §4.1):
 * every record must exist, be ACTIVE and belong to its parent. Client dropdowns are never trusted.
 */
export async function resolveLocation(input: LocationInput, session?: ClientSession): Promise<ResolvedLocation> {
  const s = session ?? null;
  const fields: Record<string, string> = {};
  const active = (d: Doc | null, label: string, field: string) => {
    if (!d) fields[field] = `${label} not found`;
    else if (d.status !== 'ACTIVE') fields[field] = `${label} "${d.name}" is not available`;
    return d && d.status === 'ACTIVE' ? d : null;
  };

  const [region, city, site] = await Promise.all([
    Region.findById(input.regionId).session(s).lean<Doc>(),
    City.findById(input.cityId).session(s).lean<Doc>(),
    Site.findById(input.siteId).session(s).lean<Doc>(),
  ]);
  const r = active(region, 'Region', 'regionId');
  const c = active(city, 'City', 'cityId');
  const st = active(site, 'Site', 'siteId');
  if (r && c && String(c.regionId) !== String(r._id)) fields.cityId = 'The selected city is not in the selected region';
  if (c && st && String(st.cityId) !== String(c._id)) fields.siteId = 'The selected site is not in the selected city';

  let asset: Doc | null = null;
  if (input.assetId) {
    asset = active(await Asset.findById(input.assetId).session(s).lean<Doc>(), 'Asset', 'assetId');
    if (asset && st && String(asset.siteId) !== String(st._id)) fields.assetId = 'The selected asset is not at the selected site';
  }
  let eq: Doc | null = null;
  const eqId = input.equipmentTypeId || asset?.equipmentTypeId;
  if (eqId) {
    eq = active(await EquipmentType.findById(eqId).session(s).lean<Doc>(), 'Equipment type', 'equipmentTypeId');
    if (eq && asset && String(asset.equipmentTypeId) !== String(eq._id)) {
      fields.equipmentTypeId = 'The equipment type does not match the selected asset';
    }
  }
  if (input.requestTypeId) {
    active(await RequestType.findById(input.requestTypeId).session(s).lean<Doc>(), 'Request type', 'requestTypeId');
  }
  if (input.suggestedPriorityId) {
    active(await Priority.findById(input.suggestedPriorityId).session(s).lean<Doc>(), 'Priority', 'suggestedPriorityId');
  }
  if (Object.keys(fields).length) throw validationFailed(fields);

  const org = await Organization.findById(st!.organizationId).session(s).lean<Doc>();
  return {
    organizationId: st!.organizationId,
    regionId: r!._id,
    cityId: c!._id,
    siteId: st!._id,
    assetId: asset?._id,
    equipmentTypeId: eq?._id,
    requestTypeId: input.requestTypeId,
    suggestedPriorityId: input.suggestedPriorityId,
    snapshot: {
      organizationName: org?.name,
      regionName: r!.name,
      cityName: c!.name,
      siteName: st!.name,
      siteCode: st!.code,
      assetName: asset?.name,
      assetCode: asset?.code,
      equipmentTypeName: eq?.name,
    },
  };
}
