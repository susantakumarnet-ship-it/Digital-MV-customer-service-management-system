import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarPlus, ClipboardList, FolderOpen, Hourglass, Inbox, ListChecks, Tags } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ComplaintSummaryDto, Paged } from '@mv/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { StatusBadge, toneOf } from '@/components/ui/badge';
import { KpiCard } from '@/components/kpi-card';
import { EmptyState, ErrorState } from '@/components/states';
import { api } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/format';
import { DueCell, PriorityBadge } from '@/features/complaints/complaints-list-page';
import type { ComplaintKpis } from '@/features/complaints/complaint-lib';

const CHART = { navy: '#0b1f4b', royal: '#1d4ed8', teal: '#0d9488', grid: '#e2e8f0', axis: '#64748b' };
const TONE_FILL: Record<string, string> = { danger: '#dc2626', warning: '#d97706', info: '#0284c7', neutral: '#64748b', primary: '#1d4ed8', success: '#059669', accent: '#0d9488' };

type KpiKey = 'total' | 'receivedToday' | 'new' | 'open' | 'awaitingCustomer' | 'overdue' | 'unclassified' | 'underReview';
const KPI_DEFS: Record<KpiKey, { label: string; icon: ReactElement; accent: 'navy' | 'royal' | 'teal' | 'amber' | 'red' | 'slate'; link?: string }> = {
  total: { label: 'Total complaints', icon: <ClipboardList className="h-5 w-5" />, accent: 'navy', link: '/complaints?tab=all' },
  receivedToday: { label: 'Received today', icon: <CalendarPlus className="h-5 w-5" />, accent: 'teal' },
  new: { label: 'New', icon: <Inbox className="h-5 w-5" />, accent: 'royal', link: '/complaints?tab=new' },
  open: { label: 'Open', icon: <FolderOpen className="h-5 w-5" />, accent: 'navy', link: '/complaints?tab=open' },
  awaitingCustomer: { label: 'Awaiting customer', icon: <Hourglass className="h-5 w-5" />, accent: 'amber', link: '/complaints?tab=awaiting' },
  overdue: { label: 'Overdue', icon: <AlertTriangle className="h-5 w-5" />, accent: 'red', link: '/complaints?tab=overdue' },
  unclassified: { label: 'Unclassified', icon: <Tags className="h-5 w-5" />, accent: 'slate', link: '/complaints?tab=open&unclassified=true' },
  underReview: { label: 'Under review', icon: <ListChecks className="h-5 w-5" />, accent: 'royal', link: '/complaints?tab=review' },
};

