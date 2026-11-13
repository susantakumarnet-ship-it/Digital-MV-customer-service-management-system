import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Paperclip } from 'lucide-react';
import { toast } from 'sonner';
import type { MaterialLineDto, MaterialRequestDetailDto } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FormField, Input, Select, Textarea } from '@/components/ui/form';
import { TagInput } from '@/components/tag-input';
import { multipartBody } from '@/features/complaints/complaint-lib';
import { api, errorMessage, parseApiError } from '@/lib/api';
import { useMasterOptions } from '@/lib/queries';
import {
  availableIn,
  describeStoreError,
  formatQty,
  useItemAvailability,
  validateIssue,
  validateReturn,
  type IssueValues,
  type ReturnValues,
} from './material-lib';

type Done = (r: MaterialRequestDetailDto) => void;

interface BaseProps {
  request: MaterialRequestDetailDto;
  line: MaterialLineDto;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

function useApply() {
  const qc = useQueryClient();
  return (r: MaterialRequestDetailDto) => {
    qc.setQueryData(['material-requests', 'detail', r.id], r);
    void qc.invalidateQueries({ queryKey: ['material-requests', 'list'] });
    void qc.invalidateQueries({ queryKey: ['material-requests', 'summary'] });
    void qc.invalidateQueries({ queryKey: ['inventory'] });
  };
}

function StoreErrorBox({ message, hint, action }: { message: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="alert">
      <p className="flex items-start gap-2 font-medium">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {message}
      </p>
      {hint && <p className="mt-1">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Warehouse select annotated with this item's available stock in each store. */
function WarehouseSelect({ id, itemId, value, onChange, invalid }: { id: string; itemId: string; value: string; onChange: (v: string) => void; invalid?: boolean }) {
  const whs = useMasterOptions('warehouses');
  const stock = useItemAvailability(itemId);
  return (
    <Select id={id} aria-invalid={invalid || undefined} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Select warehouse</option>
      {whs.data?.map((w) => (
        <option key={w.id} value={w.id}>
          {w.label} — {formatQty(availableIn(stock.data, w.id))} available
        </option>
      ))}
    </Select>
  );
}

function Footer({ onCancel, onSubmit, busy, label }: { onCancel: () => void; onSubmit: () => void; busy: boolean; label: string }) {
  return (
    <>
      <Button variant="outline" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      <Button onClick={onSubmit} loading={busy}>
        {label}
      </Button>
    </>
  );
}

// ---- Reserve -------------------------------------------------------------------------------------

export function ReserveDialog({ request, line, open, onOpenChange }: BaseProps) {
  const apply = useApply();
  const room = Math.max(0, (line.approvedQty ?? 0) - line.issuedQty - line.reservedQty);
  const [warehouseId, setWarehouseId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [serverErr, setServerErr] = useState<ReturnType<typeof describeStoreError> | null>(null);
  useEffect(() => {
    if (open) {
      setWarehouseId('');
      setQuantity(String(Number(room.toFixed(3))));
      setErrors({});
      setServerErr(null);
    }
  }, [open, room]);
  const submit = async () => {
    const e: Record<string, string> = {};
    const n = Number(quantity);
    if (!warehouseId) e.warehouseId = 'Select a warehouse';
    if (!(n > 0)) e.quantity = 'Enter a quantity greater than zero';
    else if (n > room) e.quantity = `At most ${formatQty(room, line.item.unit)} can still be reserved`;
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setServerErr(null);
    try {
      const { data } = await api.post<MaterialRequestDetailDto>(`/material-requests/${request.id}/reserve`, { lineId: line.lineId, warehouseId, quantity: n });
      apply(data);
      toast.success(`Reserved ${formatQty(n, line.item.unit)} ${line.item.name}`);
      onOpenChange(false);
    } catch (err) {
      setServerErr(describeStoreError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent title={`Reserve — ${line.item.name}`} description={`Up to ${formatQty(room, line.item.unit)} can be reserved for this line.`} footer={<Footer onCancel={() => onOpenChange(false)} onSubmit={submit} busy={busy} label="Reserve" />}>
        <div className="space-y-3">
          <FormField label="Warehouse" required error={errors.warehouseId}>
            {(p) => <WarehouseSelect id={p.id} itemId={line.item.id} value={warehouseId} onChange={setWarehouseId} invalid={Boolean(errors.warehouseId)} />}
          </FormField>
          <FormField label={`Quantity (${line.item.unit})`} required error={errors.quantity}>
            {(p) => <Input {...p} type="number" inputMode="decimal" min={0} step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />}
          </FormField>
          {serverErr && <StoreErrorBox message={serverErr.message} hint={serverErr.hint} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- Release reservation ---------------------------------------------------------------------------

export function ReleaseDialog({ request, line, open, onOpenChange }: BaseProps) {
  const apply = useApply();
  const [warehouseId, setWarehouseId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      const first = line.reservations[0];
      setWarehouseId(first?.warehouse.id ?? '');
      setQuantity(first ? String(first.quantity) : '');
      setReason('');
      setErrors({});
    }
  }, [open, line]);
  const reserved = line.reservations.find((r) => r.warehouse.id === warehouseId)?.quantity ?? 0;
  const submit = async () => {
    const e: Record<string, string> = {};
    const n = Number(quantity);
    if (!warehouseId) e.warehouseId = 'Select a warehouse';
    if (!(n > 0)) e.quantity = 'Enter a quantity greater than zero';
    else if (n > reserved) e.quantity = `Only ${formatQty(reserved, line.item.unit)} is reserved there`;
    if (reason.trim().length < 3) e.reason = 'A reason is required';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const { data } = await api.post<MaterialRequestDetailDto>(`/material-requests/${request.id}/unreserve`, { lineId: line.lineId, warehouseId, quantity: n, reason: reason.trim() });
      apply(data);
      toast.success('Reservation released');
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent title={`Release reservation — ${line.item.name}`} footer={<Footer onCancel={() => onOpenChange(false)} onSubmit={submit} busy={busy} label="Release" />}>
        <div className="space-y-3">
          <FormField label="Warehouse" required error={errors.warehouseId}>
            {(p) => (
              <Select {...p} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                <option value="">Select warehouse</option>
                {line.reservations.map((r) => (
                  <option key={r.warehouse.id} value={r.warehouse.id}>
                    {r.warehouse.name} — {formatQty(r.quantity, line.item.unit)} reserved
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label={`Quantity (${line.item.unit})`} required error={errors.quantity}>
            {(p) => <Input {...p} type="number" inputMode="decimal" min={0} step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />}
          </FormField>
          <FormField label="Reason" required error={errors.reason}>
            {(p) => <Textarea {...p} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- Issue -------------------------------------------------------------------------------------------

/** MAT-03: issue with batch/serials, recipient and handover evidence. */
export function IssueDialog({ request, line, open, onOpenChange, onBackorder }: BaseProps & { onBackorder?: (shortfall: number) => void }) {
  const apply = useApply();
  const stock = useItemAvailability(line.item.id, open);
  const outstanding = line.outstandingQty;
  const [v, setV] = useState<IssueValues>({ warehouseId: '', quantity: '', batchNo: '', serialNumbers: [], recipientName: '', note: '' });
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [serverErr, setServerErr] = useState<ReturnType<typeof describeStoreError> | null>(null);
  useEffect(() => {
    if (open) {
      setV({
        warehouseId: line.reservations[0]?.warehouse.id ?? '',
        quantity: String(Number(outstanding.toFixed(3))),
        batchNo: '',
        serialNumbers: [],
        recipientName: request.requester.name,
        note: '',
      });
      setFiles([]);
      setErrors({});
      setServerErr(null);
    }
  }, [open, line, outstanding, request.requester.name]);
  const set = (patch: Partial<IssueValues>) => setV((cur) => ({ ...cur, ...patch }));
  const reservedHere = line.reservations.find((r) => r.warehouse.id === v.warehouseId)?.quantity ?? 0;
  const availableHere = availableIn(stock.data, v.warehouseId) + reservedHere;

  const submit = async () => {
    const e = validateIssue(v, outstanding);
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setServerErr(null);
    try {
      const body = multipartBody(
        {
          lineId: line.lineId,
          warehouseId: v.warehouseId,
          quantity: Number(v.quantity),
          batchNo: v.batchNo.trim() || undefined,
          serialNumbers: v.serialNumbers,
          recipientName: v.recipientName.trim(),
          note: v.note.trim() || undefined,
        },
        files,
      );
      const { data } = await api.post<MaterialRequestDetailDto>(`/material-requests/${request.id}/issue`, body);
      apply(data);
      toast.success(`Issued ${formatQty(Number(v.quantity), line.item.unit)} ${line.item.name}`);
      onOpenChange(false);
    } catch (err) {
      const d = describeStoreError(err);
      const pe = parseApiError(err);
      if (pe.fields) setErrors(pe.fields);
      setServerErr(d);
    } finally {
      setBusy(false);
    }
  };

  const shortfall = Math.max(0, Number(v.quantity) - availableHere);
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="lg"
        title={`Issue — ${line.item.name}`}
        description={`${formatQty(outstanding, line.item.unit)} approved and not yet issued.`}
        footer={<Footer onCancel={() => onOpenChange(false)} onSubmit={submit} busy={busy} label="Issue material" />}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Warehouse" required error={errors.warehouseId} className="sm:col-span-2" help={v.warehouseId ? `${formatQty(availableHere, line.item.unit)} can be issued from here (incl. ${formatQty(reservedHere)} reserved for this request)` : undefined}>
            {(p) => <WarehouseSelect id={p.id} itemId={line.item.id} value={v.warehouseId} onChange={(warehouseId) => set({ warehouseId })} invalid={Boolean(errors.warehouseId)} />}
          </FormField>
          <FormField label={`Quantity (${line.item.unit})`} required error={errors.quantity}>
            {(p) => <Input {...p} type="number" inputMode="decimal" min={0} step="any" value={v.quantity} onChange={(e) => set({ quantity: e.target.value })} />}
          </FormField>
          <FormField label="Batch number">
            {(p) => <Input {...p} maxLength={120} value={v.batchNo} onChange={(e) => set({ batchNo: e.target.value })} />}
          </FormField>
          <FormField label="Serial numbers" error={errors.serialNumbers} className="sm:col-span-2" help="Optional. One per unit — press Enter after each.">
            {(p) => <TagInput id={p.id} value={v.serialNumbers} onChange={(serialNumbers) => set({ serialNumbers })} invalid={Boolean(errors.serialNumbers)} placeholder="Scan or type a serial number" />}
          </FormField>
          <FormField label="Received by" required error={errors.recipientName}>
            {(p) => <Input {...p} maxLength={150} value={v.recipientName} onChange={(e) => set({ recipientName: e.target.value })} />}
          </FormField>
          <FormField label="Handover evidence" help="Photo of the signed handover note or delivery document (optional).">
            {(p) => (
              <label htmlFor={p.id} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 text-sm text-slate-600 hover:bg-slate-50">
                <Paperclip className="h-4 w-4" aria-hidden />
                {files.length ? `${files.length} file(s) selected` : 'Take photo or attach file'}
                <input
                  id={p.id}
                  type="file"
                  accept="image/*,application/pdf,.docx,.xlsx"
                  multiple
                  className="sr-only"
                  onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                />
              </label>
            )}
          </FormField>
          <FormField label="Note" className="sm:col-span-2">
            {(p) => <Textarea {...p} rows={2} maxLength={1000} value={v.note} onChange={(e) => set({ note: e.target.value })} />}
          </FormField>
          {serverErr && (
            <div className="sm:col-span-2">
              <StoreErrorBox
                message={serverErr.message}
                hint={serverErr.hint}
                action={
                  serverErr.code === 'INSUFFICIENT_STOCK' && onBackorder ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        onOpenChange(false);
                        onBackorder(shortfall > 0 ? Number(shortfall.toFixed(3)) : outstanding);
                      }}
                    >
                      Record backorder
                    </Button>
                  ) : undefined
                }
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- Backorder -----------------------------------------------------------------------------------

export function BackorderDialog({ request, line, open, onOpenChange, initialQty }: BaseProps & { initialQty?: number }) {
  const apply = useApply();
  const [quantity, setQuantity] = useState('');
  const [expectedAt, setExpectedAt] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setQuantity(String(initialQty ?? line.outstandingQty));
      setExpectedAt(line.backorderExpectedAt ? new Date(line.backorderExpectedAt).toISOString().slice(0, 10) : '');
      setNote('');
      setErrors({});
    }
  }, [open, initialQty, line]);
  const submit = async () => {
    const n = Number(quantity);
    const e: Record<string, string> = {};
    if (quantity.trim() === '' || !(n >= 0)) e.quantity = 'Enter 0 or more';
    else if (n > line.outstandingQty) e.quantity = `Cannot exceed the outstanding ${formatQty(line.outstandingQty, line.item.unit)}`;
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const { data } = await api.post<MaterialRequestDetailDto>(`/material-requests/${request.id}/backorder`, {
        lineId: line.lineId,
        quantity: n,
        expectedAt: expectedAt ? new Date(expectedAt).toISOString() : undefined,
        note: note.trim() || undefined,
      });
      apply(data);
      toast.success('Backorder recorded');
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent title={`Backorder — ${line.item.name}`} description="The requester is notified of the expected date." footer={<Footer onCancel={() => onOpenChange(false)} onSubmit={submit} busy={busy} label="Record backorder" />}>
        <div className="space-y-3">
          <FormField label={`Backorder quantity (${line.item.unit})`} required error={errors.quantity}>
            {(p) => <Input {...p} type="number" inputMode="decimal" min={0} step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />}
          </FormField>
          <FormField label="Expected date">
            {(p) => <Input {...p} type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} />}
          </FormField>
          <FormField label="Note">
            {(p) => <Textarea {...p} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- Return --------------------------------------------------------------------------------------

export function ReturnDialog({ request, line, open, onOpenChange }: BaseProps) {
  const apply = useApply();
  const returnable = Math.max(0, line.issuedQty - line.returnedQty - line.damagedQty);
  const [v, setV] = useState<ReturnValues>({ warehouseId: '', goodQty: '', damagedQty: '', reason: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setV({ warehouseId: '', goodQty: '', damagedQty: '', reason: '' });
      setErrors({});
    }
  }, [open]);
  const set = (patch: Partial<ReturnValues>) => setV((cur) => ({ ...cur, ...patch }));
  const submit = async () => {
    const e = validateReturn(v, returnable);
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const { data } = await api.post<MaterialRequestDetailDto>(`/material-requests/${request.id}/return`, {
        lineId: line.lineId,
        warehouseId: v.warehouseId,
        goodQty: Number(v.goodQty || 0),
        damagedQty: Number(v.damagedQty || 0),
        reason: v.reason.trim(),
      });
      apply(data);
      toast.success('Return recorded');
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        title={`Return — ${line.item.name}`}
        description={`${formatQty(returnable, line.item.unit)} issued and not yet returned. Good stock goes back on the shelf; damaged material is recorded but not restocked.`}
        footer={<Footer onCancel={() => onOpenChange(false)} onSubmit={submit} busy={busy} label="Record return" />}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Receiving warehouse" required error={errors.warehouseId} className="sm:col-span-2">
            {(p) => <WarehouseSelect id={p.id} itemId={line.item.id} value={v.warehouseId} onChange={(warehouseId) => set({ warehouseId })} invalid={Boolean(errors.warehouseId)} />}
          </FormField>
          <FormField label={`Good quantity (${line.item.unit})`} error={errors.goodQty}>
            {(p) => <Input {...p} type="number" inputMode="decimal" min={0} step="any" value={v.goodQty} onChange={(e) => set({ goodQty: e.target.value })} />}
          </FormField>
          <FormField label={`Damaged / unusable (${line.item.unit})`} error={errors.damagedQty}>
            {(p) => <Input {...p} type="number" inputMode="decimal" min={0} step="any" value={v.damagedQty} onChange={(e) => set({ damagedQty: e.target.value })} />}
          </FormField>
          <FormField label="Reason" required error={errors.reason} className="sm:col-span-2">
            {(p) => <Textarea {...p} rows={2} maxLength={1000} value={v.reason} onChange={(e) => set({ reason: e.target.value })} />}
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- Revised approval (BR-013) ----------------------------------------------------------------------

export function ReviseApprovalDialog({ request, line, open, onOpenChange }: BaseProps) {
  const apply = useApply();
  const floor = line.issuedQty + line.reservedQty;
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setQty(String(line.approvedQty ?? line.quantity));
      setReason('');
      setErrors({});
    }
  }, [open, line]);
  const submit = async () => {
    const n = Number(qty);
    const e: Record<string, string> = {};
    if (qty.trim() === '' || !(n >= 0)) e.approvedQty = 'Enter 0 or more';
    else if (n < floor) e.approvedQty = `Cannot go below what is already issued and reserved (${formatQty(floor, line.item.unit)})`;
    if (reason.trim().length < 3) e.reason = 'Explain the revised quantity';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const { data } = await api.post<MaterialRequestDetailDto>(`/material-requests/${request.id}/revise-approval`, { lineId: line.lineId, approvedQty: n, reason: reason.trim() });
      apply(data);
      toast.success('Approved quantity revised');
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
        title={`Revise approved quantity — ${line.item.name}`}
        description="BR-013: material can never be issued beyond the approved quantity. Revising it is recorded with your reason."
        footer={<Footer onCancel={() => onOpenChange(false)} onSubmit={submit} busy={busy} label="Save revised approval" />}
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Requested {formatQty(line.quantity, line.item.unit)} · currently approved {formatQty(line.approvedQty, line.item.unit)} · issued {formatQty(line.issuedQty)} · reserved {formatQty(line.reservedQty)}
          </p>
          <FormField label={`New approved quantity (${line.item.unit})`} required error={errors.approvedQty}>
            {(p) => <Input {...p} type="number" inputMode="decimal" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} />}
          </FormField>
          <FormField label="Reason" required error={errors.reason}>
            {(p) => <Textarea {...p} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export type { Done };
