import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Check, CheckCircle2, Package, Pencil, Star, UserPlus, Zap } from 'lucide-react';
import { toast } from 'sonner';
import type { WorkOrderDetailDto } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge, StatusBadge, toneOf } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState, ErrorState } from '@/components/states';
import { useBreadcrumb } from '@/app/breadcrumbs';
import { DueCell, PriorityBadge } from '@/features/complaints/complaints-list-page';
import { api, errorMessage, parseApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn, humanize } from '@/lib/utils';
import { AssignDialog, PlanningDialog } from './work-order-dialogs';
import { WorkOrderVisitsPanel } from '@/features/visits/visit-dialogs';
import { WorkOrderMaterialsPanel } from '@/features/materials/material-panels';

type Action = WorkOrderDetailDto['availableActions'][number];
const DANGER = new Set(['cancel']);

export function WorkOrderDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['work-orders', 'detail', id],
    queryFn: async () => (await api.get<WorkOrderDetailDto>(`/work-orders/${id}`)).data,
  });
  useBreadcrumb(q.data?.workOrderNo);

  const onChanged = (w: WorkOrderDetailDto) => {
    qc.setQueryData(['work-orders', 'detail', id], w);
    void qc.invalidateQueries({ queryKey: ['work-orders', 'list'] });
    void qc.invalidateQueries({ queryKey: ['work-orders', 'summary'] });
    void qc.invalidateQueries({ queryKey: ['work-orders', 'calendar'] });
    void qc.invalidateQueries({ queryKey: ['complaints'] });
  };

  if (q.isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-8 w-64" />
        <div className="skeleton h-40" />
      </div>
    );
  }
  if (q.isError) {
    const status = parseApiError(q.error).status;
    return (
      <Card>
        {status === 404 || status === 400 ? (
          <EmptyState
            title="Work order not found"
            description="It may not exist, or it is outside your data access."
            action={
              <Link to="/work-orders" className="text-sm font-medium text-royal-700 hover:underline">
                Back to work orders
              </Link>
            }
          />
        ) : (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        )}
      </Card>
    );
  }
  return q.data ? <WorkOrderDetailView w={q.data} onChanged={onChanged} /> : null;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-navy-900">{children ?? '—'}</dd>
    </div>
  );
}

