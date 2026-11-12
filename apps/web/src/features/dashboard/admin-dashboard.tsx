import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, KeyRound, Lock, ShieldCheck, UserCheck, UserPlus, Users } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { KpiCard } from '@/components/kpi-card';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState } from '@/components/states';
import { api } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/format';
import type { AdminDashboardDto } from '@/lib/types';
import { humanize } from '@/lib/utils';
import { useAuth } from '@/features/auth/auth-context';
import { useComplaintSummary } from '@/features/complaints/complaint-lib';
import { ComplaintCharts, ComplaintKpiGrid } from './complaint-widgets';

const CHART = { navy: '#0b1f4b', royal: '#1d4ed8', teal: '#0d9488', red: '#dc2626', grid: '#e2e8f0', axis: '#64748b' };

const OPERATIONAL: { key: keyof AdminDashboardDto['operational']; label: string; phase: number }[] = [
  { key: 'workOrders', label: 'Work orders', phase: 4 },
  { key: 'materialRequests', label: 'Material requests', phase: 7 },
  { key: 'ncrs', label: 'NCRs', phase: 8 },
];

export function AdminDashboard() {
  const q = useQuery({
    queryKey: ['dashboard', 'admin'],
    queryFn: async () => (await api.get<AdminDashboardDto>('/dashboard/admin')).data,
    refetchInterval: 60_000,
  });
  const d = q.data;
  const { hasPermission } = useAuth();
  const canComplaints = hasPermission('complaint.read');
  const summary = useComplaintSummary(canComplaints);

  return (
    <div>
      <PageHeader
        title="Administrator dashboard"
        description="Complaint KPIs, platform health, access and configuration. Service KPIs appear here as each module goes live."
      />
      {canComplaints && (
        <section className="mb-6 space-y-4" aria-labelledby="complaints-heading">
          <h2 id="complaints-heading" className="text-base font-semibold text-navy-900">
            Complaints
          </h2>
          {summary.isError ? (
            <Card>
              <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
            </Card>
          ) : (
            <>
              <ComplaintKpiGrid data={summary.data} loading={summary.isLoading} keys={['total', 'new', 'open', 'awaitingCustomer', 'overdue', 'receivedToday']} />
              <ComplaintCharts data={summary.data} loading={summary.isLoading} />
            </>
          )}
          <h2 className="pt-2 text-base font-semibold text-navy-900">Platform</h2>
        </section>
      )}
      {q.isError ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Users" value={d?.users.total} loading={q.isLoading} icon={<Users className="h-5 w-5" />} hint={d ? `${d.users.inactive} inactive` : undefined} />
            <KpiCard label="Active users" value={d?.users.active} loading={q.isLoading} accent="teal" icon={<UserCheck className="h-5 w-5" />} />
            <KpiCard label="Pending activation" value={d?.users.pendingActivation} loading={q.isLoading} accent="amber" icon={<UserPlus className="h-5 w-5" />} />
            <KpiCard label="Locked accounts" value={d?.users.locked} loading={q.isLoading} accent="red" icon={<Lock className="h-5 w-5" />} />
            <KpiCard label="Active sessions (24h)" value={d?.activeSessions24h} loading={q.isLoading} accent="royal" icon={<Activity className="h-5 w-5" />} />
            <KpiCard label="Active roles" value={d?.roles} loading={q.isLoading} accent="slate" icon={<ShieldCheck className="h-5 w-5" />} />
            <KpiCard
              label="Failed sign-ins (24h)"
              value={d?.loginFailures24h}
              loading={q.isLoading}
              accent={d && d.loginFailures24h > 0 ? 'red' : 'slate'}
              icon={<KeyRound className="h-5 w-5" />}
            />
            <OperationalCard data={d?.operational} loading={q.isLoading} />
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader title="Sign-in activity" description="Successful vs failed sign-ins, last 7 days" />
              <CardBody>
                {q.isLoading ? (
                  <div className="skeleton h-64 w-full" />
                ) : (
                  <div className="h-64" role="img" aria-label="Bar chart of sign-ins per day">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={d?.loginTrend.map((x) => ({ ...x, label: x.day.slice(5) }))} margin={{ left: -16, right: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
                        <XAxis dataKey="label" tick={{ fill: CHART.axis, fontSize: 12 }} tickLine={false} axisLine={false} />
                        <YAxis allowDecimals={false} tick={{ fill: CHART.axis, fontSize: 12 }} tickLine={false} axisLine={false} />
                        <Tooltip cursor={{ fill: '#f1f5f9' }} />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar dataKey="success" name="Successful" fill={CHART.teal} radius={[4, 4, 0, 0]} />
                        <Bar dataKey="failure" name="Failed" fill={CHART.red} radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Users by role" description="Active and pending accounts" />
              <CardBody>
                {q.isLoading ? (
                  <div className="skeleton h-64 w-full" />
                ) : !d?.roleDistribution.length ? (
                  <EmptyState title="No role assignments yet" />
                ) : (
                  <div className="h-64" role="img" aria-label="Bar chart of users per role">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={d.roleDistribution} layout="vertical" margin={{ left: 8, right: 16 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} horizontal={false} />
                        <XAxis type="number" allowDecimals={false} tick={{ fill: CHART.axis, fontSize: 12 }} tickLine={false} axisLine={false} />
                        <YAxis type="category" dataKey="role" width={140} tick={{ fill: CHART.axis, fontSize: 12 }} tickLine={false} axisLine={false} />
                        <Tooltip cursor={{ fill: '#f1f5f9' }} />
                        <Bar dataKey="users" name="Users" fill={CHART.royal} radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardBody>
            </Card>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-5">
            <Card className="xl:col-span-2">
              <CardHeader title="Master data" actions={<Link to="/admin/masters" className="text-sm font-medium text-royal-700 hover:underline">Manage</Link>} />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-5 py-2 font-semibold">Type</th>
                      <th className="px-5 py-2 text-right font-semibold">Active</th>
                      <th className="px-5 py-2 text-right font-semibold">Inactive</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {q.isLoading
                      ? Array.from({ length: 6 }).map((_, i) => (
                          <tr key={i}>
                            <td className="px-5 py-2" colSpan={3}>
                              <div className="skeleton h-4" />
                            </td>
                          </tr>
                        ))
                      : d?.masterData.map((m) => (
                          <tr key={m.key}>
                            <td className="px-5 py-2">
                              <Link to={`/admin/masters/${m.key}`} className="hover:text-royal-700 hover:underline">
                                {m.label}
                              </Link>
                            </td>
                            <td className="px-5 py-2 text-right tabular-nums">{m.active}</td>
                            <td className="px-5 py-2 text-right tabular-nums text-slate-500">{m.inactive}</td>
                          </tr>
                        ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card className="xl:col-span-3">
              <CardHeader title="Recent activity" actions={<Link to="/admin/audit" className="text-sm font-medium text-royal-700 hover:underline">Audit log</Link>} />
              {q.isLoading ? (
                <div className="space-y-3 p-5">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="skeleton h-4" />
                  ))}
                </div>
              ) : !d?.recentEvents.length ? (
                <EmptyState title="No activity recorded yet" />
              ) : (
                <ul className="divide-y divide-border">
                  {d.recentEvents.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm">
                      {e.outcome === 'FAILURE' ? (
                        <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" aria-label="Failure" />
                      ) : (
                        <span className="h-2 w-2 shrink-0 rounded-full bg-teal-500" aria-hidden />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="font-medium text-navy-900">{e.actorName}</span> <span className="text-slate-600">{humanize(e.action)}</span>
                        {e.entityRef && <span className="text-slate-500"> · {e.entityRef}</span>}
                      </span>
                      <time className="text-xs text-slate-400" dateTime={e.timestamp} title={formatDateTime(e.timestamp)}>
                        {timeAgo(e.timestamp)}
                      </time>
                      {e.outcome === 'FAILURE' && <StatusBadge status="FAILURE" />}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function OperationalCard({ data, loading }: { data?: AdminDashboardDto['operational']; loading: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Operational modules</p>
      {loading ? (
        <div className="mt-2 space-y-2">
          <div className="skeleton h-3" />
          <div className="skeleton h-3" />
        </div>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {OPERATIONAL.map((o) => {
            const v = data?.[o.key];
            return (
              <li key={o.key} className="flex justify-between gap-2">
                <span className="text-slate-600">{o.label}</span>
                {v === null || v === undefined ? (
                  <span className="text-xs text-slate-400">Arrives in Phase {o.phase}</span>
                ) : (
                  <span className="font-semibold tabular-nums text-navy-900">{v}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
