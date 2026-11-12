import { hashPassword } from '../../common/crypto';
import {
  Asset,
  City,
  EquipmentType,
  InventoryItem,
  Organization,
  Priority,
  Region,
  RequestType,
  Site,
  Warehouse,
} from '../../modules/masters/master.models';
import { Role } from '../../modules/roles/role.model';
import { User } from '../../modules/users/user.model';

type Log = (msg: string) => void;
type Doc = Record<string, any>;

/**
 * Demonstration data for development and UAT walk-throughs only (DB-06). Clearly fictional.
 * Real master data is loaded via the bulk import (D-05). Refused when NODE_ENV=production.
 */
async function upsert(model: any, code: string, data: Doc): Promise<Doc> {
  const existing = await model.findOne({ code }).lean();
  if (existing) return existing;
  const [doc] = await model.create([{ code, ...data }]);
  return doc.toObject();
}

export async function seedDemo(log: Log, demoPassword: string) {
  log('Demo master data…');
  const regions: Record<string, Doc> = {};
  for (const [code, name] of [
    ['NTH', 'North Region'],
    ['CEN', 'Central Region'],
    ['STH', 'South Region'],
  ])
    regions[code] = await upsert(Region, code, { name });

  const cities: Record<string, Doc> = {};
  for (const [code, name, r] of [
    ['NTH-C1', 'Northfield', 'NTH'],
    ['NTH-C2', 'Hillcrest', 'NTH'],
    ['CEN-C1', 'Midvale', 'CEN'],
    ['CEN-C2', 'Riverton', 'CEN'],
    ['STH-C1', 'Southport', 'STH'],
    ['STH-C2', 'Baymouth', 'STH'],
  ])
    cities[code] = await upsert(City, code, { name, regionId: regions[r]._id });

  const orgs: Record<string, Doc> = {};
  for (const [code, name, type] of [
    ['DMV', 'Digital MV Services (internal)', 'INTERNAL'],
    ['ACME-UTIL', 'Acme Utilities Ltd (demo)', 'CUSTOMER'],
    ['NOVA-IND', 'Nova Industrial Park (demo)', 'CUSTOMER'],
    ['CITY-HOSP', 'City General Hospital (demo)', 'CUSTOMER'],
  ])
    orgs[code] = await upsert(Organization, code, { name, type, contactName: 'Demo Contact', contactEmail: `${code.toLowerCase()}@example.com` });

  const sites: Record<string, Doc> = {};
  for (const [code, name, city, org] of [
    ['SITE-NF-01', 'Northfield Primary Substation', 'NTH-C1', 'ACME-UTIL'],
    ['SITE-HC-01', 'Hillcrest Water Works', 'NTH-C2', 'ACME-UTIL'],
    ['SITE-MV-01', 'Midvale Industrial Estate', 'CEN-C1', 'NOVA-IND'],
    ['SITE-RT-01', 'Riverton Logistics Hub', 'CEN-C2', 'NOVA-IND'],
    ['SITE-SP-01', 'Southport Hospital Campus', 'STH-C1', 'CITY-HOSP'],
    ['SITE-BM-01', 'Baymouth Clinic', 'STH-C2', 'CITY-HOSP'],
  ]) {
    const c = cities[city];
    sites[code] = await upsert(Site, code, { name, cityId: c._id, regionId: c.regionId, organizationId: orgs[org]._id });
  }

  const eq: Record<string, Doc> = {};
  for (const [code, name] of [
    ['RMU', 'Ring Main Unit'],
    ['SWGR', 'MV Switchgear'],
    ['TRF', 'Distribution Transformer'],
    ['CBL', 'MV Cable & Termination'],
    ['RLY', 'Protection Relay'],
  ])
    eq[code] = await upsert(EquipmentType, code, { name });

  let n = 0;
  for (const [siteCode, site] of Object.entries(sites)) {
    for (const [eqCode, label] of [
      ['RMU', 'RMU'],
      ['TRF', 'Transformer'],
    ]) {
      n++;
      const code = `AST-${siteCode.slice(5)}-${eqCode}`;
      await upsert(Asset, code, {
        name: `${label} ${siteCode.slice(5)}`,
        siteId: site._id,
        cityId: site.cityId,
        regionId: site.regionId,
        organizationId: site.organizationId,
        equipmentTypeId: eq[eqCode]._id,
        manufacturer: 'Demo Manufacturer',
        serialNumber: `SN-${String(n).padStart(5, '0')}`,
        rating: eqCode === 'TRF' ? '11/0.415 kV, 1000 kVA' : '11 kV, 630 A',
      });
    }
  }

  for (const [code, name] of [
    ['BRK', 'Breakdown / Fault'],
    ['PM', 'Preventive Maintenance'],
    ['INSP', 'Inspection Request'],
    ['COMM', 'Installation / Commissioning'],
    ['WAR', 'Warranty Claim'],
  ])
    await upsert(RequestType, code, { name });

  for (const [code, name, rank, tone, a, s, r] of [
    ['P1', 'Critical', 1, 'danger', 4, 8, 24],
    ['P2', 'High', 2, 'warning', 8, 24, 72],
    ['P3', 'Medium', 3, 'info', 24, 48, 168],
    ['P4', 'Low', 4, 'neutral', 48, 72, 336],
  ] as const)
    await upsert(Priority, code, { name, rank, tone, slaAcknowledgeHours: a, slaAssignHours: s, slaResolveHours: r });

  await upsert(Warehouse, 'WH-CEN', { name: 'Central Store', siteId: sites['SITE-MV-01']._id });
  await upsert(Warehouse, 'WH-NTH', { name: 'North Store' });

  for (const [code, name, unit, category] of [
    ['MAT-FUSE-63', 'HRC Fuse 63A 12kV', 'EA', 'Fuses'],
    ['MAT-TERM-95', 'Heat-shrink termination kit 95mm²', 'SET', 'Cable accessories'],
    ['MAT-OIL-TR', 'Transformer insulating oil', 'L', 'Consumables'],
    ['MAT-SF6-01', 'SF6 gas cylinder', 'EA', 'Consumables'],
    ['MAT-RLY-PCB', 'Protection relay CPU board', 'EA', 'Spares'],
    ['MAT-CBL-95', 'MV cable 95mm² 3-core', 'M', 'Cable'],
  ])
    await upsert(InventoryItem, code, { name, unit, category });

  log('Demo complaints…');
  const { Complaint } = await import('../../modules/complaints/complaint.model');
  const { createComplaint } = await import('../../modules/complaints/complaint.service');
  if (!(await Complaint.exists({}))) {
    const reqTypes = await RequestType.find({}).lean<Doc[]>();
    const samples: [string, string, string, string][] = [
      ['SITE-NF-01', 'BRK', 'Ring main unit trips repeatedly under load since this morning.', 'Northfield Utilities Control Room'],
      ['SITE-MV-01', 'INSP', 'Request inspection of transformer after visible oil seepage near the radiator.', 'Midvale Estate Facilities'],
      ['SITE-SP-01', 'BRK', 'Loss of supply to Block C. Protection relay shows earth fault alarm.', 'Southport Hospital Estates'],
      ['SITE-RT-01', 'PM', 'Annual preventive maintenance due for MV switchgear panel 2.', 'Riverton Hub Operations'],
      ['SITE-HC-01', 'WAR', 'New RMU installed last month shows intermittent SF6 low-pressure alarm.', 'Hillcrest Water Works'],
    ];
    for (const [siteCode, rt, description, customerName] of samples) {
      const site = sites[siteCode];
      const asset = await Asset.findOne({ siteId: site._id }).lean<Doc>();
      await createComplaint(
        { requestId: 'seed', ip: '127.0.0.1' },
        {
          customerName,
          organizationName: customerName,
          contactPerson: 'Duty Engineer',
          mobile: '+44 7700 900000',
          email: `${siteCode.toLowerCase()}@example.com`,
          regionId: String(site.regionId),
          cityId: String(site.cityId),
          siteId: String(site._id),
          assetId: asset ? String(asset._id) : undefined,
          requestTypeId: String(reqTypes.find((x) => x.code === rt)!._id),
          description,
        },
        { source: 'PUBLIC_FORM', consent: { accepted: true, version: '1.0' } },
      );
    }
    log(`  + ${samples.length} complaints`);
  }

  log('Demo users…');
  const roleByKey = new Map((await Role.find({ isSystem: true }).lean()).map((r) => [r.key, r._id]));
  const hash = await hashPassword(demoPassword);
  const users: [string, string, string, Doc][] = [
    ['supervisor@example.com', 'Sam Supervisor', 'SUPERVISOR', { global: true }],
    ['engineer1@example.com', 'Eli Engineer', 'ENGINEER', { regionIds: [regions.NTH._id, regions.CEN._id] }],
    ['engineer2@example.com', 'Erin Engineer', 'ENGINEER', { regionIds: [regions.STH._id] }],
    ['reviewer@example.com', 'Riley Reviewer', 'REVIEWER', { global: true }],
    ['storekeeper@example.com', 'Stacy Storekeeper', 'STOREKEEPER', { global: true }],
    ['management@example.com', 'Morgan Manager', 'MANAGEMENT', { global: true }],
    ['customer@example.com', 'Casey Customer (Acme)', 'CUSTOMER', { organizationIds: [orgs['ACME-UTIL']._id] }],
  ];
  for (const [email, name, role, scope] of users) {
    if (await User.exists({ email })) continue;
    await User.create({
      email,
      name,
      passwordHash: hash,
      roleIds: [roleByKey.get(role)],
      organizationId: role === 'CUSTOMER' ? orgs['ACME-UTIL']._id : orgs.DMV._id,
      scope: { global: false, organizationIds: [], regionIds: [], siteIds: [], ...scope },
      status: 'ACTIVE',
      mustChangePassword: false,
    });
    log(`  + ${email} (${role})`);
  }
}
