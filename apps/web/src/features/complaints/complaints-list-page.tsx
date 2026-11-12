import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { ComplaintSummaryDto, Paged } from '@mv/shared';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/controls';
import { Input, Select } from '@/components/ui/form';
import { Badge, StatusBadge, toneOf } from '@/components/ui/badge';
import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage, getBlob } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { cn, downloadBlob } from '@/lib/utils';
import { buildComplaintParams, filtersFromParams, QUICK_TABS, useLookup, type ComplaintFilters } from './complaint-lib';

export function PriorityBadge({ priority }: { priority?: ComplaintSummaryDto['priority'] }) {
  if (!priority) return <span className="text-xs text-slate-400">Unclassified</span>;
  return <Badge tone={toneOf(priority.tone)}>{priority.name}</Badge>;
}

export function DueCell({ c }: { c: Pick<ComplaintSummaryDto, 'dueAt' | 'overdue'> }) {
  if (!c.dueAt) return <span className="text-xs text-slate-400">Not set</span>;
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className={cn('whitespace-nowrap text-xs', c.overdue ? 'font-medium text-red-700' : 'text-slate-600')}>{formatDateTime(c.dueAt)}</span>
      {c.overdue && <Badge tone="danger">Overdue</Badge>}
    </div>
  );
}

