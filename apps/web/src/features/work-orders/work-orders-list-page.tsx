import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarRange, Check, Search, Star, Zap, Package } from 'lucide-react';
import type { Paged, WorkOrderSummaryDto } from '@mv/shared';
import { Card } from '@/components/ui/card';
import { Badge, StatusBadge, toneOf } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form';
import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { useAuth } from '@/features/auth/auth-context';
import { DueCell, PriorityBadge } from '@/features/complaints/complaints-list-page';
import { useLookup } from '@/features/complaints/complaint-lib';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { cn } from '@/lib/utils';
import { buildWorkOrderParams, ENGINEER_TABS, STAFF_TABS, useWorkload, woFiltersFromParams, type WorkOrderFilters } from './wo-lib';

/** Engineers: workOrder.accept without workOrder.assign. */
export function useIsEngineerView() {
  const { hasPermission } = useAuth();
  return hasPermission('workOrder.accept') && !hasPermission('workOrder.assign');
}

export function AssigneesCell({ assignees }: { assignees: WorkOrderSummaryDto['assignees'] }) {
  if (!assignees.length) return <Badge tone="warning">Unassigned</Badge>;
  return (
    <ul className="space-y-0.5 text-xs">
      {assignees.map((a) => (
        <li key={a.id} className="flex items-center gap-1 whitespace-nowrap text-slate-700">
          {a.lead && <Star className="h-3 w-3 text-amber-500" aria-label="Lead engineer" />}
          {a.name}
          {a.accepted && <Check className="h-3 w-3 text-emerald-600" aria-label="Accepted" />}
        </li>
      ))}
    </ul>
  );
}

export function FlagIcons({ w }: { w: Pick<WorkOrderSummaryDto, 'shutdownRequired' | 'materialRequired'> }) {
  return (
    <span className="inline-flex gap-1">
      {w.shutdownRequired && (
        <Badge tone="danger" title="Shutdown required">
          <Zap className="h-3 w-3" aria-hidden /> Shutdown
        </Badge>
      )}
      {w.materialRequired && (
        <Badge tone="info" title="Materials required">
          <Package className="h-3 w-3" aria-hidden /> Material
        </Badge>
      )}
    </span>
  );
}

