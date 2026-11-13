import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertOctagon, CheckCircle2, Clock, FilePlus2, ShieldAlert, UserCheck } from 'lucide-react';
import type { InspectionReportDto, NcrSummaryDto } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge, StatusBadge, toneOf } from '@/components/ui/badge';
import { KpiCard } from '@/components/kpi-card';
import { EmptyState, ErrorState } from '@/components/states';
import { useAuth } from '@/features/auth/auth-context';
import { formatDate } from '@/lib/format';
import { buildNcrParams, severityTone, useNcrs, useNcrSummary } from './ncr-lib';
import { RaiseNcrDialog, type RaiseNcrContext } from './raise-ncr-dialog';

export function NcrRows({ rows }: { rows: NcrSummaryDto[] }) {
  return (
    <ul className="divide-y divide-border">
      {rows.map((n) => (
        <li key={n.id}>
          <Link to={`/ncrs/${n.id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-slate-50">
            <span className="min-w-0">
              <span className="font-mono font-medium text-royal-700">{n.ncrNo}</span>
              <span className="ml-2 text-slate-800">{n.title}</span>
              <span className="block text-xs text-slate-500">
                {n.owner ? `Owner: ${n.owner.name}` : 'No owner yet'}
                {n.workOrder ? ` · ${n.workOrder.workOrderNo}` : ''}
                {n.dueAt ? ` · due ${formatDate(n.dueAt)}` : ''}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge tone={severityTone(n.severity)}>{n.severity}</Badge>
              {n.overdue && <Badge tone="danger">Overdue</Badge>}
              <StatusBadge status={n.status} label={n.statusLabel} tone={toneOf(n.statusTone)} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** NCRs for a complaint or work order, with "Raise NCR" for users holding ncr.create. */
export function NcrListPanel({ context, filter, description }: { context: RaiseNcrContext; filter: { complaintId?: string; workOrderId?: string }; description?: string }) {
  const { hasPermission } = useAuth();
  const readable = hasPermission('ncr.read');
  const canRaise = hasPermission('ncr.create');
  const [open, setOpen] = useState(false);
  const q = useNcrs(buildNcrParams({ ...filter, limit: 50, sort: '-createdAt' }), readable);
  if (!readable) return null;
  return (
    <Card>
      <CardHeader
        title="Non-conformance reports"
        description={description}
        actions={
          canRaise ? (
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              <FilePlus2 className="h-4 w-4" /> Raise NCR
            </Button>
          ) : undefined
        }
      />
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <div className="p-5">
          <div className="skeleton h-5" />
        </div>
      ) : !q.data?.data.length ? (
        <EmptyState icon={<ShieldAlert className="h-6 w-6" />} title="No NCRs" description="Non-conformances found during the work are tracked here." />
      ) : (
        <NcrRows rows={q.data.data} />
      )}
      {canRaise && <RaiseNcrDialog open={open} onOpenChange={setOpen} context={context} />}
    </Card>
  );
}

/** Dashboard tiles from GET /ncrs/summary. */
export function NcrKpiGrid() {
  const { hasPermission } = useAuth();
  const s = useNcrSummary(hasPermission('ncr.read'));
  if (!hasPermission('ncr.read')) return null;
  if (s.isError)
    return (
      <Card>
        <ErrorState error={s.error} onRetry={() => s.refetch()} />
      </Card>
    );
  const d = s.data;
  const link = 'rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-royal-600';
  return (
    <section className="space-y-4" aria-labelledby="ncr-heading">
      <h2 id="ncr-heading" className="text-base font-semibold text-navy-900">
        Non-conformance reports
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Link to="/ncrs?status=OPEN" className={link}>
          <KpiCard label="Open NCRs" value={d?.open ?? 0} loading={s.isLoading} accent="royal" icon={<AlertOctagon className="h-5 w-5" />} />
        </Link>
        <Link to="/ncrs?status=SUBMITTED_FOR_VERIFICATION" className={link}>
          <KpiCard label="Awaiting verification" value={d?.awaitingVerification ?? 0} loading={s.isLoading} accent="amber" icon={<CheckCircle2 className="h-5 w-5" />} />
        </Link>
        <Link to="/ncrs?overdue=true" className={link}>
          <KpiCard label="Overdue" value={d?.overdue ?? 0} loading={s.isLoading} accent={d?.overdue ? 'red' : 'slate'} icon={<Clock className="h-5 w-5" />} />
        </Link>
        <Link to="/ncrs?mine=true" className={link}>
          <KpiCard label="Assigned to me" value={d?.assignedToMe ?? 0} loading={s.isLoading} accent="teal" icon={<UserCheck className="h-5 w-5" />} />
        </Link>
      </div>
    </section>
  );
}

/** Submitted report: failed checklist items with "Raise NCR" (prefilled report, item and work order). */
export function FailedItemsNcrCard({ report }: { report: InspectionReportDto }) {
  const { hasPermission } = useAuth();
  const [ctx, setCtx] = useState<RaiseNcrContext | null>(null);
  const failed = report.items.filter((i) => i.result === 'FAIL');
  if (!failed.length || !hasPermission('ncr.create')) return null;
  return (
    <Card>
      <CardHeader title="Failed items" description="Raise a non-conformance report for any failed check." />
      <ul className="divide-y divide-border">
        {failed.map((i) => (
          <li key={i.key} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
            <span className="min-w-0">
              <span className="font-medium text-navy-900">{i.description}</span>
              <span className="ml-2 font-mono text-xs text-slate-500">{i.key}</span>
              {i.remarks && <span className="block text-xs text-slate-600">{i.remarks}</span>}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setCtx({
                  complaintId: report.complaint.id,
                  complaintRef: report.complaint.referenceNo,
                  workOrderId: report.workOrder.id,
                  workOrderNo: report.workOrder.workOrderNo,
                  inspectionReportId: report.id,
                  itemKey: i.key,
                  itemDescription: i.description,
                })
              }
            >
              <FilePlus2 className="h-4 w-4" /> Raise NCR
            </Button>
          </li>
        ))}
      </ul>
      {ctx && <RaiseNcrDialog open onOpenChange={(o) => !o && setCtx(null)} context={ctx} />}
    </Card>
  );
}
