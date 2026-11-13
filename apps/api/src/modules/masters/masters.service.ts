import ExcelJS from 'exceljs';
import { Types, type ClientSession } from 'mongoose';
import { z } from 'zod';
import { AUDIT_ACTIONS, MASTER_KEYS, MASTER_RESOURCES, masterSchemas, type MasterKey } from '@mv/shared';
import type { RequestContext } from '../../common/context';
import { escapeRegex } from '../../common/crypto';
import { badRequest, conflict, notFound, validationFailed } from '../../common/errors';
import { paged, parseSort } from '../../common/http/route';
import { audit, diff } from '../../core/audit/audit.service';
import { withTransaction } from '../../db/transaction';
import { MASTER_CHILDREN, MASTER_MODELS } from './master.models';

type Doc = Record<string, any>;

export function assertResource(key: string): MasterKey {
  if (!(MASTER_KEYS as readonly string[]).includes(key)) throw notFound('Master data type');
  return key as MasterKey;
}

const SORTABLE = ['name', 'code', 'status', 'createdAt', 'updatedAt', 'rank'];

/** Fields derived from parents and stored for scope filtering — never accepted from clients. */
const DERIVED: Partial<Record<MasterKey, string[]>> = {
  sites: ['regionId'],
  assets: ['cityId', 'regionId', 'organizationId'],
};

export function toDto(key: MasterKey, d: Doc, refLabels?: Record<string, string>) {
  const { _id, createdBy: _c, updatedBy: _u, checklistTemplateIds: _t, ...rest } = d;
  const out: Doc = { id: String(_id), ...rest };
  for (const [k, v] of Object.entries(out)) if (v instanceof Types.ObjectId) out[k] = String(v);
  if (refLabels) out._refs = refLabels;
  void key;
  return out;
}

/** Bulk-resolve ref ids → "Name (CODE)" labels for list/detail display. */
async function resolveRefLabels(key: MasterKey, docs: Doc[]) {
  const def = MASTER_RESOURCES[key];
  const labels = docs.map(() => ({}) as Record<string, string>);
  for (const r of def.refs) {
    const ids = [...new Set(docs.map((d) => d[r.field]).filter(Boolean).map(String))];
    if (!ids.length) continue;
    const refs = await MASTER_MODELS[r.ref].find({ _id: { $in: ids } }).select('name code status').lean<Doc[]>();
    const map = new Map(refs.map((x) => [String(x._id), `${x.name} (${x.code})${x.status === 'INACTIVE' ? ' — inactive' : ''}`]));
    docs.forEach((d, i) => {
      if (d[r.field]) labels[i][r.field] = map.get(String(d[r.field])) ?? 'Unknown';
    });
  }
  return labels;
}

export async function listMasters(
  key: MasterKey,
  q: { page: number; limit: number; sort?: string; q?: string; status: 'ACTIVE' | 'INACTIVE' | 'ALL'; parentField?: string; parentId?: string },
) {
  const Model = MASTER_MODELS[key];
  const def = MASTER_RESOURCES[key];
  const filter: Doc = {};
  if (q.status !== 'ALL') filter.status = q.status;
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ name: rx }, { code: rx }];
  }
  if (q.parentField && q.parentId) {
    if (!def.refs.some((r) => r.field === q.parentField) && !(DERIVED[key] ?? []).includes(q.parentField)) {
      throw badRequest(`Cannot filter ${key} by ${q.parentField}`);
    }
    filter[q.parentField] = new Types.ObjectId(q.parentId);
  }
  const sort = parseSort(q.sort, SORTABLE, key === 'priorities' ? { rank: 1 } : { name: 1 });
  const [rows, total] = await Promise.all([
    Model.find(filter).sort(sort).collation({ locale: 'en', strength: 2 }).skip((q.page - 1) * q.limit).limit(q.limit).lean<Doc[]>(),
    Model.countDocuments(filter),
  ]);
  const labels = await resolveRefLabels(key, rows);
  return paged(rows.map((r, i) => toDto(key, r, labels[i])), total, q.page, q.limit);
}

