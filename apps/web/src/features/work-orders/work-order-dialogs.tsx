import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ComplaintDetailDto, WorkOrderDetailDto } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/controls';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FormField, Input, Select, Textarea } from '@/components/ui/form';
import { useAuth } from '@/features/auth/auth-context';
import { useLookup } from '@/features/complaints/complaint-lib';
import { api, errorMessage, parseApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { EngineerPicker } from './engineer-picker';
import {
  reassignNeedsReason,
  toLocalInput,
  fromLocalInput,
  useWorkload,
  validateCreateForm,
  validatePlanningForm,
  type PlanningFormValues,
  type WorkOrderFormValues,
} from './wo-lib';

function useReviewers(enabled: boolean) {
  return useQuery({
    queryKey: ['complaints', 'reviewers'],
    queryFn: async () => (await api.get<{ id: string; name: string; email: string }[]>('/complaints/reviewers')).data,
    enabled,
    staleTime: 5 * 60_000,
  });
}

function CheckToggle({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(c) => onChange(c === true)} />
      <label htmlFor={id} className="text-sm font-medium text-slate-700">
        {label}
      </label>
    </div>
  );
}

/** Planning & scope fields shared by the create and edit dialogs. */
export function PlanningFields({
  v,
  set,
  errors,
  dueHint,
  prefix,
}: {
  v: Omit<WorkOrderFormValues, 'supervisorId' | 'assigneeIds' | 'leadEngineerId'>;
  set: (patch: Partial<WorkOrderFormValues>) => void;
  errors: Record<string, string>;
  dueHint?: ReactNode;
  prefix: string;
}) {
  const priorities = useLookup('masters', 'priorities');
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <FormField label="Title" required error={errors.title} className="sm:col-span-2">
        {(p) => <Input {...p} maxLength={150} value={v.title} onChange={(e) => set({ title: e.target.value })} />}
      </FormField>
      <FormField label="Work description" required error={errors.description} className="sm:col-span-2">
        {(p) => <Textarea {...p} rows={4} maxLength={4000} value={v.description} onChange={(e) => set({ description: e.target.value })} />}
      </FormField>
      <FormField label="Work scope" error={errors.workScope} className="sm:col-span-2" help="Tasks, isolation points, tests to perform (optional).">
        {(p) => <Textarea {...p} rows={3} maxLength={4000} value={v.workScope} onChange={(e) => set({ workScope: e.target.value })} />}
      </FormField>
      <FormField label="Priority" error={errors.priorityId}>
        {(p) => (
          <Select {...p} value={v.priorityId} onChange={(e) => set({ priorityId: e.target.value })}>
            <option value="">Same as complaint</option>
            {(priorities.data ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label="Due" error={errors.dueAt} help={dueHint}>
        {(p) => <Input {...p} type="datetime-local" value={v.dueAt} onChange={(e) => set({ dueAt: e.target.value })} />}
      </FormField>
      <FormField label="Planned visit start" error={errors.plannedVisitAt} help="Your local time.">
        {(p) => <Input {...p} type="datetime-local" value={v.plannedVisitAt} onChange={(e) => set({ plannedVisitAt: e.target.value })} />}
      </FormField>
      <FormField label="Planned visit end" error={errors.plannedEndAt}>
        {(p) => <Input {...p} type="datetime-local" value={v.plannedEndAt} onChange={(e) => set({ plannedEndAt: e.target.value })} />}
      </FormField>
      <div className="space-y-2 sm:col-span-2">
        <CheckToggle id={`${prefix}-shutdown`} label="Shutdown required" checked={v.shutdownRequired} onChange={(c) => set({ shutdownRequired: c })} />
        {v.shutdownRequired && (
          <FormField label="Shutdown details" required error={errors.shutdownDetails} help="Isolation, outage window, permits.">
            {(p) => <Textarea {...p} rows={2} maxLength={2000} value={v.shutdownDetails} onChange={(e) => set({ shutdownDetails: e.target.value })} />}
          </FormField>
        )}
      </div>
      <div className="space-y-2 sm:col-span-2">
        <CheckToggle id={`${prefix}-material`} label="Materials required" checked={v.materialRequired} onChange={(c) => set({ materialRequired: c })} />
        {v.materialRequired && (
          <FormField label="Material notes" required error={errors.materialNotes} help="Detailed material requests follow in Phase 7.">
            {(p) => <Textarea {...p} rows={2} maxLength={2000} value={v.materialNotes} onChange={(e) => set({ materialNotes: e.target.value })} />}
          </FormField>
        )}
      </div>
    </div>
  );
}

function initialCreate(c: ComplaintDetailDto, userId: string): WorkOrderFormValues {
  return {
    title: `${c.requestType?.name ?? 'Service'} — ${c.site?.name ?? ''}`.slice(0, 150),
    description: c.description,
    workScope: '',
    priorityId: '',
    plannedVisitAt: '',
    plannedEndAt: '',
    dueAt: toLocalInput(c.dueAt ?? null),
    shutdownRequired: false,
    shutdownDetails: '',
    materialRequired: false,
    materialNotes: '',
    supervisorId: userId,
    assigneeIds: [],
    leadEngineerId: '',
  };
}

/** WO-01: create a work order for a classified complaint (optionally assigning engineers). */
export function CreateWorkOrderDialog({ complaint, open, onOpenChange }: { complaint: ComplaintDetailDto; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canAssign = hasPermission('workOrder.assign');
  const [v, setV] = useState<WorkOrderFormValues>(() => initialCreate(complaint, user?.id ?? ''));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const reviewers = useReviewers(open && hasPermission('complaint.classify'));
  const workload = useWorkload({ siteId: complaint.site?.id, enabled: open && canAssign });

  useEffect(() => {
    if (open) {
      setV(initialCreate(complaint, user?.id ?? ''));
      setErrors({});
    }
  }, [open, complaint, user?.id]);

  const set = (patch: Partial<WorkOrderFormValues>) => setV((s) => ({ ...s, ...patch }));

  const submit = async () => {
    const { payload, errors: e } = validateCreateForm(v);
    setErrors(e);
    if (!payload) return;
    setBusy(true);
    try {
      const res = await api.post<WorkOrderDetailDto>(`/complaints/${complaint.id}/work-orders`, payload);
      toast.success(`Work order ${res.data.workOrderNo} created`);
      void qc.invalidateQueries({ queryKey: ['complaints'] });
      void qc.invalidateQueries({ queryKey: ['work-orders'] });
      onOpenChange(false);
      navigate(`/work-orders/${res.data.id}`);
    } catch (err) {
      const pe = parseApiError(err);
      if (pe.fields) setErrors(pe.fields);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="xl"
        title={`New work order for ${complaint.referenceNo}`}
        description={`${complaint.site?.name ?? ''}${complaint.priority ? ` · Priority ${complaint.priority.name}` : ''}`}
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy}>
              Create work order
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <PlanningFields
              prefix="create"
              v={v}
              set={set}
              errors={errors}
              dueHint={complaint.dueAt ? `Complaint SLA due ${formatDateTime(complaint.dueAt)}` : 'No SLA due date on the complaint'}
            />
          </div>
          <div className="space-y-4 lg:col-span-2">
            {reviewers.data && (
              <FormField label="Supervisor" error={errors.supervisorId}>
                {(p) => (
                  <Select {...p} value={v.supervisorId} onChange={(e) => set({ supervisorId: e.target.value })}>
                    {reviewers.data.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
            )}
            {canAssign ? (
              <>
                <EngineerPicker
                  idPrefix="create-eng"
                  engineers={workload.data}
                  loading={workload.isLoading}
                  value={v.assigneeIds}
                  onChange={(ids) => set({ assigneeIds: ids })}
                  lead={v.leadEngineerId}
                  onLeadChange={(id) => set({ leadEngineerId: id })}
                  error={errors.assigneeIds}
                  leadError={errors.leadEngineerId}
                />
                <p className="text-xs text-slate-500">Leave empty to create a draft and assign later from the assignment board.</p>
              </>
            ) : (
              <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">A supervisor will assign engineers.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** WO-04: assign / reassign engineers. Reassigning accepted work needs a reason and re-acceptance. */
export function AssignDialog({
  workOrder,
  open,
  onOpenChange,
  onChanged,
}: {
  workOrder: Pick<WorkOrderDetailDto, 'id' | 'workOrderNo' | 'status' | 'site' | 'plannedVisitAt'> & { assignees: { id: string; lead: boolean }[] };
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onChanged?: (w: WorkOrderDetailDto) => void;
}) {
  const qc = useQueryClient();
  const before = workOrder.assignees.map((a) => a.id);
  const [ids, setIds] = useState<string[]>(before);
  const [lead, setLead] = useState(workOrder.assignees.find((a) => a.lead)?.id ?? before[0] ?? '');
  const [planned, setPlanned] = useState(toLocalInput(workOrder.plannedVisitAt ?? null));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const workload = useWorkload({ siteId: workOrder.site?.id, enabled: open });

  useEffect(() => {
    if (open) {
      setIds(workOrder.assignees.map((a) => a.id));
      setLead(workOrder.assignees.find((a) => a.lead)?.id ?? workOrder.assignees[0]?.id ?? '');
      setPlanned(toLocalInput(workOrder.plannedVisitAt ?? null));
      setReason('');
      setErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workOrder.id]);

  const needsReason = reassignNeedsReason(workOrder.status, before, ids);

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!ids.length) e.assigneeIds = 'Select at least one engineer';
    if (needsReason && !reason.trim()) e.reason = 'A reason is required to reassign accepted work';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const plannedIso = fromLocalInput(planned);
      const res = await api.patch<WorkOrderDetailDto>(`/work-orders/${workOrder.id}/assignment`, {
        assigneeIds: ids,
        leadEngineerId: ids.includes(lead) ? lead : ids[0],
        ...(planned !== toLocalInput(workOrder.plannedVisitAt ?? null) ? { plannedVisitAt: plannedIso ?? null } : {}),
        reason: reason.trim() || undefined,
      });
      toast.success(`${res.data.workOrderNo} assigned`);
      void qc.invalidateQueries({ queryKey: ['work-orders'] });
      void qc.invalidateQueries({ queryKey: ['complaints'] });
      onChanged?.(res.data);
      onOpenChange(false);
    } catch (err) {
      const pe = parseApiError(err);
      if (pe.fields) setErrors(pe.fields);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="lg"
        title={`Assign engineers — ${workOrder.workOrderNo}`}
        description={workOrder.site?.name}
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy}>
              Save assignment
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <EngineerPicker
            idPrefix="assign-eng"
            engineers={workload.data}
            loading={workload.isLoading}
            value={ids}
            onChange={setIds}
            lead={lead}
            onLeadChange={setLead}
            error={errors.assigneeIds}
            leadError={errors.leadEngineerId}
          />
          <FormField label="Planned visit start" error={errors.plannedVisitAt} help="Optional. Your local time.">
            {(p) => <Input {...p} type="datetime-local" value={planned} onChange={(e) => setPlanned(e.target.value)} />}
          </FormField>
          <FormField
            label="Reason"
            required={needsReason}
            error={errors.reason}
            help={
              workOrder.status === 'ACCEPTED' || workOrder.status === 'SCHEDULED'
                ? 'This work has been accepted. Changing engineers requires a reason and sends it back for acceptance.'
                : 'Optional — recorded in the assignment history.'
            }
          >
            {(p) => <Textarea {...p} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Edit planning fields (until work starts). Changing the due date needs a reason. */
export function PlanningDialog({
  workOrder,
  open,
  onOpenChange,
  onChanged,
}: {
  workOrder: WorkOrderDetailDto;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onChanged: (w: WorkOrderDetailDto) => void;
}) {
  const init = (): PlanningFormValues => ({
    title: workOrder.title,
    description: workOrder.description,
    workScope: workOrder.workScope ?? '',
    priorityId: workOrder.priority?.id ?? '',
    plannedVisitAt: toLocalInput(workOrder.plannedVisitAt ?? null),
    plannedEndAt: toLocalInput(workOrder.plannedEndAt ?? null),
    dueAt: toLocalInput(workOrder.dueAt ?? null),
    shutdownRequired: workOrder.shutdownRequired,
    shutdownDetails: workOrder.shutdownDetails ?? '',
    materialRequired: workOrder.materialRequired,
    materialNotes: workOrder.materialNotes ?? '',
    reason: '',
  });
  const [v, setV] = useState<PlanningFormValues>(init);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setV(init());
      setErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workOrder.updatedAt]);
  const set = (patch: Partial<PlanningFormValues>) => setV((s) => ({ ...s, ...patch }));
  const dueChanged = v.dueAt !== toLocalInput(workOrder.dueAt ?? null) && Boolean(workOrder.dueAt);

  const submit = async () => {
    const { payload, errors: e } = validatePlanningForm(v, {
      title: workOrder.title,
      description: workOrder.description,
      workScope: workOrder.workScope,
      priorityId: workOrder.priority?.id,
      plannedVisitAt: workOrder.plannedVisitAt,
      plannedEndAt: workOrder.plannedEndAt,
      dueAt: workOrder.dueAt,
      shutdownRequired: workOrder.shutdownRequired,
      shutdownDetails: workOrder.shutdownDetails,
      materialRequired: workOrder.materialRequired,
      materialNotes: workOrder.materialNotes,
    });
    setErrors(e);
    if (!payload) return;
    if (!Object.keys(payload).filter((k) => k !== 'reason').length) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    try {
      const res = await api.patch<WorkOrderDetailDto>(`/work-orders/${workOrder.id}`, payload);
      toast.success('Work order updated');
      onChanged(res.data);
      onOpenChange(false);
    } catch (err) {
      const pe = parseApiError(err);
      if (pe.fields) setErrors(pe.fields);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="lg"
        title={`Edit ${workOrder.workOrderNo}`}
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy}>
              Save changes
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <PlanningFields prefix="edit" v={v} set={set} errors={errors} />
          <FormField
            label="Reason for change"
            required={dueChanged}
            error={errors.reason}
            help={dueChanged ? 'Required because the due date changed. Recorded in the audit trail.' : 'Optional — recorded in the audit trail.'}
          >
            {(p) => <Textarea {...p} rows={2} maxLength={1000} value={v.reason} onChange={(e) => set({ reason: e.target.value })} />}
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}
