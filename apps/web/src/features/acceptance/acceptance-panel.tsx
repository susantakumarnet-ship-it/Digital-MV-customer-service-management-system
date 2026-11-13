import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, Info, Lock, Mail, RefreshCw, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import type { ClosureChecklistDto, ComplaintDetailDto } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FormField, Input, Textarea } from '@/components/ui/form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ErrorState } from '@/components/states';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DecisionForm, ServiceSummary } from './acceptance-components';
import { ACCEPTANCE_STAGE, ACCEPTANCE_STATUS, DECISION_LABEL, METHOD_LABEL, decisionPayload, useAcceptance, useClosureChecklist, type AcceptanceView } from './acceptance-lib';

/** Workflow actions handled by this panel (hidden from the generic action bar when the panel is shown). */
export const PANEL_ACTIONS = ['requestAcceptance', 'waiveAcceptance', 'close'];

export function useAcceptancePanelAccess(c: ComplaintDetailDto) {
  const { hasAny } = useAuth();
  const inStage = ACCEPTANCE_STAGE.has(c.status);
  const canChecklist = hasAny(['complaint.close', 'complaint.resolve', 'complaint.readInternal']);
  const canAcceptance = hasAny(['acceptance.read', 'acceptance.request', 'acceptance.decide']);
  return { show: inStage && (canChecklist || canAcceptance), canChecklist, canAcceptance };
}

