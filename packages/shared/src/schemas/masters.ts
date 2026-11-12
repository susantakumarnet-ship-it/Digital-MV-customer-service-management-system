import { z } from 'zod';
import { code, email, objectId, queryBool } from './common';

/**
 * Master-data resource registry (BRF §6C, HO §4.9). One definition drives:
 *  - backend validation + generic CRUD routes (/api/v1/masters/:resource)
 *  - admin UI list columns and forms
 *  - bulk import column mapping
 * Records are never hard-deleted (BR-018) — only activated/deactivated.
 */

export const MASTER_KEYS = [
  'organizations',
  'regions',
  'cities',
  'sites',
  'equipmentTypes',
  'assets',
  'requestTypes',
  'priorities',
  'warehouses',
  'inventoryItems',
] as const;
export type MasterKey = (typeof MASTER_KEYS)[number];

export type MasterFieldKind = 'text' | 'textarea' | 'number' | 'email' | 'phone' | 'ref' | 'select' | 'color';

export interface MasterField {
  name: string;
  label: string;
  kind: MasterFieldKind;
  required?: boolean;
  ref?: MasterKey;
  options?: { value: string; label: string }[];
  /** Show as a column in list view. */
  column?: boolean;
  help?: string;
  /** For cascading selects in forms: only show ref options whose `filterField` equals this form field's value. */
  dependsOn?: { field: string; filterField: string };
}

const opt = (s: z.ZodTypeAny) => s.optional().or(z.literal('')).transform((v) => (v === '' ? undefined : v));
const optText = (max = 200) => opt(z.string().trim().max(max));
const optNum = (min = 0, max = 1_000_000) =>
  z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z.number({ invalid_type_error: 'Must be a number' }).min(min).max(max).optional(),
  );
const optLat = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
  z.number().min(-90).max(90).optional(),
);
const optLng = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
  z.number().min(-180).max(180).optional(),
);
const name = z.string().trim().min(1, 'Name is required').max(150);

export const ORGANIZATION_TYPES = [
  { value: 'CUSTOMER', label: 'Customer' },
  { value: 'INTERNAL', label: 'Internal / Service provider' },
  { value: 'CONTRACTOR', label: 'Contractor' },
];

export const PRIORITY_TONES = [
  { value: 'danger', label: 'Red (critical)' },
  { value: 'warning', label: 'Amber (high)' },
  { value: 'info', label: 'Blue (medium)' },
  { value: 'neutral', label: 'Grey (low)' },
];

export const masterSchemas = {
  organizations: z.object({
    name,
    code,
    type: z.enum(['CUSTOMER', 'INTERNAL', 'CONTRACTOR']).default('CUSTOMER'),
    contactName: optText(120),
    contactEmail: opt(email),
    contactPhone: optText(25),
    address: optText(500),
    notes: optText(1000),
  }),
  regions: z.object({ name, code, description: optText(500) }),
  cities: z.object({ name, code, regionId: objectId }),
  sites: z.object({
    name,
    code,
    cityId: objectId,
    organizationId: objectId,
    address: optText(500),
    latitude: optLat,
    longitude: optLng,
    contactName: optText(120),
    contactPhone: optText(25),
  }),
  equipmentTypes: z.object({ name, code, description: optText(500) }),
  assets: z.object({
    name,
    code,
    siteId: objectId,
    equipmentTypeId: objectId,
    manufacturer: optText(120),
    model: optText(120),
    serialNumber: optText(120),
    rating: optText(120),
    description: optText(1000),
  }),
  requestTypes: z.object({ name, code, description: optText(500) }),
  priorities: z.object({
    name,
    code,
    rank: z.coerce.number().int().min(1).max(99),
    tone: z.enum(['danger', 'warning', 'info', 'neutral']).default('info'),
    slaAcknowledgeHours: optNum(0, 8760),
    slaAssignHours: optNum(0, 8760),
    slaResolveHours: optNum(0, 8760),
  }),
  warehouses: z.object({ name, code, siteId: opt(objectId), address: optText(500) }),
  inventoryItems: z.object({
    name,
    code,
    specification: optText(1000),
    unit: z.string().trim().min(1, 'Unit is required').max(20),
    category: optText(120),
    reorderLevel: optNum(0, 1_000_000_000),
  }),
} satisfies Record<MasterKey, z.ZodObject<z.ZodRawShape>>;

