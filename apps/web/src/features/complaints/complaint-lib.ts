import { useQuery } from '@tanstack/react-query';
import type { MasterKey } from '@mv/shared';
import { api } from '@/lib/api';
import type { MasterOption } from '@/lib/types';

/** Attachment policy (settings group `attachments`, D-20). */
export interface AttachmentPolicy {
  allowedExtensions: string[];
  maxFileSizeMb: number;
  maxFilesPerRecord: number;
  maxTotalSizeMbPerRecord: number;
}

/** Shape of GET /complaints/summary (complaint.service.ts complaintSummary). */
export interface ComplaintKpis {
  total: number;
  receivedToday: number;
  new: number;
  underReview: number;
  awaitingCustomer: number;
  assigned: number;
  inProgress: number;
  pendingReview: number;
  resolved: number;
  closed: number;
  open: number;
  overdue: number;
  unclassified: number;
  byStatus: Record<string, number>;
  statuses: { key: string; label: string; tone: string; count: number }[];
  byMonth: { month: string; count: number }[];
  byRegion: { region: string; count: number }[];
  byPriority: { priority: string; rank: number; tone: string; count: number }[];
}

export interface PublicFormBootstrap {
  formToken: string;
  privacyNoticeVersion: string;
  privacyNoticeText: string;
  attachments: AttachmentPolicy;
  captchaSiteKey: string | null;
}

/** One Idempotency-Key per form session (API-04): retries of the same submission are safe. */
export function newIdempotencyKey() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

export function extensionOf(name: string) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Client-side pre-check mirroring the server policy, so users get immediate feedback. The server
 * re-validates everything (including real content type) — this is a convenience, not a control.
 */
export function precheckFiles(
  incoming: File[],
  policy: AttachmentPolicy,
  existing: { count: number; bytes: number } = { count: 0, bytes: 0 },
): { accepted: File[]; errors: string[] } {
  const accepted: File[] = [];
  const errors: string[] = [];
  let count = existing.count;
  let bytes = existing.bytes;
  const maxFile = policy.maxFileSizeMb * 1024 * 1024;
  const maxTotal = policy.maxTotalSizeMbPerRecord * 1024 * 1024;
  for (const f of incoming) {
    const ext = extensionOf(f.name);
    if (!ext || !policy.allowedExtensions.includes(ext)) {
      errors.push(`"${f.name}": file type not allowed (allowed: ${policy.allowedExtensions.join(', ')}).`);
      continue;
    }
    if (f.size === 0) {
      errors.push(`"${f.name}" is empty.`);
      continue;
    }
    if (f.size > maxFile) {
      errors.push(`"${f.name}" is larger than ${policy.maxFileSizeMb} MB.`);
      continue;
    }
    if (count + 1 > policy.maxFilesPerRecord) {
      errors.push(`At most ${policy.maxFilesPerRecord} files can be attached.`);
      break;
    }
    if (bytes + f.size > maxTotal) {
      errors.push(`"${f.name}" would exceed the ${policy.maxTotalSizeMbPerRecord} MB total limit.`);
      continue;
    }
    count += 1;
    bytes += f.size;
    accepted.push(f);
  }
  return { accepted, errors };
}

/** Builds a multipart body: JSON payload in `data`, files in `files` (API convention). */
export function multipartBody(data: unknown, files: File[] = []) {
  const fd = new FormData();
  fd.append('data', JSON.stringify(data));
  for (const f of files) fd.append('files', f, f.name);
  return fd;
}

/** Opens a short-lived signed download URL (never cached). */
export async function openAttachment(id: string, inline = false) {
  const { data } = await api.get<{ url: string }>(`/files/${id}/url`, { params: { inline: inline ? 'true' : undefined } });
  window.open(data.url, '_blank', 'noopener,noreferrer');
}

// ---- List filters ------------------------------------------------------------------------------

export const QUICK_TABS = [
  { key: 'open', label: 'Open' },
  { key: 'new', label: 'New' },
  { key: 'review', label: 'Under review' },
  { key: 'awaiting', label: 'Awaiting customer' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'all', label: 'All' },
] as const;
export type QuickTab = (typeof QUICK_TABS)[number]['key'];