export function WorkOrdersListPage() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const engineer = useIsEngineerView();
  const canAssign = hasPermission('workOrder.assign');
  const staffLookups = hasPermission('master.read') && !engineer;
  const [sp, setSp] = useSearchParams();
  const f = woFiltersFromParams(sp, engineer);
  const [search, setSearch] = useState(f.q ?? '');
  const debounced = useDebounced(search, 350);

  const update = (patch: Partial<WorkOrderFilters>, resetPage = true) => {
    const next = new URLSearchParams(sp);
    for (const [k, val] of Object.entries(patch)) {
      if (val === undefined || val === '' || val === false || val === null) next.delete(k);
      else next.set(k, String(val));
    }
    if (resetPage && !('page' in patch)) next.delete('page');
    setSp(next, { replace: true });
  };

  const params = buildWorkOrderParams({ ...f, q: debounced || undefined });
  const q = useQuery({
    queryKey: ['work-orders', 'list', params],
    queryFn: async () => (await api.get<Paged<WorkOrderSummaryDto>>('/work-orders', { params })).data,
    placeholderData: keepPreviousData,
  });
  const priorities = useLookup('masters', 'priorities', { enabled: staffLookups });
  const regions = useLookup('masters', 'regions', { enabled: staffLookups });
  const sites = useLookup('masters', 'sites', { parentField: 'regionId', parentId: f.regionId, enabled: staffLookups });
  const engineers = useWorkload({ enabled: canAssign });
  const tabs = engineer ? ENGINEER_TABS : STAFF_TABS;

  const columns: Column<WorkOrderSummaryDto>[] = [
    {
      key: 'no',
      header: 'Work order',
      sortKey: 'workOrderNo',
      cell: (w) => (
        <div className="min-w-0">
          <Link to={`/work-orders/${w.id}`} className="font-mono text-sm font-medium text-royal-700 hover:underline" onClick={(e) => e.stopPropagation()}>
            {w.workOrderNo}
          </Link>
          <p className="max-w-[16rem] truncate text-xs text-slate-600">{w.title}</p>
          <FlagIcons w={w} />
        </div>
      ),
    },
    {
      key: 'complaint',
      header: 'Complaint',
      hideOnMobile: true,
      cell: (w) => (
        <Link to={`/complaints/${w.complaint.id}`} className="font-mono text-xs text-royal-700 hover:underline" onClick={(e) => e.stopPropagation()}>
          {w.complaint.referenceNo}
        </Link>
      ),
    },
    {
      key: 'site',
      header: 'Site',
      hideOnMobile: true,
      cell: (w) => (
        <div className="text-xs">
          <p className="text-slate-800">{w.site?.name}</p>
          <p className="text-slate-500">{w.region?.name}</p>
        </div>
      ),
    },
    { key: 'priority', header: 'Priority', cell: (w) => <PriorityBadge priority={w.priority} /> },
    { key: 'status', header: 'Status', sortKey: 'status', cell: (w) => <StatusBadge status={w.status} label={w.statusLabel} tone={toneOf(w.statusTone)} /> },
    { key: 'assignees', header: 'Engineers', cell: (w) => <AssigneesCell assignees={w.assignees} /> },
    {
      key: 'planned',
      header: 'Planned',
      sortKey: 'plannedVisitAt',
      cell: (w) => <span className="whitespace-nowrap text-xs text-slate-600">{w.plannedVisitAt ? formatDateTime(w.plannedVisitAt) : 'Not planned'}</span>,
    },
    { key: 'due', header: 'Due', sortKey: 'dueAt', cell: (w) => <DueCell c={w} /> },
    { key: 'sup', header: 'Supervisor', hideOnMobile: true, cell: (w) => <span className="text-xs text-slate-600">{w.supervisor?.name ?? '—'}</span> },
  ];

  return (
    <div>
      <PageHeader
        title={engineer ? 'My work orders' : 'Work orders'}
        description={engineer ? 'Jobs assigned to you. Accept new work and check planned visit dates.' : 'Field work raised against complaints, with assignment and planning status.'}
        actions={
          canAssign ? (
            <Link to="/work-orders/board" className={buttonVariants({ variant: 'outline' })}>
              <CalendarRange className="h-4 w-4" /> Assignment board
            </Link>
          ) : undefined
        }
      />
      <div className="mb-3 flex max-w-full gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Quick filters">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={f.tab === t.key}
            onClick={() => update({ tab: t.key })}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
              f.tab === t.key ? 'border-royal-700 text-royal-700' : 'border-transparent text-slate-600 hover:text-navy-900',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Card>
        <div className="flex flex-wrap items-end gap-2 border-b border-border p-3">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input
              aria-label="Search work orders"
              placeholder="Number, complaint, title or site"
              className="pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                update({ q: e.target.value || undefined });
              }}
            />
          </div>
          {staffLookups && (
            <>
              <Select aria-label="Filter by priority" className="w-auto" value={f.priorityId ?? ''} onChange={(e) => update({ priorityId: e.target.value || undefined })}>
                <option value="">All priorities</option>
                {(priorities.data ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <Select aria-label="Filter by region" className="w-auto" value={f.regionId ?? ''} onChange={(e) => update({ regionId: e.target.value || undefined, siteId: undefined })}>
                <option value="">All regions</option>
                {(regions.data ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
              {f.regionId && (
                <Select aria-label="Filter by site" className="w-auto" value={f.siteId ?? ''} onChange={(e) => update({ siteId: e.target.value || undefined })}>
                  <option value="">All sites</option>
                  {(sites.data ?? []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              )}
            </>
          )}
          {canAssign && (
            <Select aria-label="Filter by engineer" className="w-auto" value={f.assigneeId ?? ''} onChange={(e) => update({ assigneeId: e.target.value || undefined })}>
              <option value="">All engineers</option>
              {(engineers.data ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          )}
          <div className="flex items-center gap-1">
            <Input type="date" aria-label="Planned from" className="w-auto" value={f.plannedFrom ?? ''} onChange={(e) => update({ plannedFrom: e.target.value || undefined })} />
            <span className="text-xs text-slate-500">to</span>
            <Input type="date" aria-label="Planned to" className="w-auto" value={f.plannedTo ?? ''} onChange={(e) => update({ plannedTo: e.target.value || undefined })} />
          </div>
        </div>
        <DataTable
          caption="Work orders"
          columns={columns}
          rows={q.data?.data}
          rowKey={(w) => w.id}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          sort={f.sort}
          onSortChange={(s) => update({ sort: s })}
          page={q.data?.meta.page}
          pages={q.data?.meta.pages}
          total={q.data?.meta.total}
          limit={q.data?.meta.limit}
          onPageChange={(p) => update({ page: p }, false)}
          onRowClick={(w) => navigate(`/work-orders/${w.id}`)}
          emptyTitle={engineer ? 'No work orders here' : 'No work orders match your filters'}
          emptyDescription={!engineer ? 'Work orders are created from a classified complaint.' : undefined}
        />
      </Card>
    </div>
  );
}
