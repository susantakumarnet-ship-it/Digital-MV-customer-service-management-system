import { useQuery } from '@tanstack/react-query';
import { addDays, format, startOfDay, startOfMonth, startOfWeek } from 'date-fns';
import { workOrderCreateSchema, workOrderUpdateSchema, type CalendarItemDto, type EngineerWorkloadDto } from '@mv/shared';
import { api } from '@/lib/api';

/** Shape of GET /work-orders/summary (work-order.service.ts workOrderSummary). */
export interface WorkOrderKpis {
  total: number;
  open: number;
  unassigned: number;
  awaitingAcceptance: number;
  inProgress: number;
  overdue: number;
  statuses: { key: string; label: string; tone: string; count: number }[];
  byEngineer: { engineer: string; count: number }[];
}

export function useWorkOrderSummary(enabled = true) {
  return useQuery({
    queryKey: ['work-orders', 'summary'],
    queryFn: async () => (await api.get<WorkOrderKpis>('/work-orders/summary')).data,
    enabled,
    refetchInterval: 60_000,
  });
}

/** Engineers with workload counts; `siteId` marks who normally covers the site (eligible). */
export function useWorkload(opts: { from?: Date; to?: Date; siteId?: string; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['work-orders', 'workload', opts.from?.toISOString() ?? null, opts.to?.toISOString() ?? null, opts.siteId ?? null],
    queryFn: async () =>
      (
        await api.get<EngineerWorkloadDto[]>('/work-orders/workload', {
          params: { from: opts.from?.toISOString(), to: opts.to?.toISOString(), siteId: opts.siteId },
        })
      ).data,
    enabled: opts.enabled ?? true,
    staleTime: 30_000,
  });
}

// ---- datetime-local helpers ------------------------------------------------------------------

/** ISO → value for <input type="datetime-local"> (browser local time). */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return format(d, "yyyy-MM-dd'T'HH:mm");
}

/** datetime-local value → ISO string, or undefined when empty/invalid. */
export function fromLocalInput(v: string | undefined | null): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// ---- Form validation (mirrors the shared schemas; the server re-validates) --------------------

export interface WorkOrderFormValues {
  title: string;
  description: string;
  workScope: string;
  priorityId: string;
  plannedVisitAt: string; // datetime-local
  plannedEndAt: string;
  dueAt: string;
  shutdownRequired: boolean;
  shutdownDetails: string;
  materialRequired: boolean;
  materialNotes: string;
  supervisorId: string;
  assigneeIds: string[];
  leadEngineerId: string;
}

function issuesToErrors(issues: { path: (string | number)[]; message: string }[]) {
  const errors: Record<string, string> = {};
  for (const i of issues) {
    const k = String(i.path[0] ?? '_');
    errors[k] ??= i.message;
  }
  return errors;
}

/** Builds the POST /complaints/:id/work-orders payload and validates it with workOrderCreateSchema. */
export function validateCreateForm(v: WorkOrderFormValues): { payload?: Record<string, unknown>; errors: Record<string, string> } {
  const payload: Record<string, unknown> = {
    title: v.title,
    description: v.description,
    workScope: v.workScope,
    priorityId: v.priorityId || undefined,
    plannedVisitAt: fromLocalInput(v.plannedVisitAt),
    plannedEndAt: fromLocalInput(v.plannedEndAt),
    dueAt: fromLocalInput(v.dueAt),
    shutdownRequired: v.shutdownRequired,
    shutdownDetails: v.shutdownRequired ? v.shutdownDetails : '',
    materialRequired: v.materialRequired,
    materialNotes: v.materialRequired ? v.materialNotes : '',
    supervisorId: v.supervisorId || undefined,
    assigneeIds: v.assigneeIds,
    leadEngineerId: v.assigneeIds.length ? v.leadEngineerId || v.assigneeIds[0] : undefined,
  };
  const r = workOrderCreateSchema.safeParse(payload);
  if (!r.success) return { errors: issuesToErrors(r.error.issues) };
  if (payload.leadEngineerId && !v.assigneeIds.includes(String(payload.leadEngineerId))) {
    return { errors: { leadEngineerId: 'The lead engineer must be one of the assignees' } };
  }
  return { payload, errors: {} };
}

export type PlanningFormValues = Omit<WorkOrderFormValues, 'supervisorId' | 'assigneeIds' | 'leadEngineerId'> & { reason: string };

