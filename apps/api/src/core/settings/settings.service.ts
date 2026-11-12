import {
  DEFAULT_SETTINGS,
  SETTINGS_GROUPS,
  settingsSchemas,
  type Settings,
  type SettingsGroup,
} from '@mv/shared';
import type { RequestContext } from '../../common/context';
import { badRequest } from '../../common/errors';
import { withTransaction } from '../../db/transaction';
import { audit, diff } from '../audit/audit.service';
import { SystemSetting } from './settings.model';

/**
 * Settings are cached in-process for a short TTL. Multi-instance deployments see changes within
 * CACHE_MS; settings are low-frequency admin changes so this is acceptable.
 */
const CACHE_MS = 15_000;
let cache: { at: number; value: Settings } | undefined;

export function invalidateSettingsCache() {
  cache = undefined;
}

export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const docs = await SystemSetting.find({ key: { $in: SETTINGS_GROUPS } }).lean<{ key: string; value: unknown }[]>();
  const value = structuredClone(DEFAULT_SETTINGS) as Settings;
  for (const d of docs) {
    const group = d.key as SettingsGroup;
    // Merge stored value over defaults so new settings keys added in later releases get defaults.
    const merged = { ...(DEFAULT_SETTINGS[group] as object), ...(d.value as object) };
    const parsed = settingsSchemas[group].safeParse(merged);
    if (parsed.success) (value as Record<string, unknown>)[group] = parsed.data;
  }
  cache = { at: Date.now(), value };
  return value;
}

export async function getSettingsGroup<G extends SettingsGroup>(group: G): Promise<Settings[G]> {
  return (await getSettings())[group];
}

export async function updateSettingsGroup<G extends SettingsGroup>(
  ctx: RequestContext,
  group: G,
  input: unknown,
  reason?: string,
): Promise<Settings[G]> {
  if (!SETTINGS_GROUPS.includes(group)) throw badRequest(`Unknown settings group: ${group}`);
  const parsed = settingsSchemas[group].parse(input) as Settings[G];
  const before = await getSettingsGroup(group);
  await withTransaction(async (session) => {
    await SystemSetting.findOneAndUpdate(
      { key: group },
      { $set: { value: parsed, updatedBy: ctx.auth?.userId }, $inc: { version: 1 } },
      { upsert: true, session },
    );
    const d = diff(before as Record<string, unknown>, parsed as Record<string, unknown>);
    await audit(
      ctx,
      { action: 'settings.changed', entityType: 'systemSettings', entityRef: group, before: d.before, after: d.after, reason },
      session,
    );
  });
  invalidateSettingsCache();
  return parsed;
}

/** Inserts missing groups with defaults; never overwrites stored values. */
export async function ensureDefaultSettings() {
  for (const group of SETTINGS_GROUPS) {
    await SystemSetting.updateOne(
      { key: group },
      { $setOnInsert: { key: group, value: DEFAULT_SETTINGS[group] } },
      { upsert: true },
    );
  }
  invalidateSettingsCache();
}
