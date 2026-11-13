import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, MessageSquare, Paperclip, Pencil, Send, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { MaterialLineDto, MaterialRequestDetailDto } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge, StatusBadge, toneOf } from '@/components/ui/badge';
import { FormField, Input, Textarea } from '@/components/ui/form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState, ErrorState } from '@/components/states';
import { useBreadcrumb } from '@/app/breadcrumbs';
import { openAttachment } from '@/features/complaints/complaint-lib';
import { api, errorMessage, parseApiError } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { clampApproved, formatQty, TRANSACTION_LABELS, transactionTone, urgencyLabel, urgencyTone, useMaterialRequest, validateDecision } from './material-lib';
import { EditRequestDialog } from './request-form';
import { BackorderDialog, IssueDialog, ReleaseDialog, ReserveDialog, ReturnDialog, ReviseApprovalDialog } from './store-dialogs';


export function MaterialRequestPage() {
  const { id = '' } = useParams();
  const q = useMaterialRequest(id);
  useBreadcrumb(q.data?.requestNo);

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
            title="Material request not found"
            description="It may not exist, or it is outside your data access."
            action={
              <Link to="/materials" className="text-sm font-medium text-royal-700 hover:underline">
                Back to material requests
              </Link>
            }
          />
        ) : (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        )}
      </Card>
    );
  }
  return q.data ? <RequestView r={q.data} /> : null;
}

function useApplyDetail() {
  const qc = useQueryClient();
  return (r: MaterialRequestDetailDto) => {
    qc.setQueryData(['material-requests', 'detail', r.id], r);
    void qc.invalidateQueries({ queryKey: ['material-requests', 'list'] });
    void qc.invalidateQueries({ queryKey: ['material-requests', 'summary'] });
  };
}

type StoreAction = 'reserve' | 'release' | 'issue' | 'backorder' | 'return' | 'revise';

