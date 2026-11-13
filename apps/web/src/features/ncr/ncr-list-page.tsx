import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { NcrSummaryDto } from '@mv/shared';
import { Card } from '@/components/ui/card';
import { Badge, StatusBadge, toneOf } from '@/components/ui/badge';
import { Input, Select } from '@/components/ui/form';
import { Checkbox } from '@/components/ui/controls';
import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { formatDate } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { cn } from '@/lib/utils';
import { buildNcrParams, severityTone, useNcrLists, useNcrs } from './ncr-lib';
import { NcrKpiGrid } from './ncr-panels';

const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'OPEN', label: 'Open (not verified/closed)' },
  { value: 'ASSIGNED', label: 'Assigned' },
  { value: 'ACTION_IN_PROGRESS', label: 'Action in progress' },
  { value: 'SUBMITTED_FOR_VERIFICATION', label: 'Submitted for verification' },
  { value: 'RETURNED', label: 'Returned' },
  { value: 'VERIFIED', label: 'Verified' },
  { value: 'CLOSED', label: 'Closed' },
];

/** NCR register (NCR-05): filter by status, severity, category, owner and overdue. */
export function NcrListPage() {
  const [sp, setSp] = useSearchParams();
  const update = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setSp(next, { replace: true });
  };
  const lists = useNcrLists();
  const [search, setSearch] = useState(sp.get('q') ?? '');
  const q = useDebounced(search, 300);
  const status = sp.get('status') ?? '';
  const severity = sp.get('severity') ?? '';
  const category = sp.get('category') ?? '';
  const mine = sp.get('mine') === 'true';
  const overdue = sp.get('overdue') === 'true';
  const page = Number(sp.get('page') ?? 1) || 1;
  const sort = sp.get('sort') ?? '-createdAt';
  const list = useNcrs(buildNcrParams({ status, severity, category, mine, overdue, q, page, sort }));

  const columns: Column<NcrSummaryDto>[] = [
    {
      key: 'ncrNo',
      header: 'NCR',
      sortKey: 'ncrNo',
      cell: (n) => (
        <div className="min-w-0">
          <Link to={`/ncrs/${n.id}`} className="font-mono font-medium text-royal-700 hover:underline">
            {n.ncrNo}
          </Link>
          <p className="max-w-xs truncate text-xs text-slate-600">{n.title}</p>
        </div>
      ),
    },
    {
      key: 'complaint',
      header: 'Complaint',
      cell: (n) => (
        <Link to={`/complaints/${n.complaint.id}`} className="font-mono text-sm text-royal-700 hover:underline">
          {n.complaint.referenceNo}
        </Link>
      ),
    },
    {
      key: 'wo',
      header: 'Work order',
      hideOnMobile: true,
      cell: (n) =>
        n.workOrder ? (
          <Link to={`/work-orders/${n.workOrder.id}`} className="font-mono text-sm text-royal-700 hover:underline">
            {n.workOrder.workOrderNo}
          </Link>
        ) : (
          '—'
        ),
    },
    { key: 'severity', header: 'Severity', sortKey: 'severity', cell: (n) => <Badge tone={severityTone(n.severity)}>{n.severity}</Badge> },
    { key: 'status', header: 'Status', cell: (n) => <StatusBadge status={n.status} label={n.statusLabel} tone={toneOf(n.statusTone)} /> },
    { key: 'owner', header: 'Owner', hideOnMobile: true, cell: (n) => n.owner?.name ?? <span className="text-slate-500">Unassigned</span> },
    {
      key: 'dueAt',
      header: 'Due',
      sortKey: 'dueAt',
      cell: (n) => (n.dueAt ? <span className={cn(n.overdue && 'font-medium text-red-700')}>{formatDate(n.dueAt)}{n.overdue ? ' · overdue' : ''}</span> : '—'),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Non-conformance reports" description="Raise, assign, correct and verify non-conformances found during service work." />
      <NcrKpiGrid />
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search NCRs"
          placeholder="Search NCR, title, complaint or work order"
          className="max-w-xs"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            update({ q: e.target.value || undefined, page: undefined });
          }}
        />
        <Select aria-label="Status" className="max-w-56" value={status} onChange={(e) => update({ status: e.target.value || undefined, page: undefined })}>
          {STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
        <Select aria-label="Severity" className="max-w-40" value={severity} onChange={(e) => update({ severity: e.target.value || undefined, page: undefined })}>
          <option value="">All severities</option>
          {lists.severities.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Select aria-label="Category" className="max-w-56" value={category} onChange={(e) => update({ category: e.target.value || undefined, page: undefined })}>
          <option value="">All categories</option>
          {lists.categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <Checkbox checked={mine} onCheckedChange={(c) => update({ mine: c === true ? 'true' : undefined, page: undefined })} />
          Assigned to me
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <Checkbox checked={overdue} onCheckedChange={(c) => update({ overdue: c === true ? 'true' : undefined, page: undefined })} />
          Overdue only
        </label>
      </div>
      <Card>
        <DataTable
          columns={columns}
          rows={list.data?.data}
          rowKey={(n) => n.id}
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
          emptyTitle="No NCRs"
          emptyDescription="Nothing matches these filters."
          caption="Non-conformance reports"
        />
      </Card>
    </div>
  );
}
