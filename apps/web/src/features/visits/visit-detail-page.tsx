import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { VisitDetailDto } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { StatusBadge, toneOf } from '@/components/ui/badge';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FormField, Input, Textarea } from '@/components/ui/form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState, ErrorState } from '@/components/states';
import { useBreadcrumb } from '@/app/breadcrumbs';
import { useAuth } from '@/features/auth/auth-context';
import { fromLocalInput, toLocalInput } from '@/features/work-orders/wo-lib';
import { api, errorMessage, parseApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { CorrectionsList, DurationsGrid, MyTimeCard, TeamSequences, TimeEventsTable } from './time-tracking';
import { InspectionCard } from './visit-dialogs';
import { useVisit } from './visit-lib';

export function VisitDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const q = useVisit(id);
  useBreadcrumb(q.data?.visitNo);

  const onChanged = (v: VisitDetailDto) => {
    qc.setQueryData(['visits', 'detail', id], v);
    void qc.invalidateQueries({ queryKey: ['visits', 'list'] });
    void qc.invalidateQueries({ queryKey: ['time-corrections'] });
    void qc.invalidateQueries({ queryKey: ['work-orders'] });
  };

  if (q.isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-8 w-48" />
        <div className="skeleton h-56" />
      </div>
    );
  }
  if (q.isError) {
    const status = parseApiError(q.error).status;
    return (
      <Card>
        {status === 404 || status === 400 ? (
          <EmptyState
            title="Visit not found"
            description="It may not exist, or it is outside your data access."
            action={
              <Link to="/visits" className="text-sm font-medium text-royal-700 hover:underline">
                Back to visits
              </Link>
            }
          />
        ) : (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        )}
      </Card>
    );
  }
  return q.data ? <VisitDetailView v={q.data} onChanged={onChanged} refetch={() => q.refetch()} /> : null;
}

function VisitDetailView({ v, onChanged, refetch }: { v: VisitDetailDto; onChanged: (v: VisitDetailDto) => void; refetch: () => void }) {
  const { user } = useAuth();
  const [editOpen, setEditOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const showTeam = v.sequences.length > 1 || !v.mySequence;

  const cancel = async (reason: string) => {
    try {
      const res = await api.post<VisitDetailDto>(`/visits/${v.id}/cancel`, { reason });
      onChanged(res.data);
      toast.success('Visit cancelled');
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <Link to={`/work-orders/${v.workOrder.id}`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-navy-900">
          <ArrowLeft className="h-4 w-4" /> {v.workOrder.workOrderNo}
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-mono text-xl font-semibold text-navy-900 sm:text-2xl">{v.visitNo}</h1>
            <p className="mt-0.5 text-sm text-slate-700">{v.purpose}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <StatusBadge status={v.status} label={v.statusLabel} tone={toneOf(v.statusTone)} />
              <span>{v.site?.name}</span>
              <span>· {v.plannedAt ? `Planned ${formatDateTime(v.plannedAt)}` : 'Not scheduled'}</span>
              <span>
                ·{' '}
                <Link to={`/complaints/${v.complaint.id}`} className="font-mono text-royal-700 hover:underline">
                  {v.complaint.referenceNo}
                </Link>
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {v.permissions.canEdit && (
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                <Pencil className="h-4 w-4" /> Edit
              </Button>
            )}
            {v.permissions.canCancel && (
              <Button variant="outline" size="sm" className="text-red-700" onClick={() => setCancelOpen(true)}>
                <XCircle className="h-4 w-4" /> Cancel visit
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {v.mySequence && <MyTimeCard visit={v} onChanged={onChanged} />}
          {v.mySequence && (
            <Card>
              <CardHeader title="My durations" description="Calculated from server times (corrected where approved)." />
              <CardBody>
                <DurationsGrid sequence={v.mySequence} />
              </CardBody>
            </Card>
          )}
          {showTeam && <TeamSequences visit={v} />}
          <TimeEventsTable visit={v} onChanged={onChanged} />
          <Card>
            <CardHeader title="Time corrections" />
            <CorrectionsList corrections={v.corrections} canApprove={v.permissions.canApproveCorrections} currentUserId={user?.id} onDecided={refetch} />
          </Card>
        </div>
        <div className="space-y-4">
          <InspectionCard visit={v} />
          <Card>
            <CardHeader title="Visit details" />
            <CardBody>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Engineers</dt>
                  <dd className="text-navy-900">{v.engineers.map((e) => e.name).join(', ')}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Other attendees</dt>
                  <dd className="text-navy-900">{v.attendees || '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Notes</dt>
                  <dd className="whitespace-pre-line text-navy-900">{v.notes || '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Started / completed</dt>
                  <dd className="text-navy-900">
                    {v.startedAt ? formatDateTime(v.startedAt) : '—'} / {v.completedAt ? formatDateTime(v.completedAt) : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Timezone</dt>
                  <dd className="text-navy-900">{v.timezone}</dd>
                </div>
              </dl>
            </CardBody>
          </Card>
        </div>
      </div>

      {v.permissions.canEdit && <EditVisitDialog visit={v} open={editOpen} onOpenChange={setEditOpen} onChanged={onChanged} />}
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={`Cancel ${v.visitNo}?`}
        description="Only planned visits can be cancelled. The visit stays on record."
        confirmLabel="Cancel visit"
        tone="danger"
        reason="required"
        onConfirm={cancel}
      />
    </div>
  );
}

function EditVisitDialog({ visit, open, onOpenChange, onChanged }: { visit: VisitDetailDto; open: boolean; onOpenChange: (o: boolean) => void; onChanged: (v: VisitDetailDto) => void }) {
  const [purpose, setPurpose] = useState(visit.purpose);
  const [plannedAt, setPlannedAt] = useState(toLocalInput(visit.plannedAt));
  const [attendees, setAttendees] = useState(visit.attendees ?? '');
  const [notes, setNotes] = useState(visit.notes ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPurpose(visit.purpose);
    setPlannedAt(toLocalInput(visit.plannedAt));
    setAttendees(visit.attendees ?? '');
    setNotes(visit.notes ?? '');
    setErrors({});
  }, [open, visit]);

  const save = async () => {
    if (purpose.trim().length < 3) return setErrors({ purpose: 'Describe the purpose of the visit' });
    setBusy(true);
    try {
      const res = await api.patch<VisitDetailDto>(`/visits/${visit.id}`, { purpose, plannedAt: fromLocalInput(plannedAt) ?? null, attendees, notes });
      onChanged(res.data);
      toast.success('Visit updated');
      onOpenChange(false);
    } catch (err) {
      const e = parseApiError(err);
      if (e.fields) setErrors(e.fields);
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Edit ${visit.visitNo}`}
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={save} loading={busy}>
              Save changes
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <FormField label="Purpose" required error={errors.purpose}>
            {(p) => <Input {...p} maxLength={500} value={purpose} onChange={(e) => setPurpose(e.target.value)} />}
          </FormField>
          <FormField label="Planned date and time" error={errors.plannedAt}>
            {(p) => <Input {...p} type="datetime-local" value={plannedAt} onChange={(e) => setPlannedAt(e.target.value)} />}
          </FormField>
          <FormField label="Other attendees" error={errors.attendees}>
            {(p) => <Input {...p} maxLength={1000} value={attendees} onChange={(e) => setAttendees(e.target.value)} />}
          </FormField>
          <FormField label="Notes" error={errors.notes}>
            {(p) => <Textarea {...p} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}
