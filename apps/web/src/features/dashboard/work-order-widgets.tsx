import { useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, isSameDay, startOfDay } from 'date-fns';
import { AlertTriangle, CalendarClock, CheckCircle2, ClipboardCheck, FolderOpen, Hourglass, Inbox, Wrench } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import type { Paged, WorkOrderSummaryDto } from '@mv/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge, StatusBadge, toneOf } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KpiCard } from '@/components/kpi-card';
import { EmptyState, ErrorState } from '@/components/states';
import { useAuth } from '@/features/auth/auth-context';
import { DueCell, PriorityBadge } from '@/features/complaints/complaints-list-page';
import { useWorkload, weekStart, type WorkOrderKpis } from '@/features/work-orders/wo-lib';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const CHART = { royal: '#1d4ed8', grid: '#e2e8f0', axis: '#64748b' };
const TONE_FILL: Record<string, string> = { danger: '#dc2626', warning: '#d97706', info: '#0284c7', neutral: '#64748b', primary: '#1d4ed8', success: '#059669', accent: '#0d9488' };

type WoKpiKey = 'open' | 'unassigned' | 'awaitingAcceptance' | 'inProgress' | 'overdue' | 'total';
const WO_KPIS: Record<WoKpiKey, { label: string; icon: ReactElement; accent: 'navy' | 'royal' | 'teal' | 'amber' | 'red' | 'slate'; link: string }> = {
  total: { label: 'Total work orders', icon: <Wrench className="h-5 w-5" />, accent: 'navy', link: '/work-orders?tab=all' },
  open: { label: 'Open work orders', icon: <FolderOpen className="h-5 w-5" />, accent: 'navy', link: '/work-orders?tab=active' },
  unassigned: { label: 'Unassigned', icon: <Inbox className="h-5 w-5" />, accent: 'amber', link: '/work-orders?tab=unassigned' },
  awaitingAcceptance: { label: 'Awaiting acceptance', icon: <Hourglass className="h-5 w-5" />, accent: 'royal', link: '/work-orders?tab=awaiting' },
  inProgress: { label: 'In progress', icon: <ClipboardCheck className="h-5 w-5" />, accent: 'teal', link: '/work-orders?tab=inProgress' },
  overdue: { label: 'Overdue work orders', icon: <AlertTriangle className="h-5 w-5" />, accent: 'red', link: '/work-orders?tab=overdue' },
};

export function WorkOrderKpiGrid({ data, loading, keys }: { data?: WorkOrderKpis; loading: boolean; keys: WoKpiKey[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
      {keys.map((k) => {
        const d = WO_KPIS[k];
        const value = data?.[k];
        const accent = k === 'overdue' && value === 0 ? 'slate' : d.accent;
        return (
          <Link key={k} to={d.link} className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-royal-600" aria-label={`${d.label}: ${value ?? ''}`}>
            <KpiCard label={d.label} value={value} loading={loading} icon={d.icon} accent={accent} />
          </Link>
        );
      })}
    </div>
  );
}

function ChartBox({ title, description, loading, empty, label, children }: { title: string; description?: string; loading: boolean; empty: boolean; label: string; children: ReactElement }) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <CardBody>
        {loading ? (
          <div className="skeleton h-64 w-full" />
        ) : empty ? (
          <EmptyState title="No work orders yet" />
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

/** "Work orders by engineer" and "by status" charts (BRF §6). */
export function WorkOrderCharts({ data, loading }: { data?: WorkOrderKpis; loading: boolean }) {
  const axis = { fill: CHART.axis, fontSize: 12 };
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <ChartBox title="Work orders by engineer" description="Active (not closed or cancelled)" loading={loading} empty={!data?.byEngineer.length} label="Bar chart of active work orders per engineer">
        <BarChart data={data?.byEngineer} layout="vertical" margin={{ left: 8, right: 16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} horizontal={false} />
          <XAxis type="number" allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey="engineer" width={120} tick={axis} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: '#f1f5f9' }} />
          <Bar dataKey="count" name="Work orders" fill={CHART.royal} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ChartBox>
      <ChartBox title="Work orders by status" loading={loading} empty={!data?.statuses.length} label="Bar chart of work orders per status">
        <BarChart data={data?.statuses.map((s) => ({ status: s.label, count: s.count, tone: s.tone }))} layout="vertical" margin={{ left: 8, right: 16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} horizontal={false} />
          <XAxis type="number" allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey="status" width={120} tick={axis} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: '#f1f5f9' }} />
          <Bar dataKey="count" name="Work orders" radius={[0, 4, 4, 0]}>
            {data?.statuses.map((s) => <Cell key={s.key} fill={TONE_FILL[s.tone] ?? CHART.royal} />)}
          </Bar>
        </BarChart>
      </ChartBox>
    </div>
  );
}

