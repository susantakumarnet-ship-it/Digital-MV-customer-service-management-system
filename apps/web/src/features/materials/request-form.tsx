import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { MaterialRequestDetailDto, MaterialUrgency } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FormField, Input, Select, Textarea } from '@/components/ui/form';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage, parseApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  MATERIAL_URGENCIES,
  formatQty,
  linesPayload,
  newLine,
  useCatalogueSearch,
  useItemAvailability,
  validateLines,
  type CatalogueItem,
  type LineDraft,
} from './material-lib';

// ---- Catalogue item picker -------------------------------------------------------------------------

/** Searchable catalogue select: type to search by code or name; shows unit. */
export function ItemPicker({ id, value, onChange, invalid }: { id: string; value: CatalogueItem | null; onChange: (v: CatalogueItem | null) => void; invalid?: boolean }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const search = useCatalogueSearch(debounced);
  const options = search.data ?? [];
  // Keep the selected item visible even when it is not in the current search result.
  const list = value && !options.some((o) => o.id === value.id) ? [value, ...options] : options;
  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <Input aria-label="Search catalogue" placeholder="Search by code or name" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Select
        id={id}
        aria-invalid={invalid || undefined}
        value={value?.id ?? ''}
        onChange={(e) => onChange(list.find((o) => o.id === e.target.value) ?? null)}
      >
        <option value="">{search.isLoading ? 'Loading catalogue…' : list.length ? 'Select an item' : 'No matching items'}</option>
        {list.map((o) => (
          <option key={o.id} value={o.id}>
            {o.code} — {o.name} ({o.unit})
          </option>
        ))}
      </Select>
    </div>
  );
}

function StockHint({ itemId, unit }: { itemId: string; unit: string }) {
  const { hasPermission } = useAuth();
  const q = useItemAvailability(itemId, hasPermission('inventory.read'));
  if (!hasPermission('inventory.read') || !q.data) return null;
  const total = q.data.reduce((a, b) => a + b.available, 0);
  return <span className={cn('text-xs', total > 0 ? 'text-teal-700' : 'text-amber-700')}>{formatQty(total, unit)} available across stores</span>;
}

// ---- Lines editor ------------------------------------------------------------------------------------

