import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import type { ReviewQueueItemDto } from '@mv/shared';
import { Card } from '@/components/ui/card';
import { Badge, StatusBadge, toneOf } from '@/components/ui/badge';
import { Input } from '@/components/ui/form';
import { Switch } from '@/components/ui/controls';
import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { formatDateTime } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { cn } from '@/lib/utils';
import { QUEUE_TABS, formatWaiting, useReviewQueue, waitingTone } from './review-lib';

/** Report-level badges shared by the queue and dashboards. */
export function QueueRowBadges({ r }: { r: ReviewQueueItemDto }) {
  return (
    <span className="flex flex-wrap gap-1">
      {r.revisionNo > 1 && <Badge tone="info">r{r.revisionNo} · resubmitted</Badge>}
      {r.isOwn && <Badge tone="warning">Your report — cannot review</Badge>}
    </span>
  );
}

export const queueColumns: Column<ReviewQueueItemDto>[] = [
  {
    key: 'wo',
    header: 'Work order',
    cell: (r) => (
      <div className="min-w-0 text-sm">
        <Link to={`/reviews/${r.id}`} className="font-mono font-medium text-royal-700 hover:underline">
          {r.workOrder.workOrderNo}
        </Link>
        <span className="block truncate text-slate-700">{r.workOrder.title}</span>
        <QueueRowBadges r={r} />
      </div>
    ),
  },
  {
    key: 'complaint',
    header: 'Complaint / visit',
    cell: (r) => (
      <div className="text-xs">
        <span className="block font-mono text-slate-700">{r.complaint.referenceNo}</span>
        <span className="block font-mono text-slate-500">{r.visit.visitNo}</span>
      </div>
    ),
    hideOnMobile: true,
  },
  { key: 'site', header: 'Site', cell: (r) => r.siteName ?? '—', hideOnMobile: true },
  { key: 'template', header: 'Checklist', cell: (r) => `${r.template} · rev ${r.revisionNo}`, hideOnMobile: true },
  {
    key: 'submitted',
    header: 'Submitted',
    cell: (r) => (
      <div className="text-xs">
        <span className="block">{r.submittedAt ? formatDateTime(r.submittedAt) : '—'}</span>
        {r.submittedByName && <span className="block text-slate-500">{r.submittedByName}</span>}
      </div>
    ),
  },
  {
    key: 'waiting',
    header: 'Waiting',
    cell: (r) => {
      const tone = waitingTone(r.waitingHours);
      return r.waitingHours === null ? (
        '—'
      ) : (
        <Badge tone={tone} aria-label={`Waiting ${formatWaiting(r.waitingHours)}`}>
          {formatWaiting(r.waitingHours)}
        </Badge>
      );
    },
  },
  {
    key: 'results',
    header: 'Fails / not checked',
    cell: (r) => (
      <span className="flex gap-1">
        <Badge tone={r.summary.fail ? 'danger' : 'neutral'}>{r.summary.fail} fail</Badge>
        <Badge tone={r.summary.notChecked ? 'warning' : 'neutral'}>{r.summary.notChecked} NC</Badge>
      </span>
    ),
    hideOnMobile: true,
  },
  {
    key: 'status',
    header: 'Status',
    cell: (r) => (
      <div className="space-y-1">
        <StatusBadge status={r.status} label={r.statusLabel} tone={toneOf(r.statusTone)} />
        {r.approvalLevels > 1 && (
          <span className="block text-xs text-slate-500">
            {r.approvalsSoFar} of {r.approvalLevels} approvals
          </span>
        )}
      </div>
    ),
  },
];

export function ReviewQueuePage() {
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const tab = QUEUE_TABS.find((t) => t.key === sp.get('tab')) ?? QUEUE_TABS[0];
  const page = Number(sp.get('page') ?? 1) || 1;
  const mine = sp.get('mine') === 'true';
  const [search, setSearch] = useState(sp.get('q') ?? '');
  const q = useDebounced(search.trim(), 300);
  const queue = useReviewQueue({ status: tab.status, mineOnly: mine ? 'true' : undefined, q: q || undefined, page, limit: 20 });

  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setSp(next, { replace: true });
  };

  return (
    <div>
      <PageHeader title="Reviews" description="Inspection reports awaiting technical review. Oldest submissions first." />
      <div className="mb-3 flex max-w-full gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Review status">
        {QUEUE_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === tab.key}
            onClick={() => set({ tab: t.key, page: undefined })}
            className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', t.key === tab.key ? 'border-royal-700 text-royal-700' : 'border-transparent text-slate-600 hover:text-navy-900')}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <Input
            aria-label="Search reviews"
            placeholder="Work order, complaint, visit or site"
            className="pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              set({ q: e.target.value || undefined, page: undefined });
            }}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <Switch checked={mine} onCheckedChange={(c) => set({ mine: c ? 'true' : undefined, page: undefined })} aria-label="Reviewed by me" />
          Reviewed by me
        </label>
      </div>
      <Card>
        <DataTable
          columns={queueColumns}
          rows={queue.data?.data}
          rowKey={(r) => r.id}
          loading={queue.isLoading}
          error={queue.error}
          onRetry={() => queue.refetch()}
          page={queue.data?.meta.page}
          pages={queue.data?.meta.pages}
          total={queue.data?.meta.total}
          limit={queue.data?.meta.limit}
          onPageChange={(p) => set({ page: String(p) })}
          onRowClick={(r) => navigate(`/reviews/${r.id}`)}
          emptyTitle={tab.key === 'pending' ? 'Nothing waiting for review' : 'No reports'}
          emptyDescription={tab.key === 'pending' ? 'Submitted inspection reports appear here.' : undefined}
          caption="Review queue"
        />
      </Card>
    </div>
  );
}