function RequestView({ r }: { r: MaterialRequestDetailDto }) {

  const apply = useApplyDetail();
  const [editOpen, setEditOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [action, setAction] = useState<{ kind: StoreAction; lineId: string; qty?: number } | null>(null);
  const p = r.permissions;
  const canReturn = p.canReturn;
  const showStore = p.canIssue || canReturn || p.canReviseApproval;
  const activeLine = action ? r.lines.find((l) => l.lineId === action.lineId) : undefined;
  const lastClarify = [...r.messages].reverse().find((m) => m.direction === 'TO_REQUESTER');

  const submit = async () => {
    setSubmitting(true);
    try {
      const { data } = await api.post<MaterialRequestDetailDto>(`/material-requests/${r.id}/submit`);
      apply(data);
      toast.success('Request submitted for approval');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };
  const close = async (reason: string) => {
    try {
      const { data } = await api.post<MaterialRequestDetailDto>(`/material-requests/${r.id}/close`, { reason: reason.trim() || undefined });
      apply(data);
      toast.success('Request closed');
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  };

  const dialogProps = (kind: StoreAction) => ({
    request: r,
    line: activeLine!,
    open: action?.kind === kind && Boolean(activeLine),
    onOpenChange: (o: boolean) => !o && setAction(null),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/materials" className="mb-1 inline-flex items-center gap-1 text-sm text-slate-600 hover:text-navy-900">
            <ArrowLeft className="h-4 w-4" /> Material requests
          </Link>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-navy-900">
            <span className="font-mono">{r.requestNo}</span>
            <StatusBadge status={r.status} label={r.statusLabel} tone={toneOf(r.statusTone)} />
            <Badge tone={urgencyTone(r.urgency)}>{urgencyLabel(r.urgency)}</Badge>
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Work order{' '}
            <Link to={`/work-orders/${r.workOrder.id}`} className="font-mono text-royal-700 hover:underline">
              {r.workOrder.workOrderNo}
            </Link>
            {r.visit && (
              <>
                {' '}
                · visit{' '}
                <Link to={`/visits/${r.visit.id}`} className="font-mono text-royal-700 hover:underline">
                  {r.visit.visitNo}
                </Link>
              </>
            )}
            {r.site && <> · {r.site.name}</>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {p.canEdit && (
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil className="h-4 w-4" /> {r.status === 'CLARIFICATION_REQUIRED' ? 'Reply & resubmit' : 'Edit'}
            </Button>
          )}
          {p.canSubmit && r.status === 'DRAFT' && (
            <Button onClick={submit} loading={submitting}>
              <Send className="h-4 w-4" /> Submit for approval
            </Button>
          )}
          {p.canClose && (
            <Button variant="secondary" onClick={() => setCloseOpen(true)}>
              <CheckCircle2 className="h-4 w-4" /> Close request
            </Button>
          )}
        </div>
      </div>

      {r.status === 'CLARIFICATION_REQUIRED' && lastClarify && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="status">
          <p className="font-medium">Clarification requested by {lastClarify.byName}</p>
          <p className="mt-1 whitespace-pre-wrap">{lastClarify.text}</p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Requested material" description="Approved quantity caps what can be issued (BR-013)." />
          <LinesTable r={r} showStore={showStore} canReturn={canReturn} onAction={(kind, lineId) => setAction({ kind, lineId })} />
        </Card>
        <Card>
          <CardHeader title="Details" />
          <CardBody>
            <dl className="space-y-2 text-sm">
              <Row label="Requested by">{r.requester.name}</Row>
              <Row label="Complaint">
                <Link to={`/complaints/${r.complaint.id}`} className="font-mono text-royal-700 hover:underline">
                  {r.complaint.referenceNo}
                </Link>
              </Row>
              <Row label="Needed by">{r.neededBy ? formatDate(r.neededBy) : '—'}</Row>
              <Row label="Submitted">{r.submittedAt ? formatDateTime(r.submittedAt) : 'Not yet'}</Row>
              <Row label="Reason">
                <span className="whitespace-pre-wrap">{r.reason}</span>
              </Row>
            </dl>
          </CardBody>
        </Card>
      </div>

      {p.canDecide ? (
        <DecisionPanel request={r} onDone={apply} />
      ) : (
        p.reasonIfNotDecide && (
          <p className="rounded-lg border border-border bg-slate-50 p-3 text-sm text-slate-600" role="note">
            {p.reasonIfNotDecide}
          </p>
        )
      )}

      <TransactionsCard r={r} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Decisions & messages" />
          <CardBody>
            <Timeline r={r} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Status history" />
          <CardBody>
            {r.statusHistory.length === 0 ? (
              <p className="text-sm text-slate-500">No status changes yet.</p>
            ) : (
              <ol className="space-y-2 text-sm">
                {r.statusHistory.map((h, i) => (
                  <li key={i} className="border-l-2 border-royal-200 pl-3">
                    <p className="font-medium text-navy-900">{h.toLabel}</p>
                    <p className="text-xs text-slate-500">
                      {formatDateTime(h.at)}
                      {h.byName ? ` · ${h.byName}` : ''}
                    </p>
                    {h.reason && <p className="mt-0.5 text-slate-700">{h.reason}</p>}
                  </li>
                ))}
              </ol>
            )}
          </CardBody>
        </Card>
      </div>

      {p.canEdit && <EditRequestDialog request={r} open={editOpen} onOpenChange={setEditOpen} />}
      <ConfirmDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        title={`Close ${r.requestNo}?`}
        description="Closing ends the request. Outstanding approved quantities will no longer be issued."
        confirmLabel="Close request"
        reason="optional"
        onConfirm={close}
      />
      {activeLine && (
        <>
          <ReserveDialog {...dialogProps('reserve')} />
          <ReleaseDialog {...dialogProps('release')} />
          <IssueDialog {...dialogProps('issue')} onBackorder={(qty) => setAction({ kind: 'backorder', lineId: activeLine.lineId, qty })} />
          <BackorderDialog {...dialogProps('backorder')} initialQty={action?.qty} />
          <ReturnDialog {...dialogProps('return')} />
          <ReviseApprovalDialog {...dialogProps('revise')} />
        </>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-slate-800">{children}</dd>
    </div>
  );
}

function LinesTable({
  r,
  showStore,
  canReturn,
  onAction,
}: {
  r: MaterialRequestDetailDto;
  showStore: boolean;
  canReturn: boolean;
  onAction: (k: StoreAction, lineId: string) => void;
}) {
  const p = r.permissions;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Request lines</caption>
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th scope="col" className="px-4 py-2">Item</th>
            <th scope="col" className="px-3 py-2 text-right">Requested</th>
            <th scope="col" className="px-3 py-2 text-right">Approved</th>
            <th scope="col" className="px-3 py-2 text-right">Reserved</th>
            <th scope="col" className="px-3 py-2 text-right">Issued</th>
            <th scope="col" className="px-3 py-2 text-right">Outstanding</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {r.lines.map((l) => {
            const returnable = l.issuedQty - l.returnedQty - l.damagedQty;
            return (
              <tr key={l.lineId} className="align-top">
                <td className="px-4 py-3">
                  <p className="font-medium text-navy-900">{l.item.name}</p>
                  <p className="font-mono text-xs text-slate-500">{l.item.code}</p>
                  {l.specification && <p className="mt-1 text-xs text-slate-600">Spec: {l.specification}</p>}
                  {l.reason && <p className="text-xs text-slate-600">Reason: {l.reason}</p>}
                  <LineNotes l={l} />
                  {showStore && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {p.canIssue && l.outstandingQty > 0 && (
                        <>
                          <Button size="sm" onClick={() => onAction('issue', l.lineId)}>
                            Issue
                          </Button>
                          {l.approvedQty !== null && l.approvedQty - l.issuedQty - l.reservedQty > 0 && (
                            <Button size="sm" variant="outline" onClick={() => onAction('reserve', l.lineId)}>
                              Reserve
                            </Button>
                          )}
                          <Button size="sm" variant="outline" onClick={() => onAction('backorder', l.lineId)}>
                            Backorder
                          </Button>
                        </>
                      )}
                      {p.canIssue && l.reservedQty > 0 && (
                        <Button size="sm" variant="ghost" onClick={() => onAction('release', l.lineId)}>
                          Release reservation
                        </Button>
                      )}
                      {canReturn && returnable > 0 && (
                        <Button size="sm" variant="outline" onClick={() => onAction('return', l.lineId)}>
                          Return
                        </Button>
                      )}
                      {p.canReviseApproval && (
                        <Button size="sm" variant="ghost" onClick={() => onAction('revise', l.lineId)}>
                          Revise approval
                        </Button>
                      )}
                    </div>
                  )}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{formatQty(l.quantity, l.item.unit)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{l.approvedQty === null ? <span className="text-slate-400">—</span> : formatQty(l.approvedQty, l.item.unit)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{formatQty(l.reservedQty)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{formatQty(l.issuedQty)}</td>
                <td className={cn('px-3 py-3 text-right font-medium tabular-nums', l.outstandingQty > 0 ? 'text-amber-700' : 'text-slate-500')}>{formatQty(l.outstandingQty)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LineNotes({ l }: { l: MaterialLineDto }) {
  const notes: string[] = [];
  if (l.reservations.length) notes.push(`Reserved: ${l.reservations.map((x) => `${formatQty(x.quantity)} at ${x.warehouse.name}`).join(', ')}`);
  if (l.backorderQty > 0) notes.push(`Backorder ${formatQty(l.backorderQty, l.item.unit)}${l.backorderExpectedAt ? `, expected ${formatDate(l.backorderExpectedAt)}` : ''}`);
  if (l.returnedQty > 0) notes.push(`Returned ${formatQty(l.returnedQty)}`);
  if (l.damagedQty > 0) notes.push(`Damaged ${formatQty(l.damagedQty)}`);
  if (!notes.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

// ---- Decision (MAT-02) -------------------------------------------------------------------------------

/** Supervisor decision: approve (with per-line quantities ≤ requested), reject or ask for clarification. */
export function DecisionPanel({ request, onDone }: { request: MaterialRequestDetailDto; onDone: (r: MaterialRequestDetailDto) => void }) {
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT' | 'CLARIFY'>('APPROVE');
  const [comment, setComment] = useState('');
  const [approved, setApproved] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setApproved(Object.fromEntries(request.lines.map((l) => [l.lineId, String(l.quantity)])));
  }, [request.lines]);

  const submit = async () => {
    const lines = request.lines.map((l) => ({ lineId: l.lineId, requested: l.quantity, approved: approved[l.lineId] ?? '' }));
    const e = validateDecision(decision, comment, lines);
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const { data } = await api.post<MaterialRequestDetailDto>(`/material-requests/${request.id}/decision`, {
        decision,
        comment: comment.trim() || undefined,
        lines: decision === 'APPROVE' ? lines.map((l) => ({ lineId: l.lineId, approvedQty: Number(l.approved) })) : undefined,
      });
      onDone(data);
      toast.success(decision === 'APPROVE' ? 'Request approved' : decision === 'REJECT' ? 'Request rejected' : 'Clarification requested');
    } catch (err) {
      const pe = parseApiError(err);
      if (pe.fields) setErrors(pe.fields);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const options = [
    { value: 'APPROVE', label: 'Approve' },
    { value: 'CLARIFY', label: 'Ask for clarification' },
    { value: 'REJECT', label: 'Reject' },
  ] as const;

  return (
    <Card>
      <CardHeader title="Your decision" description="Approval authorises the quantities; it does not reserve stock." />
      <CardBody className="space-y-4">
        <div role="radiogroup" aria-label="Decision" className="flex flex-wrap gap-2">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={decision === o.value}
              onClick={() => {
                setDecision(o.value);
                setErrors({});
              }}
              className={cn(
                'rounded-lg border px-3 py-2 text-sm font-medium',
                decision === o.value ? (o.value === 'REJECT' ? 'border-red-600 bg-red-50 text-red-800' : 'border-royal-700 bg-royal-50 text-royal-800') : 'border-border text-slate-700 hover:bg-slate-50',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        {decision === 'APPROVE' && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-navy-900">Approved quantities</legend>
            {request.lines.map((l) => (
              <FormField key={l.lineId} label={`${l.item.name} — requested ${formatQty(l.quantity, l.item.unit)}`} error={errors[`line.${l.lineId}`]}>
                {(fp) => (
                  <Input
                    {...fp}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={l.quantity}
                    step="any"
                    className="max-w-40"
                    value={approved[l.lineId] ?? ''}
                    onChange={(e) => setApproved((cur) => ({ ...cur, [l.lineId]: clampApproved(e.target.value, l.quantity) }))}
                  />
                )}
              </FormField>
            ))}
            {errors.lines && (
              <p className="text-xs text-red-600" role="alert">
                {errors.lines}
              </p>
            )}
          </fieldset>
        )}
        <FormField label={decision === 'APPROVE' ? 'Comment' : decision === 'REJECT' ? 'Reason for rejection' : 'What needs clarifying?'} required={decision !== 'APPROVE'} error={errors.comment}>
          {(fp) => <Textarea {...fp} rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />}
        </FormField>
        <div className="flex justify-end">
          <Button variant={decision === 'REJECT' ? 'danger' : 'primary'} onClick={submit} loading={busy}>
            {decision === 'APPROVE' ? 'Approve request' : decision === 'REJECT' ? 'Reject request' : 'Send clarification request'}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

// ---- Transactions -----------------------------------------------------------------------------------

function TransactionsCard({ r }: { r: MaterialRequestDetailDto }) {
  return (
    <Card>
      <CardHeader title="Stock movements" description="Reservations, issues and returns recorded against this request." />
      {r.transactions.length === 0 ? (
        <EmptyState title="No stock movements yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Stock movements</caption>
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2">When</th>
                <th scope="col" className="px-3 py-2">Type</th>
                <th scope="col" className="px-3 py-2">Item</th>
                <th scope="col" className="px-3 py-2 text-right">Qty</th>
                <th scope="col" className="px-3 py-2">Warehouse</th>
                <th scope="col" className="px-3 py-2">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {r.transactions.map((t) => (
                <tr key={t.id} className="align-top">
                  <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                    {formatDateTime(t.transactionAt)}
                    <span className="block text-xs">{t.actorName}</span>
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={transactionTone(t.type)}>{TRANSACTION_LABELS[t.type]}</Badge>
                  </td>
                  <td className="px-3 py-2">{t.item.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatQty(t.quantity, t.item.unit)}</td>
                  <td className="px-3 py-2">{t.warehouse.name}</td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {t.recipientName && <p>Received by {t.recipientName}</p>}
                    {t.batchNo && <p>Batch {t.batchNo}</p>}
                    {t.serialNumbers.length > 0 && <p>Serials: {t.serialNumbers.join(', ')}</p>}
                    {t.reason && <p>{t.reason}</p>}
                    {t.evidence.map((a) => (
                      <button key={a.id} type="button" onClick={() => void openAttachment(a.id, true)} className="mt-0.5 inline-flex items-center gap-1 text-royal-700 hover:underline">
                        <Paperclip className="h-3 w-3" aria-hidden /> {a.originalName}
                      </button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Timeline({ r }: { r: MaterialRequestDetailDto }) {
  const items = [
    ...r.decisions.map((d) => ({ at: d.at, kind: 'decision' as const, d })),
    ...r.messages.map((m) => ({ at: m.at, kind: 'message' as const, m })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  if (!items.length) return <p className="text-sm text-slate-500">No decisions yet.</p>;
  const decisionTone = (d: string) => (d === 'APPROVE' || d === 'REVISE' ? 'success' : d === 'REJECT' ? 'danger' : 'warning');
  return (
    <ol className="space-y-3 text-sm">
      {items.map((it, i) =>
        it.kind === 'decision' ? (
          <li key={i} className="flex gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            <div>
              <p>
                <Badge tone={decisionTone(it.d.decision)}>{it.d.decision.charAt(0) + it.d.decision.slice(1).toLowerCase()}</Badge>{' '}
                <span className="text-slate-700">by {it.d.byName}</span>
              </p>
              <p className="text-xs text-slate-500">{formatDateTime(it.d.at)}</p>
              {it.d.comment && <p className="mt-0.5 whitespace-pre-wrap text-slate-700">{it.d.comment}</p>}
            </div>
          </li>
        ) : (
          <li key={i} className="flex gap-2">
            {it.m.direction === 'TO_REQUESTER' ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden /> : <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-royal-500" aria-hidden />}
            <div>
              <p className="text-slate-700">
                {it.m.byName} {it.m.direction === 'TO_REQUESTER' ? 'asked' : 'replied'}
              </p>
              <p className="text-xs text-slate-500">{formatDateTime(it.m.at)}</p>
              <p className="mt-0.5 whitespace-pre-wrap text-slate-700">{it.m.text}</p>
            </div>
          </li>
        ),
      )}
    </ol>
  );
}
