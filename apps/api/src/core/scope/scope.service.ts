import { Types } from 'mongoose';
import type { AuthContext } from '../../common/context';

/**
 * Record-level data scoping (RBAC-05, HO §3.1, BRF §4).
 *
 * A user sees a record if ANY of these holds:
 *  - scope.global
 *  - record.organizationId ∈ scope.organizationIds
 *  - record.regionId       ∈ scope.regionIds
 *  - record.siteId         ∈ scope.siteIds
 *  - (optional) the user is personally attached to the record (e.g. work-order assignee)
 *
 * A non-global user with an empty scope and no personal attachment sees nothing (default deny).
 * Transactional entities therefore store denormalised organizationId / regionId / siteId.
 */
export interface ScopeFields {
  organization?: string;
  region?: string;
  site?: string;
  /** Fields holding user ids that grant personal access (e.g. 'assigneeIds', 'requesterId'). */
  personal?: string[];
}

const oid = (ids: string[]) => ids.map((i) => new Types.ObjectId(i));

export function scopeFilter(auth: AuthContext, fields: ScopeFields): Record<string, unknown> {
  if (auth.scope.global) return {};
  const or: Record<string, unknown>[] = [];
  if (fields.organization && auth.scope.organizationIds.length)
    or.push({ [fields.organization]: { $in: oid(auth.scope.organizationIds) } });
  if (fields.region && auth.scope.regionIds.length) or.push({ [fields.region]: { $in: oid(auth.scope.regionIds) } });
  if (fields.site && auth.scope.siteIds.length) or.push({ [fields.site]: { $in: oid(auth.scope.siteIds) } });
  for (const p of fields.personal ?? []) or.push({ [p]: new Types.ObjectId(auth.userId) });
  // Impossible match → default deny.
  if (!or.length) return { _id: { $exists: false } };
  return { $or: or };
}

/** In-memory equivalent of scopeFilter for a single loaded record. */
export function inScope(auth: AuthContext, record: Record<string, unknown>, fields: ScopeFields): boolean {
  if (auth.scope.global) return true;
  const has = (list: string[], v: unknown) => v != null && list.includes(String(v));
  if (fields.organization && has(auth.scope.organizationIds, record[fields.organization])) return true;
  if (fields.region && has(auth.scope.regionIds, record[fields.region])) return true;
  if (fields.site && has(auth.scope.siteIds, record[fields.site])) return true;
  for (const p of fields.personal ?? []) {
    const v = record[p];
    if (Array.isArray(v) ? v.map(String).includes(auth.userId) : String(v) === auth.userId) return true;
  }
  return false;
}

/** Combine a base filter with the scope filter without clobbering an existing $or. */
export function withScope(base: Record<string, unknown>, auth: AuthContext, fields: ScopeFields) {
  const sf = scopeFilter(auth, fields);
  if (!Object.keys(sf).length) return base;
  return { $and: [base, sf] };
}