export interface ComplaintFilters {
  tab: QuickTab;
  q?: string;
  priorityId?: string;
  requestTypeId?: string;
  regionId?: string;
  cityId?: string;
  siteId?: string;
  receivedFrom?: string; // yyyy-mm-dd
  receivedTo?: string; // yyyy-mm-dd
  unclassified?: boolean;
  sort?: string;
  page?: number;
  limit?: number;
}

const startOfDay = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const endOfDay = (d: string) => new Date(`${d}T23:59:59.999`).toISOString();

/** Maps UI filters to GET /complaints query parameters (complaintListQuery). */
export function buildComplaintParams(f: ComplaintFilters): Record<string, string | number> {
  const p: Record<string, string | number> = {};
  switch (f.tab) {
    case 'open':
      p.status = 'OPEN';
      break;
    case 'new':
      p.status = 'NEW';
      break;
    case 'review':
      p.status = 'UNDER_REVIEW,REOPENED';
      break;
    case 'awaiting':
      p.status = 'AWAITING_CUSTOMER_INFO';
      break;
    case 'overdue':
      p.overdue = 'true';
      break;
    default:
      break;
  }
  if (f.q?.trim()) p.q = f.q.trim();
  for (const k of ['priorityId', 'requestTypeId', 'regionId', 'cityId', 'siteId'] as const) if (f[k]) p[k] = f[k]!;
  if (f.receivedFrom) p.receivedFrom = startOfDay(f.receivedFrom);
  if (f.receivedTo) p.receivedTo = endOfDay(f.receivedTo);
  if (f.unclassified) p.unclassified = 'true';
  if (f.sort) p.sort = f.sort;
  p.page = f.page ?? 1;
  p.limit = f.limit ?? 20;
  return p;
}

export function filtersFromParams(sp: URLSearchParams): ComplaintFilters {
  const tab = (QUICK_TABS.find((t) => t.key === sp.get('tab'))?.key ?? 'open') as QuickTab;
  const get = (k: string) => sp.get(k) || undefined;
  return {
    tab,
    q: get('q'),
    priorityId: get('priorityId'),
    requestTypeId: get('requestTypeId'),
    regionId: get('regionId'),
    cityId: get('cityId'),
    siteId: get('siteId'),
    receivedFrom: get('receivedFrom'),
    receivedTo: get('receivedTo'),
    unclassified: sp.get('unclassified') === 'true',
    sort: get('sort') ?? '-receivedAt',
    page: Number(sp.get('page') ?? 1) || 1,
  };
}

// ---- Lookups -----------------------------------------------------------------------------------

/**
 * Dropdown options. Staff (master.read) use /masters/:resource/options; customers and the public
 * form use the public options endpoint (active records, minimal fields).
 */
export type OptionSource = 'masters' | 'public' | 'scoped';

export function useLookup(
  source: OptionSource,
  resource: MasterKey,
  opts: { parentField?: string; parentId?: string; enabled?: boolean } = {},
) {
  const needsParent = Boolean(opts.parentField);
  return useQuery({
    queryKey: ['lookup', source, resource, opts.parentField ?? null, opts.parentId ?? null],
    queryFn: async () => {
      const url =
        source === 'masters'
          ? `/masters/${resource}/options`
          : source === 'scoped'
            ? `/complaints/options/${resource}`
            : `/public/options/${resource}`;
      const params = opts.parentId ? { parentField: opts.parentField, parentId: opts.parentId } : undefined;
      return (await api.get<MasterOption[]>(url, { params })).data;
    },
    enabled: (opts.enabled ?? true) && (!needsParent || Boolean(opts.parentId)),
    staleTime: 5 * 60_000,
  });
}

export function useComplaintSummary(enabled = true) {
  return useQuery({
    queryKey: ['complaints', 'summary'],
    queryFn: async () => (await api.get<ComplaintKpis>('/complaints/summary')).data,
    enabled,
    refetchInterval: 60_000,
  });
}