/** Team workload for the current week (supervisor dashboard). */
export function TeamWorkloadCard() {
  const from = weekStart(new Date());
  const q = useWorkload({ from, to: addDays(from, 7) });
  return (
    <Card>
      <CardHeader
        title="Team workload this week"
        actions={
          <Link to="/work-orders/board" className="text-sm font-medium text-royal-700 hover:underline">
            Open assignment board
          </Link>
        }
      />
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <div className="space-y-2 p-5">
          <div className="skeleton h-5" />
          <div className="skeleton h-5" />
        </div>
      ) : !q.data?.length ? (
        <EmptyState title="No field engineers" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Engineer workload this week</caption>
            <thead className="border-b border-border bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2 text-left">Engineer</th>
                <th scope="col" className="px-3 py-2 text-right">Active</th>
                <th scope="col" className="px-3 py-2 text-right">Visits this week</th>
                <th scope="col" className="px-3 py-2 text-right">Overdue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {q.data.map((e) => (
                <tr key={e.id}>
                  <td className="px-4 py-2 text-navy-900">{e.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{e.activeWorkOrders}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{e.plannedInRange}</td>
                  <td className={cn('px-3 py-2 text-right tabular-nums', e.overdue > 0 && 'font-semibold text-red-700')}>{e.overdue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function WoRow({ w, action }: { w: WorkOrderSummaryDto; action?: ReactElement }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 px-5 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/work-orders/${w.id}`} className="font-mono text-sm font-medium text-royal-700 hover:underline">
            {w.workOrderNo}
          </Link>
          <StatusBadge status={w.status} label={w.statusLabel} tone={toneOf(w.statusTone)} />
          <PriorityBadge priority={w.priority} />
        </div>
        <p className="truncate text-sm text-slate-700">{w.title}</p>
        <p className="text-xs text-slate-500">
          {w.site?.name}
          {w.plannedVisitAt ? ` · planned ${formatDateTime(w.plannedVisitAt)}` : ' · not planned yet'}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1">
        <DueCell c={w} />
        {action}
      </div>
    </li>
  );
}

function ListCard({ title, description, rows, empty, loading, children }: { title: string; description?: string; rows: WorkOrderSummaryDto[]; empty: string; loading: boolean; children?: (w: WorkOrderSummaryDto) => ReactElement | undefined }) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      {loading ? (
        <div className="space-y-2 p-5">
          <div className="skeleton h-5" />
          <div className="skeleton h-5" />
        </div>
      ) : !rows.length ? (
        <EmptyState title={empty} />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((w) => (
            <WoRow key={w.id} w={w} action={children?.(w)} />
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Engineer dashboard (BRF §10): my jobs, acceptance, today's and upcoming visits, overdue. */
export function EngineerDashboardWidgets() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [accepting, setAccepting] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['work-orders', 'engineer', 'active'],
    queryFn: async () => (await api.get<Paged<WorkOrderSummaryDto>>('/engineer/work-orders', { params: { status: 'ACTIVE', limit: 100, sort: 'plannedVisitAt' } })).data,
    refetchInterval: 60_000,
  });
  const rows = useMemo(() => q.data?.data ?? [], [q.data]);
  const today = startOfDay(new Date());
  const in7 = addDays(today, 8);
  const mine = (w: WorkOrderSummaryDto) => w.assignees.find((a) => a.id === user?.id);
  const awaiting = rows.filter((w) => ['ASSIGNED', 'ACCEPTED', 'SCHEDULED'].includes(w.status) && mine(w) && !mine(w)!.accepted);
  const todays = rows.filter((w) => w.plannedVisitAt && isSameDay(new Date(w.plannedVisitAt), today));
  const upcoming = rows.filter((w) => w.plannedVisitAt && new Date(w.plannedVisitAt) >= addDays(today, 1) && new Date(w.plannedVisitAt) < in7);
  const overdue = rows.filter((w) => w.overdue);

  const accept = async (w: WorkOrderSummaryDto) => {
    setAccepting(w.id);
    try {
      await api.post(`/work-orders/${w.id}/transitions`, { action: 'accept' });
      toast.success(`${w.workOrderNo} accepted`);
      void qc.invalidateQueries({ queryKey: ['work-orders'] });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAccepting(null);
    }
  };

  if (q.isError) {
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="My active work orders" value={rows.length} loading={q.isLoading} icon={<Wrench className="h-5 w-5" />} />
        <KpiCard label="Awaiting my acceptance" value={awaiting.length} loading={q.isLoading} accent="amber" icon={<Hourglass className="h-5 w-5" />} />
        <KpiCard label="Work planned today" value={todays.length} loading={q.isLoading} accent="teal" icon={<CalendarClock className="h-5 w-5" />} />
        <KpiCard label="Overdue" value={overdue.length} loading={q.isLoading} accent={overdue.length ? 'red' : 'slate'} icon={<AlertTriangle className="h-5 w-5" />} />
      </div>
      <ListCard title="Awaiting my acceptance" description="Accept new work so your supervisor knows it is planned." rows={awaiting} empty="Nothing to accept" loading={q.isLoading}>
        {(w) => (
          <Button size="sm" variant="accent" loading={accepting === w.id} onClick={() => accept(w)}>
            <CheckCircle2 className="h-4 w-4" /> Accept
          </Button>
        )}
      </ListCard>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ListCard title="Work orders planned today" rows={todays} empty="No work orders planned today" loading={q.isLoading} />
        <ListCard title="Upcoming work orders" description="Planned in the next 7 days" rows={upcoming} empty="No work orders planned in the next 7 days" loading={q.isLoading} />
      </div>
      <ListCard title="Overdue work orders" rows={overdue} empty="No overdue work" loading={q.isLoading} />
      <div className="flex justify-end">
        <Link to="/work-orders" className="text-sm font-medium text-royal-700 hover:underline">
          All my work orders
        </Link>
      </div>
      <Card>
        <CardHeader title="Coming to this dashboard" />
        <ul className="space-y-2 px-5 py-4">
          {[
            { label: 'Returned reports awaiting correction', phase: 6 },
            { label: 'Material requests', phase: 7 },
          ].map((u) => (
            <li key={u.label} className="flex items-start gap-2 text-sm text-slate-700">
              <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" aria-hidden />
              <span className="flex-1">{u.label}</span>
              <Badge tone="neutral">Phase {u.phase}</Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
