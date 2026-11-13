import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Package, PackagePlus } from 'lucide-react';
import type { MaterialRequestSummaryDto, VisitDetailDto, WorkOrderDetailDto } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge, StatusBadge, toneOf } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/states';
import { useAuth } from '@/features/auth/auth-context';
import { formatDateTime } from '@/lib/format';
import { REQUESTABLE_WO_STATUSES, urgencyLabel, urgencyTone, useMaterialRequests } from './material-lib';
import { RaiseMaterialRequestDialog } from './request-form';

function RequestList({ rows }: { rows: MaterialRequestSummaryDto[] }) {
  return (
    <ul className="divide-y divide-border">
      {rows.map((r) => (
        <li key={r.id}>
          <Link to={`/materials/${r.id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-slate-50">
            <span className="min-w-0">
              <span className="font-mono font-medium text-royal-700">{r.requestNo}</span>
              <span className="ml-2 text-slate-700">
                {r.lineCount} item{r.lineCount === 1 ? '' : 's'}
              </span>
              <span className="block text-xs text-slate-500">
                {r.requester.name} · {formatDateTime(r.submittedAt ?? r.createdAt)}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              {r.urgency !== 'NORMAL' && <Badge tone={urgencyTone(r.urgency)}>{urgencyLabel(r.urgency)}</Badge>}
              <StatusBadge status={r.status} label={r.statusLabel} tone={toneOf(r.statusTone)} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function PanelBody({ q, emptyText }: { q: ReturnType<typeof useMaterialRequests>; emptyText?: string }) {
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isLoading)
    return (
      <div className="space-y-2 p-5">
        <div className="skeleton h-5" />
      </div>
    );
  if (!q.data?.data.length) return <EmptyState icon={<Package className="h-6 w-6" />} title="No material requests" description={emptyText} />;
  return <RequestList rows={q.data.data} />;
}

/** Work-order "Materials" panel (MAT-01): requests on this work order, and "Request material" for assignees. */
export function WorkOrderMaterialsPanel({ workOrder }: { workOrder: WorkOrderDetailDto }) {
  const { user, hasPermission } = useAuth();
  const [open, setOpen] = useState(false);
  const readable = hasPermission('material.read');
  const q = useMaterialRequests({ workOrderId: workOrder.id, limit: 50, sort: '-createdAt' }, readable);
  if (!readable) return null;
  const canRaise = hasPermission('material.create') && REQUESTABLE_WO_STATUSES.includes(workOrder.status) && workOrder.assignees.some((a) => a.id === user?.id);
  return (
    <Card>
      <CardHeader
        title="Materials"
        description="Material requested for this work order"
        actions={
          canRaise ? (
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              <PackagePlus className="h-4 w-4" /> Request material
            </Button>
          ) : undefined
        }
      />
      <PanelBody q={q} emptyText={canRaise ? 'Request catalogue items needed to complete the work.' : undefined} />
      {canRaise && <RaiseMaterialRequestDialog open={open} onOpenChange={setOpen} workOrderId={workOrder.id} workOrderNo={workOrder.workOrderNo} />}
    </Card>
  );
}

/** Visit "Materials" card: raise a request linked to this visit (visit prefilled). */
export function VisitMaterialsCard({ visit }: { visit: VisitDetailDto }) {
  const { user, hasPermission } = useAuth();
  const [open, setOpen] = useState(false);
  const readable = hasPermission('material.read');
  const q = useMaterialRequests({ workOrderId: visit.workOrder.id, limit: 50, sort: '-createdAt' }, readable);
  if (!readable) return null;
  const canRaise = hasPermission('material.create') && visit.status !== 'CANCELLED' && visit.engineers.some((e) => e.id === user?.id);
  return (
    <Card>
      <CardHeader
        title="Materials"
        description={`Requests on ${visit.workOrder.workOrderNo}`}
        actions={
          canRaise ? (
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              <PackagePlus className="h-4 w-4" /> Request material
            </Button>
          ) : undefined
        }
      />
      <PanelBody q={q} />
      {canRaise && <RaiseMaterialRequestDialog open={open} onOpenChange={setOpen} workOrderId={visit.workOrder.id} workOrderNo={visit.workOrder.workOrderNo} visitId={visit.id} />}
    </Card>
  );
}