/** PATCH /work-orders/:id payload: only changed fields; a changed due date needs a reason. */
export function validatePlanningForm(
  v: PlanningFormValues,
  original: { dueAt?: string | null; title: string; description: string; workScope?: string; priorityId?: string; plannedVisitAt?: string | null; plannedEndAt?: string | null; shutdownRequired: boolean; shutdownDetails?: string; materialRequired: boolean; materialNotes?: string },
): { payload?: Record<string, unknown>; errors: Record<string, string> } {
  const next = {
    title: v.title,
    description: v.description,
    workScope: v.workScope,
    priorityId: v.priorityId || undefined,
    plannedVisitAt: fromLocalInput(v.plannedVisitAt) ?? null,
    plannedEndAt: fromLocalInput(v.plannedEndAt) ?? null,
    dueAt: fromLocalInput(v.dueAt) ?? null,
    shutdownRequired: v.shutdownRequired,
    shutdownDetails: v.shutdownRequired ? v.shutdownDetails : '',
    materialRequired: v.materialRequired,
    materialNotes: v.materialRequired ? v.materialNotes : '',
  };
  const sameDate = (a?: string | null, b?: string | null) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);
  const payload: Record<string, unknown> = {};
  if (next.title !== original.title) payload.title = next.title;
  if (next.description !== original.description) payload.description = next.description;
  if ((next.workScope || '') !== (original.workScope || '')) payload.workScope = next.workScope;
  if (next.priorityId && next.priorityId !== original.priorityId) payload.priorityId = next.priorityId;
  if (!sameDate(next.plannedVisitAt, original.plannedVisitAt)) payload.plannedVisitAt = next.plannedVisitAt;
  if (!sameDate(next.plannedEndAt, original.plannedEndAt)) payload.plannedEndAt = next.plannedEndAt;
  const dueChanged = !sameDate(next.dueAt, original.dueAt);
  if (dueChanged) payload.dueAt = next.dueAt;
  if (next.shutdownRequired !== original.shutdownRequired) payload.shutdownRequired = next.shutdownRequired;
  if ((next.shutdownDetails || '') !== (original.shutdownDetails || '')) payload.shutdownDetails = next.shutdownDetails;
  if (next.materialRequired !== original.materialRequired) payload.materialRequired = next.materialRequired;
  if ((next.materialNotes || '') !== (original.materialNotes || '')) payload.materialNotes = next.materialNotes;
  if (v.reason.trim()) payload.reason = v.reason.trim();

  // Validate the merged record so cross-field rules (end after start, details when flagged) apply.
  const merged = { ...next, reason: v.reason };
  const r = workOrderUpdateSchema.safeParse(merged);
  const errors = r.success ? {} : issuesToErrors(r.error.issues);
  if (dueChanged && original.dueAt && !v.reason.trim()) errors.reason = 'A reason is required to change the due date';
  if (Object.keys(errors).length) return { errors };
  return { payload, errors: {} };
}

/** Reassigning ACCEPTED/SCHEDULED work (engineers change) needs a reason and sends it back for acceptance. */
export function reassignNeedsReason(status: string, before: string[], after: string[]) {
  if (status !== 'ACCEPTED' && status !== 'SCHEDULED') return false;
  const a = [...new Set(before)].sort().join(',');
  const b = [...new Set(after)].sort().join(',');
  return a !== b;
}

// ---- List filters ----------------------------------------------------------------------------

export const STAFF_TABS = [
  { key: 'active', label: 'Active' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'awaiting', label: 'Awaiting acceptance' },
  { key: 'inProgress', label: 'In progress' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'all', label: 'All' },
] as const;
export const ENGINEER_TABS = [
  { key: 'active', label: 'Active' },
  { key: 'awaiting', label: 'Awaiting my acceptance' },
  { key: 'all', label: 'All' },
] as const;
export type WoTab = (typeof STAFF_TABS)[number]['key'];

export interface WorkOrderFilters {
  tab: WoTab;
  mine?: boolean;
  q?: string;
  priorityId?: string;
  assigneeId?: string;
  regionId?: string;
  siteId?: string;
  plannedFrom?: string; // yyyy-mm-dd
  plannedTo?: string;
  sort?: string;
  page?: number;
  limit?: number;
}

