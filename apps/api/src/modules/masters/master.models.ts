import { Schema, type Model, type SchemaDefinition } from 'mongoose';
import { MASTER_STATUSES, type MasterKey } from '@mv/shared';
import { defineModel } from '../../db/model';

const ref = (model: string, required = false) => ({ type: Schema.Types.ObjectId, ref: model, required });
const str = (required = false) => ({ type: String, trim: true, required });
const CI = { locale: 'en', strength: 2 } as const;

/** Generic over the field definition so each master keeps its typed fields (no `any` at call sites). */
function masterSchema<T extends SchemaDefinition>(collection: string, fields: T) {
  const schema = new Schema(
    {
      ...fields,
      status: { type: String, enum: MASTER_STATUSES, default: 'ACTIVE' },
      deactivatedAt: Date,
      deactivationReason: String,
      createdBy: ref('User'),
      updatedBy: ref('User'),
    },
    { collection, timestamps: true, versionKey: false },
  );
  // Codes are unique case-insensitively (MD-01).
  schema.index({ code: 1 }, { unique: true, collation: CI });
  schema.index({ status: 1, name: 1 });
  return schema;
}

const organizationSchema = masterSchema('organizations', {
  name: str(true),
  code: str(true),
  type: { type: String, enum: ['CUSTOMER', 'INTERNAL', 'CONTRACTOR'], default: 'CUSTOMER' },
  contactName: str(),
  contactEmail: str(),
  contactPhone: str(),
  address: str(),
  notes: str(),
});

const regionSchema = masterSchema('regions', { name: str(true), code: str(true), description: str() });

const citySchema = masterSchema('cities', { name: str(true), code: str(true), regionId: ref('Region', true) });
citySchema.index({ regionId: 1, status: 1, name: 1 });

/** Sites carry a denormalised regionId (derived from city) so scope filters need no joins. */
const siteSchema = masterSchema('sites', {
  name: str(true),
  code: str(true),
  cityId: ref('City', true),
  regionId: ref('Region', true),
  organizationId: ref('Organization', true),
  address: str(),
  latitude: Number,
  longitude: Number,
  contactName: str(),
  contactPhone: str(),
});
siteSchema.index({ cityId: 1, status: 1, name: 1 });
siteSchema.index({ organizationId: 1, status: 1 });
siteSchema.index({ regionId: 1, status: 1 });

const equipmentTypeSchema = masterSchema('equipmentTypes', {
  name: str(true),
  code: str(true),
  description: str(),
  /** Populated in Phase 5 when checklist templates are introduced. */
  checklistTemplateIds: [ref('InspectionTemplate')],
});

/** Assets carry denormalised cityId/regionId/organizationId (derived from site). */
const assetSchema = masterSchema('assets', {
  name: str(true),
  code: str(true),
  siteId: ref('Site', true),
  cityId: ref('City', true),
  regionId: ref('Region', true),
  organizationId: ref('Organization', true),
  equipmentTypeId: ref('EquipmentType', true),
  manufacturer: str(),
  model: str(),
  serialNumber: str(),
  rating: str(),
  description: str(),
  /** Temporary assets recorded in the field await supervisor review (MD-08, Phase 5). */
  isTemporary: { type: Boolean, default: false },
});
assetSchema.index({ siteId: 1, status: 1, name: 1 });
assetSchema.index({ equipmentTypeId: 1 });

const requestTypeSchema = masterSchema('requestTypes', { name: str(true), code: str(true), description: str() });

const prioritySchema = masterSchema('priorities', {
  name: str(true),
  code: str(true),
  rank: { type: Number, required: true },
  tone: { type: String, enum: ['danger', 'warning', 'info', 'neutral'], default: 'info' },
  slaAcknowledgeHours: Number,
  slaAssignHours: Number,
  slaResolveHours: Number,
});
prioritySchema.index({ rank: 1 }, { unique: true });

const warehouseSchema = masterSchema('warehouses', {
  name: str(true),
  code: str(true),
  siteId: ref('Site'),
  address: str(),
});

const inventoryItemSchema = masterSchema('inventoryItems', {
  name: str(true),
  code: str(true),
  specification: str(),
  unit: str(true),
  category: str(),
  reorderLevel: Number,
});

export const Organization = defineModel('Organization', organizationSchema);
export const Region = defineModel('Region', regionSchema);
export const City = defineModel('City', citySchema);
export const Site = defineModel('Site', siteSchema);
export const EquipmentType = defineModel('EquipmentType', equipmentTypeSchema);
export const Asset = defineModel('Asset', assetSchema);
export const RequestType = defineModel('RequestType', requestTypeSchema);
export const Priority = defineModel('Priority', prioritySchema);
export const Warehouse = defineModel('Warehouse', warehouseSchema);
export const InventoryItem = defineModel('InventoryItem', inventoryItemSchema);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MASTER_MODELS: Record<MasterKey, Model<any>> = {
  organizations: Organization,
  regions: Region,
  cities: City,
  sites: Site,
  equipmentTypes: EquipmentType,
  assets: Asset,
  requestTypes: RequestType,
  priorities: Priority,
  warehouses: Warehouse,
  inventoryItems: InventoryItem,
};

/**
 * Children that reference each master (used to block deactivation of parents with active children
 * and to cascade denormalised fields). Transactional references are added in later phases.
 */
export const MASTER_CHILDREN: Partial<Record<MasterKey, { key: MasterKey; field: string }[]>> = {
  regions: [{ key: 'cities', field: 'regionId' }],
  cities: [{ key: 'sites', field: 'cityId' }],
  organizations: [{ key: 'sites', field: 'organizationId' }],
  sites: [
    { key: 'assets', field: 'siteId' },
    { key: 'warehouses', field: 'siteId' },
  ],
  equipmentTypes: [{ key: 'assets', field: 'equipmentTypeId' }],
};
