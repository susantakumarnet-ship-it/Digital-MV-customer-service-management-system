import { useQuery } from '@tanstack/react-query';
import type { Paged, ReportItemDto, ReviewContextDto, ReviewQueueItemDto, RevisionComparisonDto } from '@mv/shared';
import { api } from '@/lib/api';

/** Row shape of GET /inspection-reports/:id/revisions. */
export interface RevisionRow {
  id: string;
  revisionNo: number;
  status: string;
  statusLabel: string;
  submittedAt?: string | null;
  submittedByName?: string;
  approvedAt?: string | null;
}

export type ReviewOutcome = 'started' | 'returned' | 'levelApproved' | 'approved';

export interface ReviewActionResult {
  outcome: ReviewOutcome;
  reportId: string;
  context: ReviewContextDto | null;
}

export const QUEUE_TABS = [
  { key: 'pending', label: 'Pending', status: 'PENDING' },
  { key: 'review', label: 'Under review', status: 'UNDER_REVIEW' },
  { key: 'returned', label: 'Returned', status: 'RETURNED' },
  { key: 'approved', label: 'Approved', status: 'APPROVED' },
  { key: 'all', label: 'All', status: 'ALL' },
] as const;

export function useReviewQueue(params: Record<string, string | number | undefined>, enabled = true) {
  return useQuery({
    queryKey: ['reviews', 'queue', params],
    queryFn: async () => (await api.get<Paged<ReviewQueueItemDto>>('/reviews', { params })).data,
    enabled,
    refetchInterval: 60_000,
  });
}

export function useReviewContext(id: string) {
  return useQuery({
    queryKey: ['reviews', 'context', id],
    queryFn: async () => (await api.get<ReviewContextDto>(`/reviews/${id}`)).data,
    enabled: Boolean(id),
  });
}

export function useRevisions(reportId: string, enabled = true) {
  return useQuery({
    queryKey: ['inspection-reports', 'revisions', reportId],
    queryFn: async () => (await api.get<RevisionRow[]>(`/inspection-reports/${reportId}/revisions`)).data,
    enabled: enabled && Boolean(reportId),
  });
}

export function useComparison(toId: string, fromId: string | null) {
  return useQuery({
    queryKey: ['inspection-reports', 'compare', fromId, toId],
    queryFn: async () => (await api.get<RevisionComparisonDto>(`/inspection-reports/${toId}/compare`, { params: { with: fromId } })).data,
    enabled: Boolean(toId && fromId),
  });
}

/** Waiting-time emphasis in the queue: amber after 24 h, red after 48 h. */
export function waitingTone(hours: number | null | undefined): 'neutral' | 'warning' | 'danger' {
  if (hours === null || hours === undefined) return 'neutral';
  if (hours > 48) return 'danger';
  if (hours > 24) return 'warning';
  return 'neutral';
}

export function formatWaiting(hours: number | null | undefined) {
  if (hours === null || hours === undefined) return '—';
  if (hours < 1) return '< 1 h';
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** D-17: what an approval by the current reviewer would record. */
export function approvalStep(levels: number, approvalsSoFar: number) {
  const level = approvalsSoFar + 1;
  return { level, levels, final: level >= levels };
}

export type ItemFilter = 'all' | 'fail' | 'notChecked' | 'feedback';

export function filterItems(items: ReportItemDto[], filter: ItemFilter, feedback: Record<string, string>) {
  switch (filter) {
    case 'fail':
      return items.filter((i) => i.result === 'FAIL');
    case 'notChecked':
      return items.filter((i) => i.result === 'NOT_CHECKED');
    case 'feedback':
      return items.filter((i) => Boolean(feedback[i.key]?.trim()));
    default:
      return items;
  }
}

/** Builds the itemFeedback array for the API from the per-item draft map (blank comments dropped). */
export function feedbackPayload(feedback: Record<string, string>) {
  return Object.entries(feedback)
    .map(([itemKey, comment]) => ({ itemKey, comment: comment.trim() }))
    .filter((f) => f.comment.length > 0);
}

export const OUTCOME_MESSAGE: Record<ReviewOutcome, string> = {
  started: 'Review started',
  returned: 'Returned for correction — a new revision was created for the engineers',
  levelApproved: 'Your approval was recorded; the next level is waiting for another reviewer',
  approved: 'Report approved',
};
