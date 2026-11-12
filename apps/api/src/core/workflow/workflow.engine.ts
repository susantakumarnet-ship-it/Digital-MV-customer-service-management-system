import type { ClientSession } from 'mongoose';
import type { WorkflowDefinitionDto, WorkflowEntity, WorkflowTransition } from '@mv/shared';
import type { RequestContext } from '../../common/context';
import { AppError, conflict, forbidden, notFound, unprocessable, validationFailed } from '../../common/errors';
import { audit } from '../audit/audit.service';
import { WorkflowDefinition } from './workflow.model';

/**
 * Centralised state-transition service (BRF §22, WF-01/WF-02).
 *
 * Status fields are never written directly by controllers. Every change goes through `transition()`,
 * which validates: transition exists & enabled → current state allowed → actor permission →
 * mandatory reason → named guards (business conditions). It then updates status + statusHistory
 * and writes the audit entry in the caller's transaction.
 */

export interface WorkflowRecord {
  _id: unknown;
  status: string;
  statusHistory?: { from?: string; to: string; action: string; by?: unknown; byName?: string; at: Date; reason?: string }[];
  [k: string]: unknown;
}

export interface GuardContext<T extends WorkflowRecord = WorkflowRecord> {
  entity: WorkflowEntity;
  record: T;
  transition: WorkflowTransition;
  ctx: RequestContext;
  payload: Record<string, unknown>;
  session?: ClientSession;
}

/** A guard returns null when satisfied, or a human-readable failure message. */
export type Guard = (g: GuardContext) => Promise<string | null> | string | null;

const guards = new Map<string, Guard>();

export function registerGuard(name: string, fn: Guard) {
  guards.set(name, fn);
}
export function registeredGuards() {
  return [...guards.keys()].sort();
}

// ---- Definition cache --------------------------------------------------------------------------
const CACHE_MS = 10_000;
const defCache = new Map<WorkflowEntity, { at: number; def: WorkflowDefinitionDto }>();
export function invalidateWorkflowCache(entity?: WorkflowEntity) {
  if (entity) defCache.delete(entity);
  else defCache.clear();
}

export async function getDefinition(entity: WorkflowEntity): Promise<WorkflowDefinitionDto> {
  const hit = defCache.get(entity);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.def;
  const doc = await WorkflowDefinition.findOne({ entity }).lean();
  if (!doc) throw notFound(`Workflow definition for ${entity}`);
  const def = { ...doc, id: String(doc._id), updatedAt: String(doc.updatedAt) } as unknown as WorkflowDefinitionDto;
  defCache.set(entity, { at: Date.now(), def });
  return def;
}

// ---- Transition evaluation ---------------------------------------------------------------------
export interface TransitionRequest<T extends WorkflowRecord> {
  entity: WorkflowEntity;
  record: T;
  action: string;
  ctx: RequestContext;
  reason?: string;
  payload?: Record<string, unknown>;
  session?: ClientSession;
  /** Set when the system performs the transition as a consequence of another action. */
  system?: boolean;
  /** Human-readable reference for the audit entry. */
  entityRef?: string;
}

async function evaluateGuards(t: WorkflowTransition, g: Omit<GuardContext, 'transition'>) {
  const failures: string[] = [];
  for (const name of t.guards) {
    const fn = guards.get(name);
    // Fail closed: a configured guard without an implementation blocks the transition.
    if (!fn) {
      failures.push(`Workflow rule "${name}" is not available`);
      continue;
    }
    const res = await fn({ ...g, transition: t });
    if (res) failures.push(res);
  }
  return failures;
}

export async function transition<T extends WorkflowRecord>(req: TransitionRequest<T>) {
  const def = await getDefinition(req.entity);
  const t = def.transitions.find((x) => x.action === req.action);
  if (!t) throw unprocessable(`Unknown action "${req.action}"`, 'INVALID_ACTION');
  if (!t.enabled) throw conflict(`"${t.label}" is disabled by configuration`, 'TRANSITION_DISABLED');
  if (t.systemOnly && !req.system) {
    throw conflict(`"${t.label}" happens automatically and cannot be performed directly`, 'SYSTEM_TRANSITION');
  }

  const from = req.record.status;
  if (!t.from.includes(from)) {
    const label = def.states.find((s) => s.key === from)?.label ?? from;
    throw conflict(`Cannot "${t.label}" while status is "${label}"`, 'INVALID_STATE', { from, action: t.action });
  }

  if (!req.system) {
    const perms = req.ctx.auth?.permissions;
    if (!perms || !perms.has(t.permission as never)) throw forbidden();
  }

  const reason = req.reason?.trim();
  if (t.requiresReason && !reason) throw validationFailed({ reason: 'A reason is required for this action' });

  const failures = await evaluateGuards(t, {
    entity: req.entity,
    record: req.record,
    ctx: req.ctx,
    payload: req.payload ?? {},
    session: req.session,
  });
  if (failures.length) {
    throw new AppError(
      409,
      'WORKFLOW_CONDITIONS_NOT_MET',
      failures.join(' '),
      undefined,
      { failures, action: t.action },
    );
  }

  const at = new Date();
  req.record.status = t.to;
  req.record.statusHistory = [
    ...(req.record.statusHistory ?? []),
    { from, to: t.to, action: t.action, by: req.ctx.auth?.userId, byName: req.ctx.auth?.name ?? 'System', at, reason },
  ];

  await audit(
    req.ctx,
    {
      action: `${req.entity}.${t.action}`,
      entityType: req.entity,
      entityId: req.record._id as string,
      entityRef: req.entityRef,
      before: { status: from },
      after: { status: t.to },
      reason,
      meta: req.system ? { system: true } : undefined,
    },
    req.session,
  );

  return { from, to: t.to, at, transition: t };
}

/** Actions the current user could attempt from the record's current state (for UI buttons). */
export async function availableActions(entity: WorkflowEntity, record: WorkflowRecord, ctx: RequestContext) {
  const def = await getDefinition(entity);
  return def.transitions
    .filter(
      (t) =>
        t.enabled &&
        !t.systemOnly &&
        t.from.includes(record.status) &&
        Boolean(ctx.auth?.permissions.has(t.permission as never)),
    )
    .map((t) => ({ action: t.action, label: t.label, to: t.to, requiresReason: t.requiresReason, confirm: t.confirm }));
}

export async function stateLabel(entity: WorkflowEntity, key: string) {
  const def = await getDefinition(entity);
  return def.states.find((s) => s.key === key)?.label ?? key;
}
