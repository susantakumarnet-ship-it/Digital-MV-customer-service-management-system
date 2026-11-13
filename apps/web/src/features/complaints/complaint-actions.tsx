import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { toast } from 'sonner';
import type { ComplaintDetailDto, ComplaintSummaryDto, Paged } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FormField, Input, Textarea } from '@/components/ui/form';
import { Badge, StatusBadge, toneOf } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { cn } from '@/lib/utils';

type Action = ComplaintDetailDto['availableActions'][number];

const DANGER = new Set(['reject', 'cancel', 'markDuplicate', 'reopen']);

/**
 * Workflow action buttons rendered strictly from the server's `availableActions` (never hard-coded).
 * Actions requiring a reason collect one; confirm=true actions ask for confirmation.
 */
export function ComplaintActions({ complaint, onChanged, hide = [] }: { complaint: ComplaintDetailDto; onChanged: (c: ComplaintDetailDto) => void; hide?: string[] }) {
  const [active, setActive] = useState<Action | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const actions = complaint.availableActions.filter((a) => !hide.includes(a.action));
  if (!actions.length) return null;

  const run = async (action: string, extra: { reason?: string; duplicateOfId?: string; messageToCustomer?: string } = {}) => {
    try {
      const res = await api.post<ComplaintDetailDto>(`/complaints/${complaint.id}/transitions`, { action, ...extra });
      onChanged(res.data);
      toast.success(`${res.data.referenceNo}: ${res.data.statusLabel}`);
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  };

  const click = async (a: Action) => {
    if (a.requiresReason || a.confirm || a.action === 'markDuplicate') {
      setMessage('');
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
      <div className="flex flex-wrap gap-2" aria-label="Workflow actions">
        {actions.map((a) => (
          <Button key={a.action} variant={DANGER.has(a.action) ? 'outline' : 'secondary'} size="sm" loading={busy === a.action} onClick={() => click(a)} className={cn(DANGER.has(a.action) && 'text-red-700')}>
            {a.label}
          </Button>
        ))}
      </div>

      {active && active.action === 'markDuplicate' ? (
        <DuplicateDialog
          complaint={complaint}
          open
          onOpenChange={(o) => !o && setActive(null)}
          onConfirm={async (duplicateOfId, reason) => {
            await run('markDuplicate', { duplicateOfId, reason });
            setActive(null);
          }}
        />
      ) : (
        <ConfirmDialog
          open={Boolean(active)}
          onOpenChange={(o) => !o && setActive(null)}
          title={active ? `${active.label}?` : ''}
          description={active?.action === 'requestInfo' ? 'The complaint will wait for the customer. They are notified by email (and in the portal if they have an account).' : `Complaint ${complaint.referenceNo}`}
          confirmLabel={active?.label ?? 'Confirm'}
          tone={active && DANGER.has(active.action) ? 'danger' : 'primary'}
          reason={active?.requiresReason ? 'required' : undefined}
          reasonLabel={active?.action === 'requestInfo' ? 'What information is needed? (reason)' : 'Reason'}
          onConfirm={(reason) => run(active!.action, { reason: reason || undefined, messageToCustomer: active?.action === 'requestInfo' && message.trim() ? message.trim() : undefined })}
        >
          {active?.action === 'requestInfo' && (
            <div>
              <label htmlFor="msg-to-customer" className="field-label">
                Message to customer (optional)
              </label>
              <Textarea id="msg-to-customer" rows={3} maxLength={4000} value={message} onChange={(e) => setMessage(e.target.value)} />
              <p className="mt-1 text-xs text-slate-500">If empty, the reason is sent to the customer.</p>
            </div>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}

type Candidate = ComplaintSummaryDto & { sameAsset?: boolean; sameEmail?: boolean };

/** BR-003: pick the original complaint (suggestions first, or search) and give a reason. */
export function DuplicateDialog({
  complaint,
  open,
  onOpenChange,
  onConfirm,
}: {
  complaint: ComplaintDetailDto;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (duplicateOfId: string, reason: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const q = useDebounced(search, 350);

  const suggestions = useQuery({
    queryKey: ['complaints', complaint.id, 'possible-duplicates'],
    queryFn: async () => (await api.get<Candidate[]>(`/complaints/${complaint.id}/possible-duplicates`)).data,
    enabled: open,
  });
  const results = useQuery({
    queryKey: ['complaints', 'dup-search', q],
    queryFn: async () => (await api.get<Paged<ComplaintSummaryDto>>('/complaints', { params: { q, limit: 10, status: undefined } })).data,
    enabled: open && q.trim().length >= 2,
  });

  const searchRows = (results.data?.data ?? []).filter((c) => c.id !== complaint.id && c.status !== 'DUPLICATE');
  const submit = async () => {
    setTouched(true);
    if (!selected || !reason.trim()) return;
    setBusy(true);
    try {
      await onConfirm(selected, reason.trim());
    } catch {
      /* toast shown by caller */
    } finally {
      setBusy(false);
    }
  };

  const Row = ({ c }: { c: Candidate }) => (
    <label className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm', selected === c.id ? 'border-royal-700 bg-royal-50' : 'border-border hover:bg-slate-50')}>
      <input type="radio" name="dup-target" className="mt-1" checked={selected === c.id} onChange={() => setSelected(c.id)} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono font-medium text-navy-900">{c.referenceNo}</span>
          <StatusBadge status={c.status} label={c.statusLabel} tone={toneOf(c.statusTone)} />
          {c.sameAsset && <Badge tone="warning">Same asset</Badge>}
          {c.sameEmail && <Badge tone="info">Same reporter</Badge>}
        </span>
        <span className="mt-0.5 block truncate text-slate-600">
          {c.customerName} · {c.site?.name} · {formatDateTime(c.receivedAt)}
        </span>
      </span>
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        title={`Mark ${complaint.referenceNo} as duplicate`}
        description="The original submission is kept and linked to the complaint you select."
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" onClick={submit} loading={busy}>
              Mark as duplicate
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <section>
            <h3 className="text-sm font-medium text-navy-900">Possible originals (same site, recent)</h3>
            {suggestions.isLoading ? (
              <div className="mt-2 space-y-2">
                <div className="skeleton h-12" />
                <div className="skeleton h-12" />
              </div>
            ) : suggestions.isError ? (
              <p className="mt-2 text-sm text-red-600">{errorMessage(suggestions.error)}</p>
            ) : !suggestions.data?.length ? (
              <p className="mt-2 text-sm text-slate-500">No recent open complaints for this site.</p>
            ) : (
              <div className="mt-2 space-y-2">
                {suggestions.data.map((c) => (
                  <Row key={c.id} c={c} />
                ))}
              </div>
            )}
          </section>
          <section>
            <h3 className="text-sm font-medium text-navy-900">Or search all complaints</h3>
            <div className="relative mt-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <Input aria-label="Search for the original complaint" placeholder="Reference, customer or site" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            {q.trim().length >= 2 && (
              <div className="mt-2 space-y-2">
                {results.isFetching && !results.data ? (
                  <div className="skeleton h-12" />
                ) : !searchRows.length ? (
                  <p className="text-sm text-slate-500">No matching complaints.</p>
                ) : (
                  searchRows.map((c) => <Row key={c.id} c={c} />)
                )}
              </div>
            )}
          </section>
          {touched && !selected && (
            <p className="text-sm text-red-600" role="alert">
              Select the original complaint.
            </p>
          )}
          <FormField label="Reason" required error={touched && !reason.trim() ? 'A reason is required' : undefined}>
            {(p) => <Textarea {...p} rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}