/** Lightweight dropdown options (ACTIVE only unless requested), with parent ids for cascading selects. */
export async function masterOptions(key: MasterKey, q: { parentField?: string; parentId?: string; includeInactive: boolean }) {
  const Model = MASTER_MODELS[key];
  const def = MASTER_RESOURCES[key];
  const filter: Doc = q.includeInactive ? {} : { status: 'ACTIVE' };
  if (q.parentField && q.parentId) {
    if (!def.refs.some((r) => r.field === q.parentField) && !(DERIVED[key] ?? []).includes(q.parentField)) {
      throw badRequest(`Cannot filter ${key} by ${q.parentField}`);
    }
    filter[q.parentField] = new Types.ObjectId(q.parentId);
  }
  const parentFields = [...def.refs.map((r) => r.field), ...(DERIVED[key] ?? [])];
  const rows = await Model.find(filter)
    .select(['name', 'code', 'status', ...parentFields, ...(key === 'inventoryItems' ? ['unit'] : [])].join(' '))
    .sort(key === 'priorities' ? { rank: 1 } : { name: 1 })
    .collation({ locale: 'en', strength: 2 })
    .limit(2000)
    .lean<Doc[]>();
  return rows.map((r) => {
    const o: Doc = { id: String(r._id), label: r.name, code: r.code, status: r.status };
    if (r.unit) o.unit = r.unit;
    for (const f of parentFields) if (r[f]) o[f] = String(r[f]);
    return o;
  });
}

export async function getMaster(key: MasterKey, id: string) {
  const doc = await MASTER_MODELS[key].findById(id).lean<Doc>();
  if (!doc) throw notFound(MASTER_RESOURCES[key].singular);
  const [labels] = await resolveRefLabels(key, [doc]);
  return toDto(key, doc, labels);
}

/** Ensures referenced parents exist and are ACTIVE, then computes denormalised fields. */
async function validateRefsAndDerive(key: MasterKey, data: Doc, session?: ClientSession) {
  const def = MASTER_RESOURCES[key];
  const fields: Record<string, string> = {};
  const loaded: Record<string, Doc> = {};
  for (const r of def.refs) {
    const v = data[r.field];
    if (v === undefined || v === null) continue;
    const parent = await MASTER_MODELS[r.ref].findById(v).session(session ?? null).lean<Doc>();
    if (!parent) fields[r.field] = `${MASTER_RESOURCES[r.ref].singular} not found`;
    else if (parent.status !== 'ACTIVE') fields[r.field] = `${MASTER_RESOURCES[r.ref].singular} "${parent.name}" is inactive`;
    else loaded[r.field] = parent;
  }
  if (Object.keys(fields).length) throw validationFailed(fields);

  if (key === 'sites' && loaded.cityId) data.regionId = loaded.cityId.regionId;
  if (key === 'assets' && loaded.siteId) {
    data.cityId = loaded.siteId.cityId;
    data.regionId = loaded.siteId.regionId;
    data.organizationId = loaded.siteId.organizationId;
  }
  return data;
}

/** Propagate denormalised fields to children after a parent's location changes. */
async function cascade(key: MasterKey, before: Doc, after: Doc, session: ClientSession) {
  const M = MASTER_MODELS;
  if (key === 'cities' && String(before.regionId) !== String(after.regionId)) {
    await M.sites.updateMany({ cityId: after._id }, { $set: { regionId: after.regionId } }, { session });
    await M.assets.updateMany({ cityId: after._id }, { $set: { regionId: after.regionId } }, { session });
  }
  if (
    key === 'sites' &&
    (String(before.cityId) !== String(after.cityId) || String(before.organizationId) !== String(after.organizationId))
  ) {
    await M.assets.updateMany(
      { siteId: after._id },
      { $set: { cityId: after.cityId, regionId: after.regionId, organizationId: after.organizationId } },
      { session },
    );
  }
}

