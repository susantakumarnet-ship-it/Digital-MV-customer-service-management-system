import { Link } from 'react-router-dom';
import { addDays, endOfDay, startOfDay } from 'date-fns';
import { Boxes, ClipboardCheck, FileWarning, History, MapPinned, Timer } from 'lucide-react';
import { TIME_EVENT_LABELS, type VisitSummaryDto } from '@mv/shared';
import { Card, CardHeader } from '@/components/ui/card';
import { StatusBadge, toneOf } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { KpiCard } from '@/components/kpi-card';
import { EmptyState } from '@/components/states';
import { useAuth } from '@/features/auth/auth-context';
import { useReports, type ReportListRow } from '@/features/inspections/inspection-reports-list-page';
import { useTemporaryAssets } from '@/features/inspections/temporary-assets-page';
import { ACTIVE_VISIT_STATUSES, useCorrections, useVisits } from '@/features/visits/visit-lib';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

function VisitList({ title, description, rows, loading, empty }: { title: string; description?: string; rows: VisitSummaryDto[]; loading: boolean; empty: string }) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      {loading ? (
        <div className="space-y-2 p-5">
          <div className="skeleton h-5" />
        </div>
      ) : !rows.length ? (
        <EmptyState icon={<MapPinned className="h-6 w-6" />} title={empty} />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((v) => (
            <li key={v.id}>
              <Link to={`/visits/${v.id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-slate-50">
                <span className="min-w-0">
                  <span className="font-mono font-medium text-royal-700">{v.visitNo}</span> <span className="text-slate-700">{v.site?.name}</span>
                  <span className="block text-xs text-slate-500">
                    {v.workOrder.workOrderNo} · {v.plannedAt ? formatDateTime(v.plannedAt) : 'Not scheduled'}
                  </span>
                </span>
                <StatusBadge status={v.status} label={v.statusLabel} tone={toneOf(v.statusTone)} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ReportList({ title, rows, loading, empty, tone }: { title: string; rows: ReportListRow[]; loading: boolean; empty: string; tone?: 'danger' }) {
  return (
    <Card>
      <CardHeader title={title} />
      {loading ? (
        <div className="space-y-2 p-5">
          <div className="skeleton h-5" />
        </div>
      ) : !rows.length ? (
        <EmptyState icon={<ClipboardCheck className="h-6 w-6" />} title={empty} />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.id}>
              <Link to={`/inspection-reports/${r.id}`} className={cn('flex items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-slate-50', tone === 'danger' && 'bg-red-50/40')}>
                <span className="min-w-0">
                  <span className="font-medium text-navy-900">
                    {r.visit.visitNo} · rev {r.revisionNo}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {r.workOrder.workOrderNo} · {r.siteName} · {r.template}
                  </span>
                </span>
                <StatusBadge status={r.status} label={r.statusLabel} tone={toneOf(r.statusTone)} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Engineer dashboard field widgets (BRF §10): active visit, today's/upcoming visits, reports, corrections. */
export function EngineerFieldWidgets() {
  const { hasPermission } = useAuth();
  const today = startOfDay(new Date());
  const visits = useVisits({ mine: 'true', from: today.toISOString(), to: endOfDay(addDays(today, 7)).toISOString(), limit: 50, sort: 'plannedAt' }, hasPermission('visit.read'));
  const active = useVisits({ mine: 'true', status: ACTIVE_VISIT_STATUSES.join(','), limit: 5 }, hasPermission('visit.read'));
  const drafts = useReports({ status: 'DRAFT', limit: 50 }, hasPermission('inspection.read'));
  // A returned report continues as a new DRAFT revision (revision > 1) for the engineers.
  const draftRows = drafts.data?.data ?? [];
  const returnedRows = draftRows.filter((r) => r.revisionNo > 1);
  const newDrafts = draftRows.filter((r) => r.revisionNo === 1);
  const corrections = useCorrections({ status: 'PENDING', mine: 'true', limit: 10 }, hasPermission('visit.requestCorrection'));

  const rows = (visits.data?.data ?? []).filter((v) => v.status !== 'CANCELLED');
  const todays = rows.filter((v) => v.plannedAt && new Date(v.plannedAt) <= endOfDay(today));
  const upcoming = rows.filter((v) => v.plannedAt && new Date(v.plannedAt) > endOfDay(today));
  const current = active.data?.data[0];

  return (
    <div className="space-y-4">
      {current && (
        <Card className="border-teal-300 bg-teal-50/60">
          <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-teal-700">Active visit</p>
              <p className="mt-0.5 font-medium text-navy-900">
                {current.visitNo} · {current.site?.name}
              </p>
              <p className="text-sm text-slate-600">
                {current.workOrder.workOrderNo} — {current.statusLabel}
              </p>
            </div>
            <Link to={`/visits/${current.id}`} className={cn(buttonVariants({ variant: 'accent', size: 'lg' }), 'h-14 w-full text-base sm:w-auto')}>
              <Timer className="h-5 w-5" aria-hidden /> Continue time tracking
            </Link>
          </div>
        </Card>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Visits today" value={todays.length} loading={visits.isLoading} accent="teal" icon={<MapPinned className="h-5 w-5" />} />
        <KpiCard label="Draft reports" value={newDrafts.length} loading={drafts.isLoading} accent="royal" icon={<ClipboardCheck className="h-5 w-5" />} />
        <KpiCard label="Returned for correction" value={returnedRows.length} loading={drafts.isLoading} accent={returnedRows.length ? 'red' : 'slate'} icon={<FileWarning className="h-5 w-5" />} />
        <KpiCard label="Pending corrections" value={corrections.data?.meta.total ?? 0} loading={corrections.isLoading} accent="amber" icon={<History className="h-5 w-5" />} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <VisitList title="Today's visits" rows={todays} loading={visits.isLoading} empty="No visits planned today" />
        <VisitList title="Upcoming visits" description="Next 7 days" rows={upcoming} loading={visits.isLoading} empty="No visits planned in the next 7 days" />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ReportList title="Draft inspection reports" rows={newDrafts} loading={drafts.isLoading} empty="No draft reports" />
        <ReportList title="Returned for correction" rows={returnedRows} loading={drafts.isLoading} empty="No returned reports" tone="danger" />
      </div>
      {(corrections.data?.meta.total ?? 0) > 0 && (
        <Card>
          <CardHeader
            title="My pending corrections"
            actions={
              <Link to="/time-corrections" className="text-sm font-medium text-royal-700 hover:underline">
                View all
              </Link>
            }
          />
          <ul className="divide-y divide-border">
            {corrections.data!.data.map((c) => (
              <li key={c.id}>
                <Link to={`/visits/${c.visitId}`} className="flex items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-slate-50">
                  <span>
                    {TIME_EVENT_LABELS[c.eventType]} → {formatDateTime(c.proposedTimestamp)}
                    <span className="block text-xs text-slate-500">{c.reason}</span>
                  </span>
                  <StatusBadge status="PENDING" label="Pending" tone="warning" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** Supervisor field KPIs: pending time corrections, reports awaiting review, temporary assets. */
export function SupervisorFieldWidgets() {
  const { hasPermission } = useAuth();
  const corrections = useCorrections({ status: 'PENDING', limit: 5 }, hasPermission('visit.approveCorrection'));
  const submitted = useReports({ status: 'SUBMITTED,UNDER_REVIEW', limit: 1 }, hasPermission('inspection.read'));
  const temp = useTemporaryAssets(hasPermission('inspection.reviewTempAsset'));
  if (!hasPermission('visit.approveCorrection') && !hasPermission('inspection.read')) return null;
  return (
    <section className="space-y-4" aria-labelledby="field-heading">
      <h2 id="field-heading" className="text-base font-semibold text-navy-900">
        Field work
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {hasPermission('visit.approveCorrection') && (
          <Link to="/time-corrections" className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-royal-600">
            <KpiCard label="Pending time corrections" value={corrections.data?.meta.total ?? 0} loading={corrections.isLoading} accent="amber" icon={<History className="h-5 w-5" />} />
          </Link>
        )}
        {hasPermission('inspection.read') && (
          <Link to={hasPermission('inspection.approve') ? '/reviews' : '/inspection-reports?tab=submitted'} className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-royal-600">
            <KpiCard label="Reports awaiting review" value={submitted.data?.meta.total ?? 0} loading={submitted.isLoading} accent="royal" icon={<ClipboardCheck className="h-5 w-5" />} />
          </Link>
        )}
        {hasPermission('inspection.reviewTempAsset') && (
          <Link to="/inspections/temporary-assets" className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-royal-600">
            <KpiCard label="Temporary assets to review" value={temp.data?.length ?? 0} loading={temp.isLoading} accent="teal" icon={<Boxes className="h-5 w-5" />} />
          </Link>
        )}
      </div>
      {hasPermission('visit.approveCorrection') && (corrections.data?.data.length ?? 0) > 0 && (
        <Card>
          <CardHeader title="Pending time corrections" description="Oldest first" />
          <ul className="divide-y divide-border">
            {corrections.data!.data.map((c) => (
              <li key={c.id}>
                <Link to={`/visits/${c.visitId}`} className="flex items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-slate-50">
                  <span>
                    {c.engineer.name} · {TIME_EVENT_LABELS[c.eventType]}
                    <span className="block text-xs text-slate-500">
                      {formatDateTime(c.originalTimestamp)} → {formatDateTime(c.proposedTimestamp)}
                    </span>
                  </span>
                  <span className="text-xs text-slate-500">{formatDateTime(c.requestedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
