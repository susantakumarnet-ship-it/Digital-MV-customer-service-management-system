import { Link, useSearchParams } from 'react-router-dom';
import type { MaterialRequestSummaryDto } from '@mv/shared';
import { Card } from '@/components/ui/card';
import { Badge, StatusBadge, toneOf } from '@/components/ui/badge';
import { Input, Select } from '@/components/ui/form';
import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { useAuth } from '@/features/auth/auth-context';
import { formatDate, formatDateTime, timeAgo } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { cn } from '@/lib/utils';
import { useState } from 'react';
import { buildMaterialParams, MATERIAL_TABS, MATERIAL_URGENCIES, sortForStore, urgencyLabel, urgencyTone, useMaterialRequests } from './material-lib';

function useParamsUpdater() {
  const [sp, setSp] = useSearchParams();
  const update = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setSp(next, { replace: true });
  };
  return [sp, update] as const;
}

const requestCell = (r: MaterialRequestSummaryDto) => (
  <div className="min-w-0">
    <Link to={`/materials/${r.id}`} className="font-mono font-medium text-royal-700 hover:underline">
      {r.requestNo}
    </Link>
    <p className="truncate text-xs text-slate-500">
      {r.lineCount} item{r.lineCount === 1 ? '' : 's'} · {r.requester.name}
    </p>
  </div>
);
const woCell = (r: MaterialRequestSummaryDto) => (
  <Link to={`/work-orders/${r.workOrder.id}`} className="font-mono text-sm text-royal-700 hover:underline">
    {r.workOrder.workOrderNo}
  </Link>
);

/** Material requests: engineers see "My material requests"; supervisors default to pending approval. */
export function MaterialsListPage() {
  const { hasPermission } = useAuth();
  const [sp, update] = useParamsUpdater();
  const engineer = hasPermission('material.create') && !hasPermission('material.approve') && !hasPermission('inventory.issue');
  const approver = hasPermission('material.approve');
  const tabKey = sp.get('tab') ?? (approver ? 'pending' : 'all');
  const tab = MATERIAL_TABS.find((t) => t.key === tabKey) ?? MATERIAL_TABS[MATERIAL_TABS.length - 1];
  const [search, setSearch] = useState(sp.get('q') ?? '');
  const q = useDebounced(search, 300);
  const urgency = sp.get('urgency') ?? '';
  const page = Number(sp.get('page') ?? 1) || 1;
  const sort = sp.get('sort') ?? '-createdAt';
  const list = useMaterialRequests(buildMaterialParams({ tab: tab.key, q, urgency, mine: engineer, page, sort }));

  const columns: Column<MaterialRequestSummaryDto>[] = [
    { key: 'requestNo', header: 'Request', sortKey: 'requestNo', cell: requestCell },
    { key: 'wo', header: 'Work order', cell: woCell },
    { key: 'site', header: 'Site', cell: (r) => r.site?.name ?? '—', hideOnMobile: true },
    { key: 'urgency', header: 'Urgency', cell: (r) => <Badge tone={urgencyTone(r.urgency)}>{urgencyLabel(r.urgency)}</Badge> },
    { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} label={r.statusLabel} tone={toneOf(r.statusTone)} /> },
    { key: 'neededBy', header: 'Needed by', sortKey: 'neededBy', cell: (r) => (r.neededBy ? formatDate(r.neededBy) : '—'), hideOnMobile: true },
    { key: 'createdAt', header: 'Raised', sortKey: 'createdAt', cell: (r) => formatDateTime(r.createdAt), hideOnMobile: true },
  ];

  return (
    <div>
      <PageHeader title={engineer ? 'My material requests' : 'Material requests'} description="Request, approve, issue and return site material." />
      <div className="mb-3 flex max-w-full gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Material request filters">
        {MATERIAL_TABS.map((t) => (
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
      <div className="mb-3 flex flex-wrap gap-2">
        <Input
          aria-label="Search material requests"
          placeholder="Search request or work order number"
          className="max-w-xs"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            update({ q: e.target.value || undefined, page: undefined });
          }}
        />
        <Select aria-label="Urgency" className="max-w-48" value={urgency} onChange={(e) => update({ urgency: e.target.value || undefined, page: undefined })}>
          <option value="">All urgencies</option>
          {MATERIAL_URGENCIES.map((u) => (
            <option key={u.value} value={u.value}>
              {u.label}
            </option>
          ))}
        </Select>
      </div>
      <Card>
        <DataTable
          columns={columns}
          rows={list.data?.data}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => list.refetch()}
          sort={sort}
          onSortChange={(s) => update({ sort: s })}
          page={list.data?.meta.page}
          pages={list.data?.meta.pages}
          total={list.data?.meta.total}
          limit={list.data?.meta.limit}
          onPageChange={(p) => update({ page: String(p) })}
          emptyTitle="No material requests"
          emptyDescription={engineer ? 'Raise a request from one of your work orders or visits.' : 'Nothing matches these filters.'}
          caption="Material requests"
        />
      </Card>
    </div>
  );
}

/** Storekeeper queue: approved and partially issued requests, most urgent first. */
export function StoreQueuePage() {
  const [sp, update] = useParamsUpdater();
  const page = Number(sp.get('page') ?? 1) || 1;
  const list = useMaterialRequests({ store: 'true', page, limit: 50, sort: 'submittedAt' });
  const rows = list.data ? sortForStore(list.data.data) : undefined;
  const columns: Column<MaterialRequestSummaryDto>[] = [
    { key: 'urgency', header: 'Urgency', cell: (r) => <Badge tone={urgencyTone(r.urgency)}>{urgencyLabel(r.urgency)}</Badge> },
    { key: 'requestNo', header: 'Request', cell: requestCell },
    { key: 'wo', header: 'Work order', cell: woCell },
    { key: 'site', header: 'Site', cell: (r) => r.site?.name ?? '—', hideOnMobile: true },
    { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} label={r.statusLabel} tone={toneOf(r.statusTone)} /> },
    { key: 'neededBy', header: 'Needed by', cell: (r) => (r.neededBy ? formatDate(r.neededBy) : '—') },
    { key: 'waiting', header: 'Waiting', cell: (r) => timeAgo(r.submittedAt ?? r.createdAt), hideOnMobile: true },
  ];
  return (
    <div>
      <PageHeader title="Store queue" description="Approved requests waiting to be reserved or issued — critical first." />
      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => list.refetch()}
          page={list.data?.meta.page}
          pages={list.data?.meta.pages}
          total={list.data?.meta.total}
          limit={list.data?.meta.limit}
          onPageChange={(p) => update({ page: String(p) })}
          emptyTitle="Nothing to issue"
          emptyDescription="Approved material requests appear here."
          caption="Store queue"
        />
      </Card>
    </div>
  );
}
