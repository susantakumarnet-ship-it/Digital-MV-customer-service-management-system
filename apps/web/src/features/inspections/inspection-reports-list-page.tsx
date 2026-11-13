import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Paged } from '@mv/shared';
import { Card } from '@/components/ui/card';
import { StatusBadge, toneOf } from '@/components/ui/badge';
import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Row shape of GET /inspection-reports (inspection.service listReports). */
export interface ReportListRow {
  id: string;
  revisionNo: number;
  status: string;
  statusLabel: string;
  statusTone: string;
  visit: { id: string; visitNo: string };
  workOrder: { id: string; workOrderNo: string };
  complaint: { id: string; referenceNo: string };
  siteName?: string;
  template: string;
  submittedAt?: string | null;
  submittedByName?: string;
  updatedAt: string;
}

export function useReports(params: Record<string, string | number | undefined>, enabled = true) {
  return useQuery({
    queryKey: ['inspection-reports', 'list', params],
    queryFn: async () => (await api.get<Paged<ReportListRow>>('/inspection-reports', { params })).data,
    enabled,
  });
}

const TABS = [
  { key: 'all', label: 'All', status: undefined },
  { key: 'draft', label: 'Draft', status: 'DRAFT' },
  { key: 'submitted', label: 'Submitted', status: 'SUBMITTED' },
  { key: 'review', label: 'Under review', status: 'UNDER_REVIEW' },
  { key: 'returned', label: 'Returned', status: 'RETURNED' },
  { key: 'approved', label: 'Approved', status: 'APPROVED' },
] as const;

export function InspectionReportsListPage() {
  const [sp, setSp] = useSearchParams();
  const tab = TABS.find((t) => t.key === sp.get('tab')) ?? TABS[0];
  const page = Number(sp.get('page') ?? 1) || 1;
  const q = useReports({ status: tab.status, page, limit: 20 });
  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setSp(next, { replace: true });
  };
  const columns: Column<ReportListRow>[] = [
    {
      key: 'report',
      header: 'Report',
      cell: (r) => (
        <Link to={`/inspection-reports/${r.id}`} className="font-medium text-royal-700 hover:underline">
          {r.visit.visitNo} · rev {r.revisionNo}
        </Link>
      ),
    },
    {
      key: 'wo',
      header: 'Work order / complaint',
      cell: (r) => (
        <div className="text-sm">
          <Link to={`/work-orders/${r.workOrder.id}`} className="font-mono text-royal-700 hover:underline">
            {r.workOrder.workOrderNo}
          </Link>
          <Link to={`/complaints/${r.complaint.id}`} className="block font-mono text-xs text-slate-500 hover:underline">
            {r.complaint.referenceNo}
          </Link>
        </div>
      ),
    },
    { key: 'site', header: 'Site', cell: (r) => r.siteName ?? '—', hideOnMobile: true },
    { key: 'template', header: 'Checklist', cell: (r) => r.template, hideOnMobile: true },
    { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} label={r.statusLabel} tone={toneOf(r.statusTone)} /> },
    { key: 'submitted', header: 'Submitted', cell: (r) => (r.submittedAt ? `${formatDateTime(r.submittedAt)}${r.submittedByName ? ` · ${r.submittedByName}` : ''}` : '—') },
  ];
  return (
    <div>
      <PageHeader title="Inspection reports" description="Checklist reports from site visits. Submitted revisions are read-only." />
      <div className="mb-3 flex max-w-full gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Report status">
        {TABS.map((t) => (
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
      <Card>
        <DataTable
          columns={columns}
          rows={q.data?.data}
          rowKey={(r) => r.id}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          page={q.data?.meta.page}
          pages={q.data?.meta.pages}
          total={q.data?.meta.total}
          limit={q.data?.meta.limit}
          onPageChange={(p) => set({ page: String(p) })}
          emptyTitle="No inspection reports"
          caption="Inspection reports"
        />
      </Card>
    </div>
  );
}