function stripDerived(key: MasterKey, input: Doc) {
  const out = { ...input };
  for (const f of DERIVED[key] ?? []) delete out[f];
  return out;
}

export async function createMaster(ctx: RequestContext, key: MasterKey, input: unknown) {
  const parsed = masterSchemas[key].parse(stripDerived(key, (input ?? {}) as Doc)) as Doc;
  return withTransaction(async (session) => {
    const data = await validateRefsAndDerive(key, parsed, session);
    const [doc] = await MASTER_MODELS[key].create([{ ...data, createdBy: ctx.auth?.userId, updatedBy: ctx.auth?.userId }], { session });
    await audit(
      ctx,
      { action: AUDIT_ACTIONS.CREATE, entityType: key, entityId: doc._id, entityRef: `${doc.code} ${doc.name}`, after: doc.toObject() },
      session,
    );
    return toDto(key, doc.toObject());
  });
}

export async function updateMaster(ctx: RequestContext, key: MasterKey, id: string, input: unknown) {
  const schema = masterSchemas[key] as unknown as z.AnyZodObject;
  const parsed = schema.partial().parse(stripDerived(key, (input ?? {}) as Doc)) as Doc;
  // Optional fields sent as '' arrive as undefined → $unset them.
  const raw = (input ?? {}) as Doc;
  const unset: Record<string, 1> = {};
  for (const [k, v] of Object.entries(raw)) if ((v === '' || v === null) && k in schema.shape && parsed[k] === undefined) unset[k] = 1;
  for (const k of Object.keys(parsed)) if (parsed[k] === undefined) delete parsed[k];

  return withTransaction(async (session) => {
    const Model = MASTER_MODELS[key];
    const before = await Model.findById(id).session(session).lean<Doc>();
    if (!before) throw notFound(MASTER_RESOURCES[key].singular);
    const data = await validateRefsAndDerive(key, { ...parsed }, session);
    const after = await Model.findByIdAndUpdate(
      id,
      { $set: { ...data, updatedBy: ctx.auth?.userId }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { new: true, session, runValidators: true },
    ).lean<Doc>();
    await cascade(key, before, after!, session);
    const d = diff(before, after!);
    if (d.changed.length) {
      await audit(
        ctx,
        { action: AUDIT_ACTIONS.UPDATE, entityType: key, entityId: before._id, entityRef: `${after!.code} ${after!.name}`, before: d.before, after: d.after },
        session,
      );
    }
    return toDto(key, after!);
  });
}

export async function setMasterStatus(ctx: RequestContext, key: MasterKey, id: string, status: 'ACTIVE' | 'INACTIVE', reason?: string) {
  return withTransaction(async (session) => {
    const Model = MASTER_MODELS[key];
    const doc = await Model.findById(id).session(session).lean<Doc>();
    if (!doc) throw notFound(MASTER_RESOURCES[key].singular);
    if (doc.status === status) return toDto(key, doc);

    if (status === 'INACTIVE') {
      const blockers: string[] = [];
      for (const child of MASTER_CHILDREN[key] ?? []) {
        const n = await MASTER_MODELS[child.key].countDocuments({ [child.field]: doc._id, status: 'ACTIVE' }).session(session);
        if (n) blockers.push(`${n} active ${MASTER_RESOURCES[child.key].label.toLowerCase()}`);
      }
      if (blockers.length) {
        throw conflict(
          `Cannot deactivate "${doc.name}" while it has ${blockers.join(', ')}. Deactivate or move them first.`,
          'HAS_ACTIVE_CHILDREN',
        );
      }
    } else {
      // Re-activation requires active parents.
      await validateRefsAndDerive(key, Object.fromEntries(MASTER_RESOURCES[key].refs.map((r) => [r.field, doc[r.field]])), session);
    }

    const after = await Model.findByIdAndUpdate(
      id,
      status === 'INACTIVE'
        ? { $set: { status, deactivatedAt: new Date(), deactivationReason: reason, updatedBy: ctx.auth?.userId } }
        : { $set: { status, updatedBy: ctx.auth?.userId }, $unset: { deactivatedAt: 1, deactivationReason: 1 } },
      { new: true, session },
    ).lean<Doc>();
    await audit(
      ctx,
      {
        action: status === 'INACTIVE' ? AUDIT_ACTIONS.DEACTIVATE : AUDIT_ACTIONS.ACTIVATE,
        entityType: key,
        entityId: doc._id,
        entityRef: `${doc.code} ${doc.name}`,
        before: { status: doc.status },
        after: { status },
        reason,
      },
      session,
    );
    return toDto(key, after!);
  });
}

// ---- Bulk import (MD-07) -----------------------------------------------------------------------

const MAX_IMPORT_ROWS = 5000;

function importColumns(key: MasterKey) {
  return MASTER_RESOURCES[key].fields.map((f) => ({
    field: f.name,
    header: f.kind === 'ref' ? `${f.label} code` : f.label,
    ref: f.ref,
    required: Boolean(f.required),
    kind: f.kind,
    options: f.options,
  }));
}

export async function importTemplate(key: MasterKey, format: 'xlsx' | 'csv') {
  const cols = importColumns(key);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(MASTER_RESOURCES[key].label.slice(0, 31));
  ws.addRow(cols.map((c) => c.header));
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c) => (c.width = 24));
  if (format === 'csv') return Buffer.from(await wb.csv.writeBuffer());
  const notes = wb.addWorksheet('Instructions');
  notes.addRow(['Column', 'Required', 'Notes']);
  notes.getRow(1).font = { bold: true };
  for (const c of cols) {
    notes.addRow([
      c.header,
      c.required ? 'Yes' : 'No',
      c.ref
        ? `Code of an ACTIVE ${MASTER_RESOURCES[c.ref].singular.toLowerCase()}`
        : c.options
          ? `One of: ${c.options.map((o) => o.value).join(', ')}`
          : c.field === 'code'
            ? 'Unique. Existing codes are updated; new codes are created.'
            : '',
    ]);
  }
  notes.columns.forEach((c) => (c.width = 40));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function readSheet(buffer: Buffer, filename: string): Promise<{ headers: string[]; rows: string[][] }> {
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(filename)) {
    const { Readable } = await import('node:stream');
    await wb.csv.read(Readable.from(buffer));
  } else if (/\.xlsx$/i.test(filename)) {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } else {
    throw badRequest('Upload a .xlsx or .csv file');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw badRequest('The file has no worksheet');
  const cell = (v: ExcelJS.CellValue) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object' && 'text' in (v as object)) return String((v as { text: unknown }).text ?? '').trim();
    if (typeof v === 'object' && 'result' in (v as object)) return String((v as { result: unknown }).result ?? '').trim();
    return String(v).trim();
  };
  const all: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = (row.values as ExcelJS.CellValue[]).slice(1).map(cell);
    all.push(values);
  });
  const [headers = [], ...rows] = all;
  return { headers: headers.map((h) => h.trim()), rows: rows.filter((r) => r.some((c) => c !== '')) };
}

