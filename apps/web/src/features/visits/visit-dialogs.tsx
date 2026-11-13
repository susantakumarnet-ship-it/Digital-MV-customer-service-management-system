import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, ClipboardCheck, MapPinned, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { visitCreateSchema, temporaryAssetSchema, type InspectionReportDto, type PermissionKey, type VisitDetailDto, type WorkOrderDetailDto } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { StatusBadge, toneOf } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/controls';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FormField, Input, Select, Textarea } from '@/components/ui/form';
import { EmptyState, ErrorState } from '@/components/states';
import { useAuth } from '@/features/auth/auth-context';
import { fromLocalInput, toLocalInput } from '@/features/work-orders/wo-lib';
import { api, errorMessage, parseApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { MasterOption } from '@/lib/types';
import { useVisits } from './visit-lib';

const VISIT_FROM_WO = ['ACCEPTED', 'SCHEDULED', 'IN_PROGRESS', 'WORK_COMPLETED'];

function zodErrors(issues: { path: (string | number)[]; message: string }[]) {
  const out: Record<string, string> = {};
  for (const i of issues) out[String(i.path[0] ?? '_')] ??= i.message;
  return out;
}

/** Can the signed-in user plan a visit for this work order? (mirrors visit.service createVisit) */
export function canPlanVisit(w: WorkOrderDetailDto, userId: string | undefined, hasPermission: (p: PermissionKey) => boolean) {
  const isAssignee = w.assignees.some((a) => a.id === userId);
  return hasPermission('visit.create') && VISIT_FROM_WO.includes(w.status) && (isAssignee || hasPermission('workOrder.update'));
}

/** ENG-02: plan a visit for an accepted work order. */
export function PlanVisitDialog({ workOrder, open, onOpenChange }: { workOrder: WorkOrderDetailDto; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const meAssigned = workOrder.assignees.some((a) => a.id === user?.id);
  const [purpose, setPurpose] = useState('');
  const [plannedAt, setPlannedAt] = useState('');
  const [engineerIds, setEngineerIds] = useState<string[]>([]);
  const [attendees, setAttendees] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPurpose(`Site inspection & repair — ${workOrder.title}`.slice(0, 500));
    setPlannedAt(toLocalInput(workOrder.plannedVisitAt));
    const lead = workOrder.assignees.find((a) => a.lead)?.id ?? workOrder.assignees[0]?.id;
    setEngineerIds(meAssigned && user ? [user.id] : lead ? [lead] : []);
    setAttendees('');
    setNotes('');
    setErrors({});
  }, [open, workOrder, meAssigned, user]);

  const submit = async () => {
    const body = { purpose, plannedAt: fromLocalInput(plannedAt), engineerIds, attendees, notes };
    const parsed = visitCreateSchema.safeParse(body);
    const errs = parsed.success ? {} : zodErrors(parsed.error.issues);
    if (!engineerIds.length) errs.engineerIds = 'Select at least one engineer';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const res = await api.post<VisitDetailDto>(`/work-orders/${workOrder.id}/visits`, body);
      toast.success(`Visit ${res.data.visitNo} planned`);
      void qc.invalidateQueries({ queryKey: ['visits'] });
      onOpenChange(false);
      navigate(`/visits/${res.data.id}`);
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
        title={`Plan a visit — ${workOrder.workOrderNo}`}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy}>
              Create visit
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Purpose" required error={errors.purpose} className="sm:col-span-2">
            {(p) => <Input {...p} maxLength={500} value={purpose} onChange={(e) => setPurpose(e.target.value)} />}
          </FormField>
          <FormField label="Planned date and time" error={errors.plannedAt} help="Your local time. Optional.">
            {(p) => <Input {...p} type="datetime-local" value={plannedAt} onChange={(e) => setPlannedAt(e.target.value)} />}
          </FormField>
          <fieldset className="sm:col-span-2">
            <legend className="field-label">Engineers on this visit</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {workOrder.assignees.map((a) => {
                const id = `visit-eng-${a.id}`;
                return (
                  <label key={a.id} htmlFor={id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm">
                    <Checkbox
                      id={id}
                      checked={engineerIds.includes(a.id)}
                      onCheckedChange={(c) => setEngineerIds((cur) => (c === true ? [...cur, a.id] : cur.filter((x) => x !== a.id)))}
                    />
                    <span className="text-navy-900">
                      {a.name}
                      {a.id === user?.id && <span className="text-slate-500"> (me)</span>}
                    </span>
                  </label>
                );
              })}
            </div>
            {errors.engineerIds && (
              <p className="mt-1 text-xs text-red-600" role="alert">
                {errors.engineerIds}
              </p>
            )}
          </fieldset>
          <FormField label="Other attendees" error={errors.attendees} help="Customer staff, contractors (optional)." className="sm:col-span-2">
            {(p) => <Input {...p} maxLength={1000} value={attendees} onChange={(e) => setAttendees(e.target.value)} />}
          </FormField>
          <FormField label="Notes" error={errors.notes} className="sm:col-span-2">
            {(p) => <Textarea {...p} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Visits panel on the work-order detail page. */
export function WorkOrderVisitsPanel({ workOrder }: { workOrder: WorkOrderDetailDto }) {
  const { user, hasPermission } = useAuth();
  const [open, setOpen] = useState(false);
  const q = useVisits({ workOrderId: workOrder.id, limit: 50, sort: '-createdAt' }, hasPermission('visit.read'));
  if (!hasPermission('visit.read')) return null;
  const canPlan = canPlanVisit(workOrder, user?.id, hasPermission);
  return (
    <Card>
      <CardHeader
        title="Visits"
        description="Site visits with six-step time tracking"
        actions={
          canPlan ? (
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              <CalendarPlus className="h-4 w-4" /> Plan a visit
            </Button>
          ) : undefined
        }
      />
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <div className="space-y-2 p-5">
          <div className="skeleton h-5" />
        </div>
      ) : !q.data?.data.length ? (
        <EmptyState icon={<MapPinned className="h-6 w-6" />} title="No visits yet" description={canPlan ? 'Plan a visit to start recording time on site.' : undefined} />
      ) : (
        <ul className="divide-y divide-border">
          {q.data.data.map((v) => (
            <li key={v.id}>
              <Link to={`/visits/${v.id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-slate-50">
                <span className="min-w-0">
                  <span className="font-mono font-medium text-royal-700">{v.visitNo}</span>
                  <span className="ml-2 text-slate-700">{v.purpose}</span>
                  <span className="block text-xs text-slate-500">
                    {v.plannedAt ? `Planned ${formatDateTime(v.plannedAt)}` : 'Not scheduled'} · {v.engineers.map((e) => e.name).join(', ')}
                  </span>
                </span>
                <StatusBadge status={v.status} label={v.statusLabel} tone={toneOf(v.statusTone)} />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {canPlan && <PlanVisitDialog workOrder={workOrder} open={open} onOpenChange={setOpen} />}
    </Card>
  );
}

// ---- Inspection start --------------------------------------------------------------------------

/** "Inspection" card on the visit: start the report (asset select / temporary asset) or open it. */
export function InspectionCard({ visit }: { visit: VisitDetailDto }) {
  const navigate = useNavigate();
  const [assetId, setAssetId] = useState('');
  const [tempOpen, setTempOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const canStart = visit.permissions.canInspect && visit.inspectionReports.length === 0;
  const assets = useQuery({
    queryKey: ['visit-assets', visit.site?.id],
    queryFn: async () =>
      (await api.get<MasterOption[]>('/complaints/options/assets', { params: { parentField: 'siteId', parentId: visit.site?.id } })).data,
    enabled: canStart && Boolean(visit.site?.id),
  });

  const start = async () => {
    setBusy(true);
    try {
      const res = await api.post<InspectionReportDto>(`/visits/${visit.id}/inspection-reports`, assetId ? { assetId } : {});
      navigate(`/inspection-reports/${res.data.id}`);
    } catch (err) {
      const e = parseApiError(err);
      toast.error(e.code === 'NO_TEMPLATE' ? 'No checklist is published for this equipment type yet. Ask an administrator to publish one.' : e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Inspection" description="Checklist for the equipment inspected on this visit" />
      {visit.inspectionReports.length ? (
        <ul className="divide-y divide-border">
          {visit.inspectionReports.map((r) => (
            <li key={r.id}>
              <Link to={`/inspection-reports/${r.id}`} className="flex items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-slate-50">
                <span>
                  <ClipboardCheck className="mr-1.5 inline h-4 w-4 text-teal-600" aria-hidden />
                  Inspection report · revision {r.revisionNo}
                  {r.submittedAt && <span className="block text-xs text-slate-500">Submitted {formatDateTime(r.submittedAt)}</span>}
                </span>
                <StatusBadge status={r.status} label={r.statusLabel} tone={r.status === 'DRAFT' ? 'neutral' : r.status === 'APPROVED' ? 'success' : r.status === 'RETURNED' ? 'danger' : 'warning'} />
              </Link>
            </li>
          ))}
        </ul>
      ) : canStart ? (
        <CardBody className="space-y-3">
          <FormField label="Asset inspected" help="The asset's equipment type determines the checklist. Leave as the work order's asset if unsure.">
            {(p) => (
              <Select {...p} value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                <option value="">Work order asset (default)</option>
                {assets.data?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label} ({a.code})
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <div className="flex flex-wrap gap-2">
            <Button variant="accent" size="lg" className="h-12 w-full sm:w-auto" loading={busy} onClick={start}>
              <ClipboardCheck className="h-5 w-5" /> Start inspection
            </Button>
            <Button variant="outline" onClick={() => setTempOpen(true)}>
              <Plus className="h-4 w-4" /> Record a temporary asset
            </Button>
          </div>
          <TemporaryAssetDialog
            visitId={visit.id}
            open={tempOpen}
            onOpenChange={setTempOpen}
            onCreated={(a) => {
              void assets.refetch();
              setAssetId(a.id);
            }}
          />
        </CardBody>
      ) : (
        <EmptyState icon={<ClipboardCheck className="h-6 w-6" />} title="No inspection report yet" />
      )}
    </Card>
  );
}

/** MD-08: record an asset found on site that is not in the asset register (reviewed later). */
export function TemporaryAssetDialog({
  visitId,
  open,
  onOpenChange,
  onCreated,
}: {
  visitId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (a: { id: string; code: string; name: string }) => void;
}) {
  const [v, setV] = useState({ name: '', equipmentTypeId: '', manufacturer: '', model: '', serialNumber: '', rating: '', description: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const eq = useQuery({
    queryKey: ['complaint-options', 'equipmentTypes'],
    queryFn: async () => (await api.get<MasterOption[]>('/complaints/options/equipmentTypes')).data,
    enabled: open,
  });
  useEffect(() => {
    if (open) {
      setV({ name: '', equipmentTypeId: '', manufacturer: '', model: '', serialNumber: '', rating: '', description: '' });
      setErrors({});
    }
  }, [open]);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((cur) => ({ ...cur, [k]: e.target.value }));

  const submit = async () => {
    const parsed = temporaryAssetSchema.safeParse(v);
    if (!parsed.success) return setErrors(zodErrors(parsed.error.issues));
    setBusy(true);
    try {
      const res = await api.post<{ id: string; code: string; name: string }>(`/visits/${visitId}/temporary-assets`, v);
      toast.success(`Temporary asset ${res.data.code} recorded — a supervisor will review it`);
      onCreated(res.data);
      onOpenChange(false);
    } catch (err) {
      const e = parseApiError(err);
      if (e.fields) setErrors(e.fields);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Record a temporary asset"
        description="Use this when the equipment on site is not in the asset register. A supervisor reviews it before it becomes permanent."
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy}>
              Record asset
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Name" required error={errors.name} className="sm:col-span-2">
            {(p) => <Input {...p} maxLength={150} value={v.name} onChange={set('name')} />}
          </FormField>
          <FormField label="Equipment type" required error={errors.equipmentTypeId} className="sm:col-span-2">
            {(p) => (
              <Select {...p} value={v.equipmentTypeId} onChange={set('equipmentTypeId')}>
                <option value="">Select…</option>
                {eq.data?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Manufacturer" error={errors.manufacturer}>
            {(p) => <Input {...p} maxLength={120} value={v.manufacturer} onChange={set('manufacturer')} />}
          </FormField>
          <FormField label="Model" error={errors.model}>
            {(p) => <Input {...p} maxLength={120} value={v.model} onChange={set('model')} />}
          </FormField>
          <FormField label="Serial number" error={errors.serialNumber}>
            {(p) => <Input {...p} maxLength={120} value={v.serialNumber} onChange={set('serialNumber')} />}
          </FormField>
          <FormField label="Rating" error={errors.rating}>
            {(p) => <Input {...p} maxLength={120} value={v.rating} onChange={set('rating')} />}
          </FormField>
          <FormField label="Description" error={errors.description} className="sm:col-span-2">
            {(p) => <Textarea {...p} maxLength={1000} value={v.description} onChange={set('description')} />}
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}
