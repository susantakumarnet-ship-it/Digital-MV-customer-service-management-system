import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckCircle2, ClipboardCheck, History, Hourglass, Search } from 'lucide-react';
import { TIME_EVENT_LABELS } from '@mv/shared';
import { Card, CardHeader } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { KpiCard } from '@/components/kpi-card';
import { EmptyState } from '@/components/states';
import { PageHeader } from '@/components/page-header';
import { useAuth } from '@/features/auth/auth-context';
import { useCorrections } from '@/features/visits/visit-lib';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { formatWaiting, useReviewQueue, waitingTone } from './review-lib';
import { QueueRowBadges } from './review-queue-page';

/** Reviewer dashboard (dashboard.reviewer): review KPIs, oldest pending reports and pending time corrections. */
export function ReviewerDashboard() {
  const { hasPermission } = useAuth();
  const canReview = hasPermission('inspection.approve') || hasPermission('inspection.return');
  const pending = useReviewQueue({ status: 'PENDING', limit: 10 }, canReview);
  // Exact counts from the server (not limited to the rows loaded above).
  const summary = useQuery({
    queryKey: ['reviews', 'summary'],
    queryFn: async () =>
      (await api.get<{ pending: number; underReview: number; waitingOver24h: number; waitingOver48h: number; approvedThisWeek: number; approvedTotal: number }>('/reviews/summary')).data,
    enabled: canReview,
    refetchInterval: 60_000,
  });
  const corrections = useCorrections({ status: 'PENDING', limit: 5 }, hasPermission('visit.approveCorrection'));
  const rows = pending.data?.data ?? [];
  const s = summary.data;

  return (
    <div>
      <PageHeader title="Reviewer dashboard" description="Review submitted inspection reports, time logs and corrections." />
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Link to="/reviews" className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-royal-600">
            <KpiCard label="Pending reviews" value={s?.pending ?? 0} loading={summary.isLoading} accent="royal" icon={<ClipboardCheck className="h-5 w-5" />} />
          </Link>
          <Link to="/reviews?tab=review" className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-royal-600">
            <KpiCard label="Under review" value={s?.underReview ?? 0} loading={summary.isLoading} accent="teal" icon={<Search className="h-5 w-5" />} />
          </Link>
          <KpiCard
            label="Waiting > 24 h"
            value={s?.waitingOver24h ?? 0}
            loading={summary.isLoading}
            accent={s?.waitingOver24h ? 'red' : 'slate'}
            hint={s?.waitingOver48h ? `${s.waitingOver48h} over 48 h` : undefined}
            icon={<Hourglass className="h-5 w-5" />}
          />
          <Link to="/reviews?tab=approved" className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-royal-600">
            <KpiCard label="Approved this week" value={s?.approvedThisWeek ?? 0} loading={summary.isLoading} accent="navy" hint={s ? `${s.approvedTotal} in total` : undefined} icon={<CheckCircle2 className="h-5 w-5" />} />
          </Link>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader
              title="Oldest pending reviews"
              actions={
                <Link to="/reviews" className="text-sm font-medium text-royal-700 hover:underline">
                  Open queue
                </Link>
              }
            />
            {pending.isLoading ? (
              <div className="space-y-2 p-5">
                <div className="skeleton h-5" />
                <div className="skeleton h-5" />
              </div>
            ) : !rows.length ? (
              <EmptyState icon={<ClipboardCheck className="h-6 w-6" />} title="Nothing waiting for review" />
            ) : (
              <ul className="divide-y divide-border">
                {rows.map((r) => {
                  const tone = waitingTone(r.waitingHours);
                  return (
                    <li key={r.id}>
                      <Link to={`/reviews/${r.id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-slate-50">
                        <span className="min-w-0">
                          <span className="font-mono font-medium text-royal-700">{r.workOrder.workOrderNo}</span> <span className="text-slate-700">{r.siteName}</span>
                          <span className="block text-xs text-slate-500">
                            {r.template} · {r.submittedByName} · {r.submittedAt ? formatDateTime(r.submittedAt) : ''}
                          </span>
                          <QueueRowBadges r={r} />
                        </span>
                        <span className={cn('text-xs font-medium', tone === 'danger' ? 'text-red-700' : tone === 'warning' ? 'text-amber-700' : 'text-slate-500')}>
                          {formatWaiting(r.waitingHours)}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader
              title="Pending time corrections"
              actions={
                hasPermission('visit.approveCorrection') ? (
                  <Link to="/time-corrections" className="text-sm font-medium text-royal-700 hover:underline">
                    View all
                  </Link>
                ) : undefined
              }
            />
            {!corrections.data?.data.length ? (
              <EmptyState icon={<History className="h-6 w-6" />} title="No pending corrections" />
            ) : (
              <ul className="divide-y divide-border">
                {corrections.data.data.map((c) => (
                  <li key={c.id}>
                    <Link to={`/visits/${c.visitId}`} className="flex items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-slate-50">
                      <span>
                        {c.engineer.name} · {TIME_EVENT_LABELS[c.eventType]}
                        <span className="block text-xs text-slate-500">{c.reason}</span>
                      </span>
                      <StatusBadge status="PENDING" label="Pending" tone="warning" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