/** MAT-01 lines editor: catalogue item, quantity (unit suffix), optional specification and reason. */
export function LinesEditor({ lines, onChange, errors }: { lines: LineDraft[]; onChange: (l: LineDraft[]) => void; errors: Record<string, string> }) {
  const set = (i: number, patch: Partial<LineDraft>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="space-y-3">
      {lines.map((l, i) => (
        <fieldset key={l.key} className="rounded-lg border border-border p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Item {i + 1}</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <FormField label="Catalogue item" required error={errors[`lines.${i}.item`]} className="sm:col-span-2">
              {(p) => <ItemPicker id={p.id} value={l.item} invalid={Boolean(errors[`lines.${i}.item`])} onChange={(item) => set(i, { item })} />}
            </FormField>
            <FormField label="Quantity" required error={errors[`lines.${i}.quantity`]} help={l.item ? <StockHint itemId={l.item.id} unit={l.item.unit} /> : undefined}>
              {(p) => (
                <div className="flex items-center gap-2">
                  <Input {...p} type="number" inputMode="decimal" min={0} step="any" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} />
                  <span className="shrink-0 text-sm text-slate-500">{l.item?.unit ?? ''}</span>
                </div>
              )}
            </FormField>
            <FormField label="Specification (optional)" className="sm:col-span-2">
              {(p) => <Input {...p} maxLength={1000} placeholder={l.item?.specification ?? 'Size, rating, part number…'} value={l.specification} onChange={(e) => set(i, { specification: e.target.value })} />}
            </FormField>
            <FormField label="Line reason (optional)">
              {(p) => <Input {...p} maxLength={1000} value={l.reason} onChange={(e) => set(i, { reason: e.target.value })} />}
            </FormField>
          </div>
          {lines.length > 1 && (
            <div className="mt-2 flex justify-end">
              <Button variant="ghost" size="sm" className="text-red-700" onClick={() => onChange(lines.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4" /> Remove item
              </Button>
            </div>
          )}
        </fieldset>
      ))}
      {errors.lines && (
        <p className="text-sm text-red-600" role="alert">
          {errors.lines}
        </p>
      )}
      <Button variant="outline" size="sm" onClick={() => onChange([...lines, newLine()])} disabled={lines.length >= 50}>
        <Plus className="h-4 w-4" /> Add item
      </Button>
    </div>
  );
}

function UrgencyControl({ value, onChange }: { value: MaterialUrgency; onChange: (v: MaterialUrgency) => void }) {
  return (
    <div role="radiogroup" aria-label="Urgency" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {MATERIAL_URGENCIES.map((u) => (
        <button
          key={u.value}
          type="button"
          role="radio"
          aria-checked={value === u.value}
          onClick={() => onChange(u.value)}
          className={cn(
            'min-h-10 rounded-lg border px-2 text-sm font-medium',
            value === u.value ? (u.value === 'CRITICAL' ? 'border-red-600 bg-red-600 text-white' : 'border-navy-900 bg-navy-900 text-white') : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
          )}
        >
          {u.label}
        </button>
      ))}
    </div>
  );
}

// ---- Raise request ---------------------------------------------------------------------------------

/** Raise a material request from a work order (and optionally a visit). */
export function RaiseMaterialRequestDialog({
  open,
  onOpenChange,
  workOrderId,
  workOrderNo,
  visitId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workOrderId: string;
  workOrderNo: string;
  visitId?: string;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [urgency, setUrgency] = useState<MaterialUrgency>('NORMAL');
  const [reason, setReason] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'submit' | 'draft' | null>(null);

  useEffect(() => {
    if (open) {
      setUrgency('NORMAL');
      setReason('');
      setNeededBy('');
      setLines([newLine()]);
      setErrors({});
    }
  }, [open]);

  const save = async (submit: boolean) => {
    const e = validateLines(lines);
    if (reason.trim().length < 3) e.reason = 'Explain why the material is needed';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(submit ? 'submit' : 'draft');
    try {
      const { data } = await api.post<MaterialRequestDetailDto>('/material-requests', {
        workOrderId,
        visitId,
        urgency,
        reason: reason.trim(),
        neededBy: neededBy ? new Date(neededBy).toISOString() : undefined,
        lines: linesPayload(lines),
        submit,
      });
      toast.success(submit ? `Material request ${data.requestNo} submitted` : `Draft ${data.requestNo} saved`);
      void qc.invalidateQueries({ queryKey: ['material-requests'] });
      onOpenChange(false);
      navigate(`/materials/${data.id}`);
    } catch (err) {
      const pe = parseApiError(err);
      if (pe.fields) setErrors(pe.fields);
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="lg"
        title={`Request material — ${workOrderNo}`}
        description="Items come from the material catalogue. Approval does not guarantee stock availability."
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={Boolean(busy)}>
              Cancel
            </Button>
            <Button variant="outline" onClick={() => save(false)} loading={busy === 'draft'} disabled={Boolean(busy)}>
              Save as draft
            </Button>
            <Button onClick={() => save(true)} loading={busy === 'submit'} disabled={Boolean(busy)}>
              Submit request
            </Button>
          </>
        }
      >
        <RequestFields
          urgency={urgency}
          onUrgency={setUrgency}
          reason={reason}
          onReason={setReason}
          neededBy={neededBy}
          onNeededBy={setNeededBy}
          lines={lines}
          onLines={setLines}
          errors={errors}
        />
      </DialogContent>
    </Dialog>
  );
}

function RequestFields(p: {
  urgency: MaterialUrgency;
  onUrgency: (u: MaterialUrgency) => void;
  reason: string;
  onReason: (s: string) => void;
  neededBy: string;
  onNeededBy: (s: string) => void;
  lines: LineDraft[];
  onLines: (l: LineDraft[]) => void;
  errors: Record<string, string>;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="field-label">Urgency</p>
        <UrgencyControl value={p.urgency} onChange={p.onUrgency} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <FormField label="Why is the material needed?" required error={p.errors.reason} className="sm:col-span-2">
          {(f) => <Textarea {...f} rows={2} maxLength={2000} value={p.reason} onChange={(e) => p.onReason(e.target.value)} />}
        </FormField>
        <FormField label="Needed by (optional)" error={p.errors.neededBy}>
          {(f) => <Input {...f} type="date" value={p.neededBy} onChange={(e) => p.onNeededBy(e.target.value)} />}
        </FormField>
      </div>
      <LinesEditor lines={p.lines} onChange={p.onLines} errors={p.errors} />
    </div>
  );
}

// ---- Edit / resubmit (requester) -----------------------------------------------------------------

export function EditRequestDialog({ request, open, onOpenChange }: { request: MaterialRequestDetailDto; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [urgency, setUrgency] = useState<MaterialUrgency>(request.urgency);
  const [reason, setReason] = useState(request.reason);
  const [neededBy, setNeededBy] = useState('');
  const [reply, setReply] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const clarifying = request.status === 'CLARIFICATION_REQUIRED';

  useEffect(() => {
    if (!open) return;
    setUrgency(request.urgency);
    setReason(request.reason);
    setNeededBy(request.neededBy ? new Date(request.neededBy).toISOString().slice(0, 10) : '');
    setReply('');
    setErrors({});
    setLines(
      request.lines.map((l) => ({
        key: l.lineId,
        item: { id: l.item.id, code: l.item.code ?? '', name: l.item.name, unit: l.item.unit, specification: l.item.specification },
        quantity: String(l.quantity),
        specification: l.specification ?? '',
        reason: l.reason ?? '',
      })),
    );
  }, [open, request]);

  const save = async () => {
    const e = validateLines(lines);
    if (reason.trim().length < 3) e.reason = 'Explain why the material is needed';
    if (clarifying && !reply.trim()) e.clarificationReply = 'Answer the supervisor’s question';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api.patch(`/material-requests/${request.id}`, {
        urgency,
        reason: reason.trim(),
        neededBy: neededBy ? new Date(neededBy).toISOString() : null,
        lines: linesPayload(lines),
        clarificationReply: reply.trim() || undefined,
      });
      if (request.permissions.canSubmit) await api.post(`/material-requests/${request.id}/submit`);
      toast.success(request.permissions.canSubmit ? 'Request updated and submitted' : 'Request updated');
      void qc.invalidateQueries({ queryKey: ['material-requests'] });
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
        title={`Edit ${request.requestNo}`}
        description={clarifying ? 'The supervisor asked for clarification. Answer below, adjust the request and resubmit.' : 'Edit the draft and submit it for approval.'}
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={save} loading={busy}>
              {request.permissions.canSubmit ? 'Save & submit' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {clarifying && (
            <FormField label="Your reply to the supervisor" required error={errors.clarificationReply}>
              {(f) => <Textarea {...f} rows={2} maxLength={2000} value={reply} onChange={(e) => setReply(e.target.value)} />}
            </FormField>
          )}
          <RequestFields
            urgency={urgency}
            onUrgency={setUrgency}
            reason={reason}
            onReason={setReason}
            neededBy={neededBy}
            onNeededBy={setNeededBy}
            lines={lines}
            onLines={setLines}
            errors={errors}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
