import { Link, useSearchParams } from 'react-router-dom';
import type { VisitSummaryDto } from '@mv/shared';
import { Card } from '@/components/ui/card';
import { StatusBadge, toneOf } from '@/components/ui/badge';
import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { useAuth } from '@/features/auth/auth-context';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ACTIVE_VISIT_STATUSES, useVisits } from './visit-lib';

const TABS = [
  { key: 'active', label: 'In progress', status: ACTIVE_VISIT_STATUSES.join(',') },
  { key: 'planned', label: 'Planned', status: 'PLANNED' },
  { key: 'completed', label: 'Completed', status: 'COMPLETED' },
  { key: 'all', label: 'All', status: undefined },
] as const;

/** Visits list: engineers see "My visits" (mine=true) by default. */
export function VisitsListPage() {
  const { hasPermission } = useAuth();
  const [sp, setSp] = useSearchParams();
  const engineer = hasPermission('visit.recordTime') && !hasPermission('workOrder.assign');
  const tab = TABS.find((t) => t.key === sp.get('tab')) ?? TABS[engineer ? 0 : 3];
  const page = Number(sp.get('page') ?? 1) || 1;
  const sort = sp.get('sort') ?? '-createdAt';
  const q = useVisits({ status: tab.status, mine: engineer ? 'true' : undefined, page, limit: 20, sort });
  const update = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setSp(next, { replace: true });
  };

  const columns: Column<VisitSummaryDto>[] = [
    {
      key: 'visitNo',
      header: 'Visit',
      sortKey: 'visitNo',
      cell: (v) => (
        <div className="min-w-0">
          <Link to={`/visits/${v.id}`} className="font-mono font-medium text-royal-700 hover:underline">
            {v.visitNo}
          </Link>
          <p className="truncate text-xs text-slate-500">{v.purpose}</p>
        </div>
      ),
    },
    {
      key: 'wo',
      header: 'Work order',
      cell: (v) => (
        <Link to={`/work-orders/${v.workOrder.id}`} className="font-mono text-sm text-royal-700 hover:underline">
          {v.workOrder.workOrderNo}
        </Link>
      ),
    },
    { key: 'site', header: 'Site', cell: (v) => v.site?.name ?? '—', hideOnMobile: true },
    { key: 'status', header: 'Status', sortKey: 'status', cell: (v) => <StatusBadge status={v.status} label={v.statusLabel} tone={toneOf(v.statusTone)} /> },
    { key: 'planned', header: 'Planned', sortKey: 'plannedAt', cell: (v) => (v.plannedAt ? formatDateTime(v.plannedAt) : '—') },
    { key: 'engineers', header: 'Engineers', cell: (v) => v.engineers.map((e) => e.name).join(', '), hideOnMobile: true },
  ];

  return (
    <div>
      <PageHeader title={engineer ? 'My visits' : 'Visits'} description="Site visits and six-step time tracking." />
      <div className="mb-3 flex max-w-full gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Visit filters">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === tab.key}
            onClick={() => update({ tab: t.key, page: undefined })}
            className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', t.key === tab.key ? 'border-royal-700 text-royal-700' : 'border-transparent text-slate-600 hover:text-navy-900')}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Card>
        <DataTable
          columns={columns}
          rows={q.data?.data}
          rowKey={(v) => v.id}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          sort={sort}
          onSortChange={(s) => update({ sort: s })}
          page={q.data?.meta.page}
          pages={q.data?.meta.pages}
          total={q.data?.meta.total}
          limit={q.data?.meta.limit}
          onPageChange={(p) => update({ page: String(p) })}
          emptyTitle="No visits"
          emptyDescription="Visits are planned from an accepted work order."
          caption="Visits"
        />
      </Card>
    </div>
  );
}
