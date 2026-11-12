import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  DEFAULT_SETTINGS,
  MASTER_KEYS,
  MASTER_RESOURCES,
  P,
  SYSTEM_ROLES,
  formatReference,
  isPermissionKey,
  masterSchemas,
  settingsSchemas,
  TIME_EVENT_TYPES,
  INSPECTION_RESULTS,
  password,
  phone,
} from './index';

describe('permission catalogue', () => {
  it('has unique keys', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });
  it('P helper resolves to catalogue keys', () => {
    expect(P.complaint.read).toBe('complaint.read');
    expect(isPermissionKey(P.inspection.approve)).toBe(true);
    expect(isPermissionKey('complaint.delete')).toBe(false);
  });
  it('system roles only reference known permissions', () => {
    for (const r of SYSTEM_ROLES) for (const p of r.permissions) expect(isPermissionKey(p)).toBe(true);
  });
  it('engineer cannot approve reports (BR-012 default)', () => {
    const eng = SYSTEM_ROLES.find((r) => r.key === 'ENGINEER')!;
    expect(eng.permissions).not.toContain('inspection.approve');
  });
  it('management viewer is read-only', () => {
    const m = SYSTEM_ROLES.find((r) => r.key === 'MANAGEMENT')!;
    const writes = m.permissions.filter((p) => !/\.(read|export|management)$/.test(p));
    expect(writes).toEqual([]);
  });
  it('public reporter is not assignable and has no permissions', () => {
    const pr = SYSTEM_ROLES.find((r) => r.key === 'PUBLIC_REPORTER')!;
    expect(pr.assignable).toBe(false);
    expect(pr.permissions).toEqual([]);
  });
});

describe('fixed vocabularies', () => {
  it('six time events in mandated order (BR-010)', () => {
    expect(TIME_EVENT_TYPES).toEqual(['START_TRAVEL', 'ARRIVE_SITE', 'START_WORK', 'END_WORK', 'START_RETURN', 'ARRIVE_BASE']);
  });
  it('four inspection results (BR-006)', () => {
    expect(INSPECTION_RESULTS).toEqual(['PASS', 'FAIL', 'NOT_CHECKED', 'NOT_APPLICABLE']);
  });
});

describe('settings', () => {
  it('defaults validate against their schemas', () => {
    for (const [group, schema] of Object.entries(settingsSchemas)) {
      expect(() => schema.parse(DEFAULT_SETTINGS[group as keyof typeof DEFAULT_SETTINGS])).not.toThrow();
    }
  });
  it('formats MV-YYYY-000001', () => {
    expect(formatReference(DEFAULT_SETTINGS.numbering.complaint, 2026, 1)).toBe('MV-2026-000001');
    expect(formatReference({ prefix: 'WO', padding: 5, resetYearly: false }, 2026, 42)).toBe('WO-00042');
  });
});

describe('masters', () => {
  it('every resource has a schema and its refs/fields are consistent', () => {
    for (const key of MASTER_KEYS) {
      const def = MASTER_RESOURCES[key];
      const shape = masterSchemas[key].shape;
      for (const f of def.fields) expect(Object.keys(shape)).toContain(f.name);
      for (const r of def.refs) expect(def.fields.find((f) => f.name === r.field)?.ref).toBe(r.ref);
    }
  });
  it('upper-cases codes and blanks optional strings', () => {
    const out = masterSchemas.regions.parse({ name: 'North', code: 'north-1', description: '' });
    expect(out.code).toBe('NORTH-1');
    expect(out.description).toBeUndefined();
  });
});

describe('validators', () => {
  it('password policy', () => {
    expect(password.safeParse('short').success).toBe(false);
    expect(password.safeParse('alllowercase123').success).toBe(false);
    expect(password.safeParse('Str0ngPassword!').success).toBe(true);
  });
  it('query booleans treat "false" as false', async () => {
    const { queryBool } = await import('./index');
    expect(queryBool.parse('false')).toBe(false);
    expect(queryBool.parse('true')).toBe(true);
    expect(queryBool.parse(undefined)).toBe(false);
  });
  it('phone numbers', () => {
    expect(phone.safeParse('+44 7700 900123').success).toBe(true);
    expect(phone.safeParse('12ab').success).toBe(false);
  });
});