/** Closure conditions (BRF §17): what is still blocking the close. */
export function ClosureChecklist({ checklist }: { checklist: ClosureChecklistDto }) {
  return (
    <ul className="space-y-2" aria-label="Closure conditions">
      {checklist.conditions.map((c) => (
        <li key={c.key} className="flex items-start gap-2 text-sm" data-met={c.met}>
          {c.met ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" aria-hidden /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />}
          <span className="min-w-0">
            <span className={cn(c.met ? 'text-slate-800' : 'font-medium text-navy-900')}>
              {c.label}
              <span className="sr-only">{c.met ? ' (met)' : ' (not met)'}</span>
            </span>
            {c.detail && <span className="block text-xs text-slate-600">{c.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ResolutionAcceptancePanel({ complaint: c, onChanged }: { complaint: ComplaintDetailDto; onChanged: (c: ComplaintDetailDto) => void }) {
  const access = useAcceptancePanelAccess(c);
  const qc = useQueryClient();
  const acc = useAcceptance(c.id, access.show && access.canAcceptance);
  const checklist = useClosureChecklist(c.id, access.show && access.canChecklist);
  const [requestOpen, setRequestOpen] = useState<'request' | 'resend' | null>(null);
  const [waiveOpen, setWaiveOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  if (!access.show) return null;

  const closeAction = c.availableActions.find((a) => a.action === 'close');
  const waiveAction = c.availableActions.some((a) => a.action === 'waiveAcceptance');
  const a = acc.data;

  const refresh = async () => {
    const { data } = await api.get<ComplaintDetailDto>(`/complaints/${c.id}`);
    onChanged(data);
    void qc.invalidateQueries({ queryKey: ['complaints', c.id] });
  };
  const transition = async (action: string, reason?: string) => {
    try {
      const { data } = await api.post<ComplaintDetailDto>(`/complaints/${c.id}/transitions`, { action, reason });
      onChanged(data);
      void qc.invalidateQueries({ queryKey: ['complaints', c.id] });
      toast.success(`${data.referenceNo}: ${data.statusLabel}`);
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  };

  // Customer view: accept or request further action.
  if (a?.canDecide) {
    return (
      <Card>
        <CardHeader title="Please confirm the service" description="Review the completed work, then accept it or tell us what still needs doing." />
        <CardBody className="space-y-6">
          <ServiceSummary summary={a.summary} />
          <DecisionForm
            requireName={false}
            onSubmit={async (d) => {
              try {
                await api.post<AcceptanceView>(`/complaints/${c.id}/acceptance`, decisionPayload(d, false));
                toast.success(d.decision === 'ACCEPT' ? 'Thank you — service accepted' : 'Your request for further action has been sent');
                await refresh();
              } catch (err) {
                toast.error(errorMessage(err));
                throw err;
              }
            }}
          />
        </CardBody>
      </Card>
    );
  }

  const status = a?.status ? ACCEPTANCE_STATUS[a.status] : null;
  return (
    <Card>
      <CardHeader
        title="Resolution & acceptance"
        description="Customer acceptance and the conditions for closing this complaint."
        actions={
          <>
            {a?.canRequest && c.availableActions.some((x) => x.action === 'requestAcceptance') && (
              <Button size="sm" variant="secondary" onClick={() => setRequestOpen('request')}>
                <Mail className="h-4 w-4" /> Request acceptance
              </Button>
            )}
            {a?.canResend && (
              <Button size="sm" variant="outline" onClick={() => setRequestOpen('resend')}>
                <RefreshCw className="h-4 w-4" /> Resend link
              </Button>
            )}
            {waiveAction && (a?.canWaive ?? true) && (
              <Button size="sm" variant="outline" onClick={() => setWaiveOpen(true)}>
                <ShieldOff className="h-4 w-4" /> Waive acceptance
              </Button>
            )}
            {closeAction && (
              <Button size="sm" variant="primary" disabled={checklist.data ? !checklist.data.canClose : false} onClick={() => setCloseOpen(true)} aria-describedby={checklist.data && !checklist.data.canClose ? 'close-blocked' : undefined}>
                <Lock className="h-4 w-4" /> Close complaint
              </Button>
            )}
          </>
        }
      />
      <CardBody className="space-y-5">
        {access.canAcceptance && (
          <section aria-labelledby="acc-h" className="space-y-3">
            <h3 id="acc-h" className="text-sm font-semibold text-navy-900">
              Customer acceptance
            </h3>
            {acc.isError ? (
              <ErrorState error={acc.error} onRetry={() => acc.refetch()} />
            ) : acc.isLoading || !a ? (
              <div className="skeleton h-10" />
            ) : (
              <>
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  {status ? <Badge tone={status.tone}>{status.label}</Badge> : <Badge>Not requested</Badge>}
                  {a.requestedAt && <span className="text-slate-600">requested {formatDateTime(a.requestedAt)}</span>}
                  {a.decidedAt && <span className="text-slate-600">· decided {formatDateTime(a.decidedAt)}</span>}
                </p>
                {a.pendingLink && (
                  <div className={cn('rounded-lg border px-3 py-2 text-sm', a.pendingLink.expired ? 'border-red-300 bg-red-50 text-red-800' : 'border-border bg-slate-50 text-slate-700')} data-testid="pending-link">
                    <p>
                      Link sent to <span className="font-medium">{a.pendingLink.recipientEmail}</span> · {a.pendingLink.expired ? 'expired' : 'expires'} {formatDateTime(a.pendingLink.expiresAt)}
                    </p>
                    <p className="text-xs">{a.pendingLink.viewedAt ? `Opened ${formatDateTime(a.pendingLink.viewedAt)}` : 'Not opened yet'}</p>
                    {a.pendingLink.expired && <p className="mt-1 text-xs font-medium">Send a fresh link so the customer can respond.</p>}
                  </div>
                )}
                {a.records.length > 0 && (
                  <ul className="space-y-2" aria-label="Acceptance history">
                    {a.records.map((r) => (
                      <li key={r.id} className="rounded-lg border border-border px-3 py-2 text-sm">
                        <p className="font-medium text-navy-900">
                          {DECISION_LABEL[r.decision]} <span className="font-normal text-slate-600">· {METHOD_LABEL[r.method]}</span>
                        </p>
                        <p className="text-xs text-slate-500">
                          {r.decidedByName} · {formatDateTime(r.decidedAt)}
                          {r.rating ? ` · rating ${r.rating}/5` : ''}
                        </p>
                        {r.comments && <p className="mt-1 whitespace-pre-line text-slate-700">{r.comments}</p>}
                        {r.feedback && <p className="mt-1 whitespace-pre-line text-slate-600">Feedback: {r.feedback}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        )}
        {access.canChecklist && (
          <section aria-labelledby="close-h" className="space-y-3">
            <h3 id="close-h" className="text-sm font-semibold text-navy-900">
              Closure checklist
            </h3>
            {checklist.isError ? (
              <ErrorState error={checklist.error} onRetry={() => checklist.refetch()} />
            ) : checklist.isLoading || !checklist.data ? (
              <div className="skeleton h-24" />
            ) : (
              <>
                <ClosureChecklist checklist={checklist.data} />
                {closeAction && !checklist.data.canClose && (
                  <p id="close-blocked" className="flex items-start gap-2 text-xs text-slate-600">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> The complaint can be closed once every condition above is met.
                  </p>
                )}
              </>
            )}
          </section>
        )}
      </CardBody>

      <RequestAcceptanceDialog
        mode={requestOpen}
        complaint={c}
        onOpenChange={(o) => !o && setRequestOpen(null)}
        onDone={async () => {
          await refresh();
        }}
      />
      <ConfirmDialog
        open={waiveOpen}
        onOpenChange={setWaiveOpen}
        title="Waive customer acceptance?"
        description="Use only when the customer cannot respond. The reason is recorded and shown in the acceptance history."
        confirmLabel="Waive acceptance"
        reason="required"
        onConfirm={(reason) => transition('waiveAcceptance', reason)}
      />
      <ConfirmDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        title={`Close ${c.referenceNo}?`}
        description="Approved work orders close with the complaint and the customer is notified."
        confirmLabel="Close complaint"
        reason={closeAction?.requiresReason ? 'required' : undefined}
        onConfirm={(reason) => transition('close', reason || undefined)}
      />
    </Card>
  );
}

function RequestAcceptanceDialog({ mode, complaint, onOpenChange, onDone }: { mode: 'request' | 'resend' | null; complaint: ComplaintDetailDto; onOpenChange: (o: boolean) => void; onDone: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const emailError = email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? 'Enter a valid email address' : undefined;
  const submit = async () => {
    setTouched(true);
    if (emailError) return;
    setBusy(true);
    try {
      const url = mode === 'resend' ? `/complaints/${complaint.id}/acceptance/resend` : `/complaints/${complaint.id}/request-acceptance`;
      await api.post(url, { recipientEmail: email.trim() || undefined, message: message.trim() || undefined });
      toast.success(mode === 'resend' ? 'A fresh link has been sent' : 'Acceptance requested');
      await onDone();
      setEmail('');
      setMessage('');
      setTouched(false);
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={mode !== null} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        title={mode === 'resend' ? 'Send a fresh acceptance link' : 'Request customer acceptance'}
        description={
          mode === 'resend'
            ? 'Earlier links stop working. The customer gets a new single-use link by email.'
            : 'The customer receives a single-use, expiring link by email. Portal users are also notified.'
        }
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy}>
              {mode === 'resend' ? 'Send new link' : 'Send request'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <FormField label="Recipient email (optional)" help={`Defaults to the complaint contact${complaint.email && !complaint.contactMasked ? ` (${complaint.email})` : ''}.`} error={touched ? emailError : undefined}>
            {(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
          </FormField>
          <FormField label="Message to the customer (optional)">{(p) => <Textarea {...p} rows={3} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} />}</FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}