export interface ImportRowResult {
  row: number;
  code?: string;
  action: 'create' | 'update' | 'error';
  errors?: Record<string, string>;
}

export async function importMasters(ctx: RequestContext, key: MasterKey, buffer: Buffer, filename: string, dryRun: boolean) {
  const { headers, rows } = await readSheet(buffer, filename);
  if (rows.length > MAX_IMPORT_ROWS) throw badRequest(`A single import may contain at most ${MAX_IMPORT_ROWS} rows`);
  const cols = importColumns(key);
  const idx = new Map(headers.map((h, i) => [h.toLowerCase(), i]));
  const missing = cols.filter((c) => c.required && !idx.has(c.header.toLowerCase())).map((c) => c.header);
  if (missing.length) throw badRequest(`Missing required column(s): ${missing.join(', ')}. Download the template for the expected layout.`);

  // Pre-load ref lookups by code (case-insensitive).
  const refMaps: Record<string, Map<string, Doc>> = {};
  for (const c of cols.filter((c) => c.ref)) {
    const docs = await MASTER_MODELS[c.ref!].find({}).select('code name status').lean<Doc[]>();
    refMaps[c.field] = new Map(docs.map((d) => [String(d.code).toUpperCase(), d]));
  }
  const Model = MASTER_MODELS[key];
  const existing = new Map(
    (await Model.find({}).select('code').lean<Doc[]>()).map((d) => [String(d.code).toUpperCase(), d]),
  );

  const schema = masterSchemas[key] as unknown as z.AnyZodObject;
  const results: ImportRowResult[] = [];
  const valid: { data: Doc; existingId?: unknown }[] = [];
  const seenCodes = new Set<string>();

  rows.forEach((r, i) => {
    const rowNo = i + 2;
    const errors: Record<string, string> = {};
    const raw: Doc = {};
    for (const c of cols) {
      const j = idx.get(c.header.toLowerCase());
      const v = j === undefined ? '' : (r[j] ?? '');
      if (c.ref) {
        if (!v) continue;
        const ref = refMaps[c.field].get(v.toUpperCase());
        if (!ref) errors[c.header] = `No ${MASTER_RESOURCES[c.ref].singular.toLowerCase()} with code "${v}"`;
        else if (ref.status !== 'ACTIVE') errors[c.header] = `${MASTER_RESOURCES[c.ref].singular} "${v}" is inactive`;
        else raw[c.field] = String(ref._id);
      } else if (v !== '') raw[c.field] = v;
    }
    const code = String(raw.code ?? '').toUpperCase();
    if (code && seenCodes.has(code)) errors.Code = 'Duplicate code within the file';
    seenCodes.add(code);
    const exists = existing.get(code);
    const parsed = (exists ? schema.partial() : schema).safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const f = cols.find((c) => c.field === issue.path[0]);
        // Keep the more specific lookup error (e.g. unknown ref code) over a generic "Required".
        errors[f?.header ?? String(issue.path[0] ?? 'row')] ??= issue.message;
      }
    }
    if (Object.keys(errors).length) results.push({ row: rowNo, code, action: 'error', errors });
    else {
      results.push({ row: rowNo, code, action: exists ? 'update' : 'create' });
      valid.push({ data: parsed.data as Doc, existingId: exists?._id });
    }
  });

  const summary = {
    totalRows: rows.length,
    toCreate: results.filter((r) => r.action === 'create').length,
    toUpdate: results.filter((r) => r.action === 'update').length,
    errors: results.filter((r) => r.action === 'error').length,
  };
  if (dryRun || summary.errors) return { committed: false, dryRun, summary, results };

  // All-or-nothing commit.
  await withTransaction(async (session) => {
    for (const v of valid) {
      const data = await validateRefsAndDerive(key, { ...v.data }, session);
      if (v.existingId) {
        const before = await Model.findById(v.existingId).session(session).lean<Doc>();
        const after = await Model.findByIdAndUpdate(v.existingId, { $set: { ...data, updatedBy: ctx.auth?.userId } }, { new: true, session }).lean<Doc>();
        await cascade(key, before!, after!, session);
      } else {
        await Model.create([{ ...data, createdBy: ctx.auth?.userId, updatedBy: ctx.auth?.userId }], { session });
      }
    }
    await audit(ctx, { action: AUDIT_ACTIONS.IMPORT, entityType: key, meta: { filename, ...summary } }, session);
  });
  return { committed: true, dryRun: false, summary, results };
}