/** KPI cards computed from live data (GET /complaints/summary). */
export function ComplaintKpiGrid({ data, loading, keys }: { data?: ComplaintKpis; loading: boolean; keys: KpiKey[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      {keys.map((k) => {
        const d = KPI_DEFS[k];
        const value = data?.[k];
        const accent = k === 'overdue' && value === 0 ? 'slate' : d.accent;
        const card = <KpiCard label={d.label} value={value} loading={loading} icon={d.icon} accent={accent} />;
        return d.link ? (
          <Link key={k} to={d.link} className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-royal-600" aria-label={`${d.label}: ${value ?? ''}`}>
            {card}
          </Link>
        ) : (
          <div key={k}>{card}</div>
        );
      })}
    </div>
  );
}

function ChartCard({ title, description, loading, empty, children, label }: { title: string; description?: string; loading: boolean; empty: boolean; children: ReactElement; label: string }) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <CardBody>
        {loading ? (
          <div className="skeleton h-64 w-full" />
        ) : empty ? (
          <EmptyState title="No complaints yet" />
        ) : (
          <div className="h-64" role="img" aria-label={label}>
            <ResponsiveContainer width="100%" height="100%">
              {children}
            </ResponsiveContainer>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** Complaints by month / status / priority / region (BRF §6 charts). */
export function ComplaintCharts({ data, loading }: { data?: ComplaintKpis; loading: boolean }) {
  const empty = !data || data.total === 0;
  // Uses the admin-configured status labels (D-01).
  const byStatus = (data?.statuses ?? []).map((s) => ({ status: s.label, count: s.count })).sort((a, b) => b.count - a.count);
  const axis = { fill: CHART.axis, fontSize: 12 };
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <ChartCard title="Complaints by month" description="Last 12 months" loading={loading} empty={empty} label="Bar chart of complaints received per month">
        <BarChart data={data?.byMonth.map((m) => ({ ...m, label: m.month.slice(2) }))} margin={{ left: -16, right: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: '#f1f5f9' }} />
          <Bar dataKey="count" name="Complaints" fill={CHART.royal} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartCard>
      <ChartCard title="Complaints by status" loading={loading} empty={empty} label="Bar chart of complaints per status">
        <BarChart data={byStatus} layout="vertical" margin={{ left: 8, right: 16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} horizontal={false} />
          <XAxis type="number" allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey="status" width={150} tick={axis} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: '#f1f5f9' }} />
          <Bar dataKey="count" name="Complaints" fill={CHART.navy} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ChartCard>
      <ChartCard title="Complaints by priority" loading={loading} empty={empty} label="Bar chart of complaints per priority">
        <BarChart data={data?.byPriority} margin={{ left: -16, right: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="priority" tick={axis} tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: '#f1f5f9' }} />
          <Bar dataKey="count" name="Complaints" radius={[4, 4, 0, 0]}>
            {data?.byPriority.map((p) => <Cell key={p.priority} fill={TONE_FILL[p.tone] ?? CHART.navy} />)}
          </Bar>
        </BarChart>
      </ChartCard>
      <ChartCard title="Complaints by region" loading={loading} empty={empty} label="Bar chart of complaints per region">
        <BarChart data={data?.byRegion} layout="vertical" margin={{ left: 8, right: 16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} horizontal={false} />
          <XAxis type="number" allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey="region" width={120} tick={axis} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: '#f1f5f9' }} />
          <Bar dataKey="count" name="Complaints" fill={CHART.teal} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ChartCard>
    </div>
  );
}

/** Compact complaint list for dashboards (queue, overdue, customer view). */
export function ComplaintMiniList({
  title,
  description,
  params,
  emptyTitle,
  viewAllLink,
  highlightAwaiting,
}: {
  title: string;
  description?: string;
  params: Record<string, string | number>;
  emptyTitle: string;
  viewAllLink: string;
  highlightAwaiting?: boolean;
}) {
  const q = useQuery({
    queryKey: ['complaints', 'list', { mini: title, ...params }],
    queryFn: async () => (await api.get<Paged<ComplaintSummaryDto>>('/complaints', { params: { limit: 8, ...params } })).data,
    refetchInterval: 60_000,
  });
  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        actions={
          <Link to={viewAllLink} className="text-sm font-medium text-royal-700 hover:underline">
            View all
          </Link>
        }
      />
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <div className="space-y-3 p-5">
          <div className="skeleton h-4" />
          <div className="skeleton h-4" />
          <div className="skeleton h-4" />
        </div>
      ) : !q.data?.data.length ? (
        <EmptyState title={emptyTitle} />
      ) : (
        <ul className="divide-y divide-border">
          {q.data.data.map((c) => (
            <li key={c.id} className={highlightAwaiting && c.status === 'AWAITING_CUSTOMER_INFO' ? 'bg-amber-50' : undefined}>
              <Link to={`/complaints/${c.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm hover:bg-slate-50">
                <span className="font-mono font-medium text-royal-700">{c.referenceNo}</span>
                <StatusBadge status={c.status} label={c.statusLabel} tone={toneOf(c.statusTone)} />
                <PriorityBadge priority={c.priority} />
                <span className="min-w-0 flex-1 truncate text-slate-600">
                  {c.customerName} · {c.site?.name}
                </span>
                <span className="flex items-center gap-3">
                  {c.dueAt ? <DueCell c={c} /> : <time className="text-xs text-slate-400" title={formatDateTime(c.receivedAt)}>{timeAgo(c.receivedAt)}</time>}
                </span>
                {highlightAwaiting && c.status === 'AWAITING_CUSTOMER_INFO' && <span className="w-full text-xs font-medium text-amber-800">Your information is needed</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
