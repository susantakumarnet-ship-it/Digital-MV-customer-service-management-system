import { useQuery } from '@tanstack/react-query';
import {
  DEFAULT_NCR_CATEGORIES,
  DEFAULT_NCR_SEVERITIES,
  NCR_DISPOSITIONS,
  type NcrDetailDto,
  type NcrSummaryDto,
  type Paged,
  type StatusTone,
} from '@mv/shared';
import { useAuth } from '@/features/auth/auth-context';
import { api } from '@/lib/api';

export { NCR_DISPOSITIONS };

/** Shape of GET /ncrs/summary (ncr.service.ts ncrSummary). */
export interface NcrSummaryStats {
  open: number;
  awaitingVerification: number;
  overdue: number;
  assignedToMe: number;
  closed: number;
  statuses: { key: string; label: string; tone: string; count: number }[];
  bySeverity: { severity: string; count: number }[];
}

export type NcrAction = NcrDetailDto['availableActions'][number];

// ---- Display helpers ---------------------------------------------------------------------------

export function severityTone(severity: string): StatusTone {
  const s = severity.toLowerCase();
  if (s === 'critical') return 'danger';
  if (s === 'major') return 'warning';
  if (s === 'minor') return 'info';
  return 'neutral';
}

export function dispositionLabel(v?: string | null) {
  return NCR_DISPOSITIONS.find((d) => d.value === v)?.label ?? v ?? '—';
}

export const ACTION_FIELD_LABELS: Record<string, string> = {
  containmentAction: 'Containment action',
  rootCause: 'Root cause',
  correctiveAction: 'Corrective action',
  disposition: 'Disposition',
  dueAt: 'Due date',
  submitted: 'Submitted',
};

/** Actions that move work backwards or end the record get the danger styling. */
export const NCR_DANGER_ACTIONS = new Set(['return']);

// ---- Queries -----------------------------------------------------------------------------------

export function buildNcrParams(f: { status?: string; severity?: string; category?: string; mine?: boolean; overdue?: boolean; q?: string; page?: number; sort?: string; complaintId?: string; workOrderId?: string; limit?: number }) {
  const p: Record<string, string | number> = { page: f.page ?? 1, limit: f.limit ?? 20 };
  if (f.status) p.status = f.status;
  if (f.severity) p.severity = f.severity;
  if (f.category) p.category = f.category;
  if (f.mine) p.mine = 'true';
  if (f.overdue) p.overdue = 'true';
  if (f.q?.trim()) p.q = f.q.trim();
  if (f.sort) p.sort = f.sort;
  if (f.complaintId) p.complaintId = f.complaintId;
  if (f.workOrderId) p.workOrderId = f.workOrderId;
  return p;
}

export function useNcrs(params: Record<string, string | number>, enabled = true) {
  return useQuery({
    queryKey: ['ncrs', 'list', params],
    queryFn: async () => (await api.get<Paged<NcrSummaryDto>>('/ncrs', { params })).data,
    enabled,
  });
}

export function useNcr(id: string) {
  return useQuery({
    queryKey: ['ncrs', 'detail', id],
    queryFn: async () => (await api.get<NcrDetailDto>(`/ncrs/${id}`)).data,
    enabled: Boolean(id),
  });
}

export function useNcrSummary(enabled = true) {
  return useQuery({
    queryKey: ['ncrs', 'summary'],
    queryFn: async () => (await api.get<NcrSummaryStats>('/ncrs/summary')).data,
    enabled,
    refetchInterval: 60_000,
  });
}

interface NcrOptions {
  categories: string[];
  severities: string[];
  defaultDueDays: number;
  owners?: { id: string; name: string }[];
}

function useNcrOptions(complaintId?: string, enabled = true) {
  return useQuery({
    queryKey: ['ncrs', 'options', complaintId ?? null],
    queryFn: async () => (await api.get<NcrOptions>('/ncrs/options', { params: complaintId ? { complaintId } : {} })).data,
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Configured categories/severities (settings group `ncr`, D-08), with shipped defaults as fallback. */
export function useNcrLists() {
  const q = useNcrOptions();
  return {
    categories: q.data?.categories?.length ? q.data.categories : DEFAULT_NCR_CATEGORIES,
    severities: q.data?.severities?.length ? q.data.severities : DEFAULT_NCR_SEVERITIES,
  };
}

/** Active users who can own an NCR, within the complaint's scope when given (server re-validates). */
export function useOwnerCandidates(enabled: boolean, complaintId?: string) {
  const { hasPermission } = useAuth();
  const q = useNcrOptions(complaintId, enabled && hasPermission('ncr.assign'));
  return { loading: q.isLoading, error: q.error, options: q.data?.owners ?? [] };
}

// ---- Validation ----------------------------------------------------------------------------------

export interface RaiseDraft {
  category: string;
  severity: string;
  title: string;
  description: string;
  ownerId: string;
  dueAt: string;
}

/** Mirrors ncrCreateSchema messages so users get instant feedback. */
export function validateRaise(d: RaiseDraft): Partial<Record<keyof RaiseDraft, string>> {
  const e: Partial<Record<keyof RaiseDraft, string>> = {};
  if (!d.category) e.category = 'Select a category';
  if (!d.severity) e.severity = 'Select a severity';
  if (d.title.trim().length < 3) e.title = 'Enter a short title';
  if (d.description.trim().length < 10) e.description = 'Describe the non-conformance';
  if (d.dueAt) {
    const t = new Date(d.dueAt);
    if (Number.isNaN(t.getTime())) e.dueAt = 'Enter a valid date';
  }
  return e;
}

/** `yyyy-MM-dd` (date input) → ISO at end of that local day. */
export function dateInputToIso(v: string) {
  if (!v) return undefined;
  const d = new Date(`${v}T23:59:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function isoToDateInput(v?: string | null) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