export interface MasterResourceDef {
  key: MasterKey;
  label: string;
  singular: string;
  /** Field shown as the record's display name in dropdowns. */
  display: string;
  fields: MasterField[];
  /** Fields that must be unique (case-insensitive for strings). */
  unique: string[];
  /** Ref fields that must point to ACTIVE records when creating/updating. */
  refs: { field: string; ref: MasterKey }[];
  /** Phase the resource is first used in a workflow (informational). */
  group: 'Customers & locations' | 'Assets' | 'Service' | 'Store';
}

export const MASTER_RESOURCES: Record<MasterKey, MasterResourceDef> = {
  organizations: {
    key: 'organizations',
    label: 'Organizations',
    singular: 'Organization',
    display: 'name',
    group: 'Customers & locations',
    unique: ['code'],
    refs: [],
    fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true, column: true },
      { name: 'code', label: 'Code', kind: 'text', required: true, column: true },
      { name: 'type', label: 'Type', kind: 'select', options: ORGANIZATION_TYPES, required: true, column: true },
      { name: 'contactName', label: 'Contact person', kind: 'text', column: true },
      { name: 'contactEmail', label: 'Contact email', kind: 'email' },
      { name: 'contactPhone', label: 'Contact phone', kind: 'phone' },
      { name: 'address', label: 'Address', kind: 'textarea' },
      { name: 'notes', label: 'Notes', kind: 'textarea' },
    ],
  },
  regions: {
    key: 'regions',
    label: 'Regions',
    singular: 'Region',
    display: 'name',
    group: 'Customers & locations',
    unique: ['code'],
    refs: [],
    fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true, column: true },
      { name: 'code', label: 'Code', kind: 'text', required: true, column: true },
      { name: 'description', label: 'Description', kind: 'textarea' },
    ],
  },
  cities: {
    key: 'cities',
    label: 'Cities',
    singular: 'City',
    display: 'name',
    group: 'Customers & locations',
    unique: ['code'],
    refs: [{ field: 'regionId', ref: 'regions' }],
    fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true, column: true },
      { name: 'code', label: 'Code', kind: 'text', required: true, column: true },
      { name: 'regionId', label: 'Region', kind: 'ref', ref: 'regions', required: true, column: true },
    ],
  },
  sites: {
    key: 'sites',
    label: 'Sites',
    singular: 'Site',
    display: 'name',
    group: 'Customers & locations',
    unique: ['code'],
    refs: [
      { field: 'cityId', ref: 'cities' },
      { field: 'organizationId', ref: 'organizations' },
    ],
    fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true, column: true },
      { name: 'code', label: 'Site code', kind: 'text', required: true, column: true },
      { name: 'cityId', label: 'City', kind: 'ref', ref: 'cities', required: true, column: true },
      { name: 'organizationId', label: 'Customer organization', kind: 'ref', ref: 'organizations', required: true, column: true },
      { name: 'address', label: 'Address', kind: 'textarea' },
      { name: 'latitude', label: 'Latitude', kind: 'number', help: 'Optional, decimal degrees' },
      { name: 'longitude', label: 'Longitude', kind: 'number', help: 'Optional, decimal degrees' },
      { name: 'contactName', label: 'Site contact', kind: 'text' },
      { name: 'contactPhone', label: 'Site contact phone', kind: 'phone' },
    ],
  },
  equipmentTypes: {
    key: 'equipmentTypes',
    label: 'Equipment types',
    singular: 'Equipment type',
    display: 'name',
    group: 'Assets',
    unique: ['code'],
    refs: [],
    fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true, column: true },
      { name: 'code', label: 'Code', kind: 'text', required: true, column: true },
      { name: 'description', label: 'Description', kind: 'textarea', column: true },
    ],
  },
  assets: {
    key: 'assets',
    label: 'Assets',
    singular: 'Asset',
    display: 'name',
    group: 'Assets',
    unique: ['code'],
    refs: [
      { field: 'siteId', ref: 'sites' },
      { field: 'equipmentTypeId', ref: 'equipmentTypes' },
    ],
    fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true, column: true },
      { name: 'code', label: 'Asset code', kind: 'text', required: true, column: true },
      { name: 'siteId', label: 'Site', kind: 'ref', ref: 'sites', required: true, column: true },
      { name: 'equipmentTypeId', label: 'Equipment type', kind: 'ref', ref: 'equipmentTypes', required: true, column: true },
      { name: 'manufacturer', label: 'Manufacturer', kind: 'text' },
      { name: 'model', label: 'Model', kind: 'text' },
      { name: 'serialNumber', label: 'Serial number', kind: 'text', column: true },
      { name: 'rating', label: 'Rating / specification', kind: 'text' },
      { name: 'description', label: 'Description', kind: 'textarea' },
    ],
  },
  requestTypes: {
    key: 'requestTypes',
    label: 'Request types',
    singular: 'Request type',
    display: 'name',
    group: 'Service',
    unique: ['code'],
    refs: [],
    fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true, column: true },
      { name: 'code', label: 'Code', kind: 'text', required: true, column: true },
      { name: 'description', label: 'Description', kind: 'textarea', column: true },
    ],
  },
  priorities: {
    key: 'priorities',
    label: 'Priorities & SLA',
    singular: 'Priority',
    display: 'name',
    group: 'Service',
    unique: ['code', 'rank'],
    refs: [],
    fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true, column: true },
      { name: 'code', label: 'Code', kind: 'text', required: true, column: true },
      { name: 'rank', label: 'Rank (1 = most urgent)', kind: 'number', required: true, column: true },
      { name: 'tone', label: 'Badge colour', kind: 'select', options: PRIORITY_TONES, required: true },
      { name: 'slaAcknowledgeHours', label: 'SLA: acknowledge (hours)', kind: 'number', column: true },
      { name: 'slaAssignHours', label: 'SLA: assign (hours)', kind: 'number', column: true },
      { name: 'slaResolveHours', label: 'SLA: resolve (hours)', kind: 'number', column: true },
    ],
  },
  warehouses: {
    key: 'warehouses',
    label: 'Warehouses',
    singular: 'Warehouse',
    display: 'name',
    group: 'Store',
    unique: ['code'],
    refs: [{ field: 'siteId', ref: 'sites' }],
    fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true, column: true },
      { name: 'code', label: 'Code', kind: 'text', required: true, column: true },
      { name: 'siteId', label: 'Located at site (optional)', kind: 'ref', ref: 'sites', column: true },
      { name: 'address', label: 'Address', kind: 'textarea' },
    ],
  },
  inventoryItems: {
    key: 'inventoryItems',
    label: 'Material catalogue',
    singular: 'Material item',
    display: 'name',
    group: 'Store',
    unique: ['code'],
    refs: [],
    fields: [
      { name: 'name', label: 'Material name', kind: 'text', required: true, column: true },
      { name: 'code', label: 'Item code', kind: 'text', required: true, column: true },
      { name: 'unit', label: 'Unit', kind: 'text', required: true, column: true, help: 'e.g. EA, M, KG, L, SET' },
      { name: 'category', label: 'Category', kind: 'text', column: true },
      { name: 'specification', label: 'Specification', kind: 'textarea' },
      { name: 'reorderLevel', label: 'Reorder level', kind: 'number' },
    ],
  },
};

export const masterListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().trim().max(60).optional(),
  q: z.string().trim().max(120).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ALL'),
  /** Filter by a parent ref, e.g. ?regionId=… for cities. Validated against the resource's refs. */
  parentField: z.string().max(40).optional(),
  parentId: objectId.optional(),
});

export const masterOptionsQuery = z.object({
  parentField: z.string().max(40).optional(),
  parentId: objectId.optional(),
  includeInactive: queryBool,
});