export function ComplaintsListPage() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const [sp, setSp] = useSearchParams();
  const f = filtersFromParams(sp);
  const [search, setSearch] = useState(f.q ?? '');
  const debounced = useDebounced(search, 350);
  const [exporting, setExporting] = useState(false);
  const staff = hasPermission('master.read');
  const source = staff ? 'masters' : 'scoped';

  const update = (patch: Partial<ComplaintFilters>, resetPage = true) => {
    const next = new URLSearchParams(sp);
    for (const [k, val] of Object.entries(patch)) {
      if (val === undefined || val === '' || val === false || val === null) next.delete(k);
      else next.set(k, String(val));
    }
    if (resetPage && !('page' in patch)) next.delete('page');
    setSp(next, { replace: true });
  };

  const effective: ComplaintFilters = { ...f, q: debounced || undefined };
  const params = buildComplaintParams(effective);
  const q = useQuery({
    queryKey: ['complaints', 'list', params],
    queryFn: async () => (await api.get<Paged<ComplaintSummaryDto>>('/complaints', { params })).data,
    placeholderData: keepPreviousData,
  });

  const priorities = useLookup(source, 'priorities');
  const requestTypes = useLookup(source, 'requestTypes');
  const regions = useLookup('masters', 'regions', { enabled: staff });
  const cities = useLookup('masters', 'cities', { parentField: 'regionId', parentId: f.regionId, enabled: staff });
  const sites = useLookup('masters', 'sites', { parentField: 'cityId', parentId: f.cityId, enabled: staff });

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { page: _p, limit: _l, ...exportParams } = params;
      const { blob, filename } = await getBlob('/complaints/export', exportParams);
      downloadBlob(blob, filename);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const columns: Column<ComplaintSummaryDto>[] = [
    {
      key: 'ref',
      header: 'Reference',
      sortKey: 'referenceNo',
      cell: (c) => (
        <Link to={`/complaints/${c.id}`} className="font-mono text-sm font-medium text-royal-700 hover:underline" onClick={(e) => e.stopPropagation()}>
          {c.referenceNo}
        </Link>
      ),
    },
    { key: 'received', header: 'Received', sortKey: 'receivedAt', cell: (c) => <span className="whitespace-nowrap text-xs text-slate-600">{formatDateTime(c.receivedAt)}</span> },
    {
      key: 'customer',
      header: 'Customer',
      sortKey: 'customerName',
      cell: (c) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-navy-900">{c.customerName}</p>
          {c.organizationName && <p className="truncate text-xs text-slate-500">{c.organizationName}</p>}
        </div>
      ),
    },
    {
      key: 'site',
      header: 'Site',
      hideOnMobile: true,
      cell: (c) => (
        <div className="min-w-0">
          <p className="truncate">{c.site?.name}</p>
          <p className="truncate text-xs text-slate-500">{[c.city?.name, c.region?.name].filter(Boolean).join(' · ')}</p>
        </div>
      ),
    },
    { key: 'type', header: 'Request type', hideOnMobile: true, cell: (c) => <span className="text-sm">{c.requestType?.name ?? '—'}</span> },
    { key: 'priority', header: 'Priority', cell: (c) => <PriorityBadge priority={c.priority} /> },
    {
      key: 'status',
      header: 'Status',
      sortKey: 'status',
      cell: (c) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={c.status} label={c.statusLabel} tone={toneOf(c.statusTone)} />
          {c.duplicateOf && <span className="text-xs text-slate-500">of {c.duplicateOf.referenceNo}</span>}
        </div>
      ),
    },
    { key: 'due', header: 'Due', sortKey: 'dueAt', cell: (c) => <DueCell c={c} /> },
    { key: 'sup', header: 'Supervisor', hideOnMobile: true, cell: (c) => <span className="text-sm text-slate-600">{c.supervisor?.name ?? '—'}</span> },
  ];

  const anyExtra = Boolean(f.priorityId || f.requestTypeId || f.regionId || f.receivedFrom || f.receivedTo || f.unclassified || f.q);

  return (
    <div>
      <PageHeader
        title="Complaints"
        description="Complaints within your data access. Status changes go through the configured workflow."
        actions={
          <>
            {hasPermission('complaint.export') && (
              <Button variant="outline" onClick={exportCsv} loading={exporting}>
                <Download className="h-4 w-4" /> Export CSV
              </Button>
            )}
            {hasPermission('complaint.create') && (
              <Button onClick={() => navigate('/complaints/new')}>
                <Plus className="h-4 w-4" /> New complaint
              </Button>
            )}
          </>
        }
      />

      <div className="mb-3 flex max-w-full gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Quick filters">
        {QUICK_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={f.tab === t.key}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
              f.tab === t.key ? 'border-royal-700 text-royal-700' : 'border-transparent text-slate-600 hover:text-navy-900',
            )}
            onClick={() => update({ tab: t.key })}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Card>
        <div className="grid grid-cols-1 gap-2 border-b border-border p-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="relative sm:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input
              aria-label="Search complaints"
              placeholder="Reference, customer, site, email or text"
              className="pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                update({ q: e.target.value || undefined });
              }}
            />
          </div>
          <Select aria-label="Filter by priority" value={f.priorityId ?? ''} onChange={(e) => update({ priorityId: e.target.value || undefined })}>
            <option value="">All priorities</option>
            {priorities.data?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select aria-label="Filter by request type" value={f.requestTypeId ?? ''} onChange={(e) => update({ requestTypeId: e.target.value || undefined })}>
            <option value="">All request types</option>
            {requestTypes.data?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
          {staff && (
            <>
              <Select aria-label="Filter by region" value={f.regionId ?? ''} onChange={(e) => update({ regionId: e.target.value || undefined, cityId: undefined, siteId: undefined })}>
                <option value="">All regions</option>
                {regions.data?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <Select aria-label="Filter by city" value={f.cityId ?? ''} disabled={!f.regionId} onChange={(e) => update({ cityId: e.target.value || undefined, siteId: undefined })}>
                <option value="">{f.regionId ? 'All cities' : 'Select a region first'}</option>
                {cities.data?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <Select aria-label="Filter by site" value={f.siteId ?? ''} disabled={!f.cityId} onChange={(e) => update({ siteId: e.target.value || undefined })}>
                <option value="">{f.cityId ? 'All sites' : 'Select a city first'}</option>
                {sites.data?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </>
          )}
          <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-1">
            <Input type="date" aria-label="Received from" value={f.receivedFrom ?? ''} onChange={(e) => update({ receivedFrom: e.target.value || undefined })} />
            <span className="text-slate-400" aria-hidden>
              –
            </span>
            <Input type="date" aria-label="Received to" value={f.receivedTo ?? ''} onChange={(e) => update({ receivedTo: e.target.value || undefined })} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2 lg:col-span-4">
            {hasPermission('complaint.classify') ? (
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <Checkbox checked={Boolean(f.unclassified)} onCheckedChange={(c) => update({ unclassified: c === true || undefined })} />
                Unclassified only
              </label>
            ) : (
              <span />
            )}
            {anyExtra && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch('');
                  setSp(new URLSearchParams(f.tab !== 'open' ? { tab: f.tab } : {}), { replace: true });
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        </div>
        <DataTable
          caption="Complaints"
          columns={columns}
          rows={q.data?.data}
          rowKey={(c) => c.id}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          sort={f.sort}
          onSortChange={(sort) => update({ sort })}
          page={q.data?.meta.page}
          pages={q.data?.meta.pages}
          total={q.data?.meta.total}
          limit={q.data?.meta.limit}
          onPageChange={(page) => update({ page }, false)}
          onRowClick={(c) => navigate(`/complaints/${c.id}`)}
          emptyTitle={anyExtra || f.tab !== 'all' ? 'No complaints match these filters' : 'No complaints yet'}
          emptyDescription={f.tab === 'open' ? 'Try the "All" tab to include closed, rejected and duplicate complaints.' : undefined}
        />
      </Card>
    </div>
  );
}