const dayStart = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999`).toISOString();

/** Maps UI filters to GET /work-orders query parameters (workOrderListQuery). */
export function buildWorkOrderParams(f: WorkOrderFilters): Record<string, string | number> {
  const p: Record<string, string | number> = {};
  switch (f.tab) {
    case 'active':
      p.status = 'ACTIVE';
      break;
    case 'unassigned':
      p.status = 'DRAFT';
      break;
    case 'awaiting':
      p.status = 'ASSIGNED';
      break;
    case 'inProgress':
      p.status = 'IN_PROGRESS';
      break;
    case 'overdue':
      p.overdue = 'true';
      break;
    default:
      break;
  }
  if (f.mine) p.mine = 'true';
  if (f.q?.trim()) p.q = f.q.trim();
  for (const k of ['priorityId', 'assigneeId', 'regionId', 'siteId'] as const) if (f[k]) p[k] = f[k]!;
  if (f.plannedFrom) p.plannedFrom = dayStart(f.plannedFrom);
  if (f.plannedTo) p.plannedTo = dayEnd(f.plannedTo);
  if (f.sort) p.sort = f.sort;
  p.page = f.page ?? 1;
  p.limit = f.limit ?? 20;
  return p;
}

export function woFiltersFromParams(sp: URLSearchParams, engineer: boolean): WorkOrderFilters {
  const allowed = (engineer ? ENGINEER_TABS : STAFF_TABS).map((t) => t.key) as string[];
  const tabParam = sp.get('tab') ?? '';
  const tab = (allowed.includes(tabParam) ? tabParam : 'active') as WoTab;
  const get = (k: string) => sp.get(k) || undefined;
  return {
    tab,
    mine: engineer ? sp.get('mine') !== 'false' : sp.get('mine') === 'true',
    q: get('q'),
    priorityId: get('priorityId'),
    assigneeId: get('assigneeId'),
    regionId: get('regionId'),
    siteId: get('siteId'),
    plannedFrom: get('plannedFrom'),
    plannedTo: get('plannedTo'),
    sort: get('sort') ?? '-createdAt',
    page: Number(sp.get('page') ?? 1) || 1,
  };
}

// ---- Board placement -------------------------------------------------------------------------

export const dayKey = (d: Date) => format(d, 'yyyy-MM-dd');

export function weekStart(d: Date) {
  return startOfWeek(d, { weekStartsOn: 1 });
}

export function weekDays(start: Date) {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** 6×7 grid of days covering the month of `d` (weeks start Monday). */
export function monthGrid(d: Date) {
  const first = weekStart(startOfMonth(d));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

export interface PlacedChip {
  item: CalendarItemDto;
  /** True on days after the item's first visible day (multi-day span). */
  continuation: boolean;
  /** True when the span carries on beyond this day. */
  continues: boolean;
}

/** Day keys covered by an item (planned start through planned end, start-of-day granularity). */
export function spanDays(item: Pick<CalendarItemDto, 'start' | 'end'>): string[] {
  if (!item.start) return [];
  const s = startOfDay(new Date(item.start));
  const e = startOfDay(new Date(item.end && new Date(item.end) > new Date(item.start) ? item.end : item.start));
  const out: string[] = [];
  for (let d = s; d <= e && out.length < 93; d = addDays(d, 1)) out.push(dayKey(d));
  return out;
}

/**
 * Week board placement: for each engineer row and each day column, the work orders assigned to that
 * engineer whose planned span covers the day. Multi-day spans repeat per day with continuation flags.
 */
export function placeByEngineer(items: CalendarItemDto[], engineerIds: string[], days: Date[]) {
  const keys = days.map(dayKey);
  const grid = new Map<string, Map<string, PlacedChip[]>>();
  for (const id of engineerIds) grid.set(id, new Map(keys.map((k) => [k, []])));
  for (const item of items) {
    const span = spanDays(item);
    const visible = span.filter((k) => keys.includes(k));
    if (!visible.length) continue;
    for (const a of item.assignees) {
      const row = grid.get(a.id);
      if (!row) continue;
      visible.forEach((k) => {
        const idx = span.indexOf(k);
        row.get(k)!.push({ item, continuation: idx > 0, continues: idx < span.length - 1 });
      });
    }
  }
  return grid;
}

/** Month view: chips per day regardless of engineer. */
export function placeByDay(items: CalendarItemDto[], days: Date[]) {
  const keys = new Set(days.map(dayKey));
  const map = new Map<string, PlacedChip[]>();
  for (const k of keys) map.set(k, []);
  for (const item of items) {
    const span = spanDays(item);
    span.forEach((k, idx) => {
      if (keys.has(k)) map.get(k)!.push({ item, continuation: idx > 0, continues: idx < span.length - 1 });
    });
  }
  return map;
}

export const PRIORITY_CHIP: Record<string, string> = {
  danger: 'border-red-300 bg-red-50 text-red-800',
  warning: 'border-amber-300 bg-amber-50 text-amber-900',
  info: 'border-sky-300 bg-sky-50 text-sky-900',
  neutral: 'border-slate-300 bg-slate-50 text-slate-800',
};