export function WorkOrderActions({ w, onChanged }: { w: WorkOrderDetailDto; onChanged: (w: WorkOrderDetailDto) => void }) {
  const [active, setActive] = useState<Action | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // "accept" is rendered as the prominent engineer button (permissions.canAccept).
  const actions = w.availableActions.filter((a) => a.action !== 'accept');

  const run = async (action: string, reason?: string) => {
    try {
      const res = await api.post<WorkOrderDetailDto>(`/work-orders/${w.id}/transitions`, { action, reason: reason || undefined });
      onChanged(res.data);
      toast.success(`${res.data.workOrderNo}: ${res.data.statusLabel}`);
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  };
  const click = async (a: Action) => {
    if (a.requiresReason || a.confirm) {
      setActive(a);
      return;
    }
    setBusy(a.action);
    try {
      await run(a.action);
    } catch {
      /* toast shown */
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="flex flex-wrap gap-2" aria-label="Work order actions">
        {w.permissions.canAccept && (
          <Button variant="accent" loading={busy === 'accept'} onClick={() => click({ action: 'accept', label: 'Accept work', to: 'ACCEPTED', requiresReason: false, confirm: false })}>
            <CheckCircle2 className="h-4 w-4" /> Accept work
          </Button>
        )}
        {actions.map((a) => (
          <Button
            key={a.action}
            size="sm"
            variant={DANGER.has(a.action) ? 'outline' : 'secondary'}
            className={cn(DANGER.has(a.action) && 'text-red-700')}
            loading={busy === a.action}
            onClick={() => click(a)}
          >
            {a.label}
          </Button>
        ))}
      </div>
      <ConfirmDialog
        open={Boolean(active)}
        onOpenChange={(o) => !o && setActive(null)}
        title={active ? `${active.label}?` : ''}
        description={`Work order ${w.workOrderNo}`}
        confirmLabel={active?.label ?? 'Confirm'}
        tone={active && DANGER.has(active.action) ? 'danger' : 'primary'}
        reason={active?.requiresReason ? 'required' : undefined}
        onConfirm={(reason) => run(active!.action, reason)}
      />
    </>
  );
}

export function WorkOrderDetailView({ w, onChanged }: { w: WorkOrderDetailDto; onChanged: (w: WorkOrderDetailDto) => void }) {
  const [editOpen, setEditOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div>
        <Link to="/work-orders" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-navy-900">
          <ArrowLeft className="h-4 w-4" /> Work orders
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-mono text-xl font-semibold text-navy-900 sm:text-2xl">{w.workOrderNo}</h1>
            <p className="mt-0.5 text-sm text-slate-700">{w.title}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusBadge status={w.status} label={w.statusLabel} tone={toneOf(w.statusTone)} />
              <PriorityBadge priority={w.priority} />
              {w.overdue && (
                <Badge tone="danger">
                  <AlertTriangle className="h-3 w-3" aria-hidden /> Overdue
                </Badge>
              )}
              <span className="text-sm text-slate-600">
                Complaint{' '}
                <Link to={`/complaints/${w.complaint.id}`} className="font-mono font-medium text-royal-700 hover:underline">
                  {w.complaint.referenceNo}
                </Link>{' '}
                <span className="text-slate-500">({w.complaintDetail.statusLabel})</span>
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {w.permissions.canEdit && (
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                <Pencil className="h-4 w-4" /> Edit planning
              </Button>
            )}
            {w.permissions.canAssign && (
              <Button variant="outline" size="sm" onClick={() => setAssignOpen(true)}>
                <UserPlus className="h-4 w-4" /> {w.assignees.length ? 'Reassign' : 'Assign engineers'}
              </Button>
            )}
          </div>
        </div>
        <div className="mt-3">
          <WorkOrderActions w={w} onChanged={onChanged} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader title="Work details" />
            <CardBody className="space-y-4">
              <p className="whitespace-pre-line break-words text-sm text-slate-800">{w.description}</p>
              {w.workScope && (
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Work scope</p>
                  <p className="mt-0.5 whitespace-pre-line text-sm text-slate-800">{w.workScope}</p>
                </div>
              )}
              <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Site">
                  {w.site?.name}
                  {w.site?.code ? <span className="text-slate-500"> ({w.site.code})</span> : null}
                </Field>
                <Field label="Region">{w.region?.name}</Field>
                <Field label="Asset">
                  {w.asset?.name || 'Not specified'}
                  {w.asset?.code ? <span className="text-slate-500"> ({w.asset.code})</span> : null}
                </Field>
                <Field label="Equipment type">{w.equipmentType?.name || 'Not specified'}</Field>
                <Field label="Customer">{w.complaintDetail.customerName}</Field>
              </dl>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className={cn('rounded-lg border p-3', w.shutdownRequired ? 'border-red-200 bg-red-50' : 'border-border')}>
                  <p className="flex items-center gap-1.5 text-sm font-medium text-navy-900">
                    <Zap className={cn('h-4 w-4', w.shutdownRequired ? 'text-red-600' : 'text-slate-400')} aria-hidden />
                    {w.shutdownRequired ? 'Shutdown required' : 'No shutdown required'}
                  </p>
                  {w.shutdownDetails && <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{w.shutdownDetails}</p>}
                </div>
                <div className={cn('rounded-lg border p-3', w.materialRequired ? 'border-sky-200 bg-sky-50' : 'border-border')}>
                  <p className="flex items-center gap-1.5 text-sm font-medium text-navy-900">
                    <Package className={cn('h-4 w-4', w.materialRequired ? 'text-sky-600' : 'text-slate-400')} aria-hidden />
                    {w.materialRequired ? 'Materials required' : 'No materials flagged'}
                  </p>
                  {w.materialNotes && <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{w.materialNotes}</p>}
                </div>
              </div>
              <details className="rounded-lg border border-border p-3 text-sm">
                <summary className="cursor-pointer font-medium text-navy-900">Original complaint description</summary>
                <p className="mt-2 whitespace-pre-line text-slate-700">{w.complaintDetail.description}</p>
              </details>
            </CardBody>
          </Card>

          <WorkOrderVisitsPanel workOrder={w} />

          <WorkOrderMaterialsPanel workOrder={w} />

          <Card>
            <CardHeader title="Assignment history" description="Every assignment change is recorded (WO-04)." />
            {w.assignmentHistory.length === 0 ? (
              <EmptyState title="Not assigned yet" />
            ) : (
              <ol className="divide-y divide-border">
                {w.assignmentHistory.map((h, i) => (
                  <li key={i} className="px-5 py-3 text-sm">
                    <p className="text-xs text-slate-500">
                      {formatDateTime(h.at)} · {h.byName ?? 'System'}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {h.added.map((a) => (
                        <Badge key={`a-${a.id}`} tone="success">
                          + {a.name}
                        </Badge>
                      ))}
                      {h.removed.map((a) => (
                        <Badge key={`r-${a.id}`} tone="danger">
                          − {a.name}
                        </Badge>
                      ))}
                      {!h.added.length && !h.removed.length && <span className="text-slate-600">Planning updated</span>}
                      {h.leadEngineer && (
                        <Badge tone="warning">
                          <Star className="h-3 w-3" aria-hidden /> Lead: {h.leadEngineer.name}
                        </Badge>
                      )}
                    </div>
                    {h.reason && <p className="mt-1 text-slate-700">Reason: {h.reason}</p>}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Planning" />
            <CardBody>
              <dl className="grid grid-cols-1 gap-3">
                <Field label="Planned start">{w.plannedVisitAt ? formatDateTime(w.plannedVisitAt) : 'Not planned'}</Field>
                <Field label="Planned end">{w.plannedEndAt ? formatDateTime(w.plannedEndAt) : '—'}</Field>
                <Field label="Due">
                  <DueCell c={w} />
                </Field>
                <Field label="Supervisor">{w.supervisor?.name ?? '—'}</Field>
                <Field label="Created">{formatDateTime(w.createdAt)}</Field>
              </dl>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Team" />
            {w.assignees.length === 0 ? (
              <EmptyState title="No engineers assigned" description={w.permissions.canAssign ? 'Use “Assign engineers” to allocate this work.' : undefined} />
            ) : (
              <ul className="divide-y divide-border">
                {w.assignees.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 px-5 py-2.5 text-sm">
                    <span className="flex items-center gap-1.5 text-navy-900">
                      {a.lead && <Star className="h-3.5 w-3.5 text-amber-500" aria-label="Lead engineer" />}
                      {a.name}
                    </span>
                    {a.accepted ? (
                      <Badge tone="success">
                        <Check className="h-3 w-3" aria-hidden /> Accepted
                      </Badge>
                    ) : (
                      <Badge tone="warning">Awaiting acceptance</Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Status history" />
            <ol className="space-y-3 px-5 py-4">
              {[...w.statusHistory].reverse().map((h, i) => (
                <li key={i} className="border-l-2 border-royal-200 pl-3 text-sm">
                  <p className="font-medium text-navy-900">{h.toLabel}</p>
                  <p className="text-xs text-slate-500">
                    {humanize(h.action)} · {h.byName ?? 'System'} · {formatDateTime(h.at)}
                  </p>
                  {h.reason && <p className="mt-0.5 text-slate-700">{h.reason}</p>}
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>

      {w.permissions.canEdit && <PlanningDialog workOrder={w} open={editOpen} onOpenChange={setEditOpen} onChanged={onChanged} />}
      {w.permissions.canAssign && <AssignDialog workOrder={w} open={assignOpen} onOpenChange={setAssignOpen} onChanged={onChanged} />}
    </div>
  );
}
