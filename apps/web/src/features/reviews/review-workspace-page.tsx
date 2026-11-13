import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, ArrowLeft, CheckCircle2, GitCompare, Info, MessageSquarePlus, PlayCircle, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  INSPECTION_RESULT_LABELS,
  TIME_EVENT_LABELS,
  type ReportItemDto,
  type ReviewActionDto,
  type ReviewActionInput,
  type ReviewContextDto,
  type TimeLogFlag,
} from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge, StatusBadge, toneOf } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/form';
import { EmptyState, ErrorState } from '@/components/states';
import { useBreadcrumb } from '@/app/breadcrumbs';
import { Thumb } from '@/features/inspections/checklist-item';
import { groupBySection } from '@/features/inspections/report-lib';
import { formatDuration } from '@/features/visits/visit-lib';
import { api, errorMessage, parseApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ApproveDialog, ReturnDialog } from './review-dialogs';
import { OUTCOME_MESSAGE, feedbackPayload, filterItems, useReviewContext, type ItemFilter, type ReviewActionResult } from './review-lib';

const RESULT_TONE = { PASS: 'success', FAIL: 'danger', NOT_CHECKED: 'warning', NOT_APPLICABLE: 'neutral' } as const;

export function ReviewWorkspacePage() {
  const { id = '' } = useParams();
  const q = useReviewContext(id);
  useBreadcrumb(q.data ? `${q.data.workOrder.workOrderNo} · rev ${q.data.report.revisionNo}` : undefined);
  if (q.isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-8 w-72" />
        <div className="skeleton h-72" />
      </div>
    );
  }
  if (q.isError) {
    const status = parseApiError(q.error).status;
    return (
      <Card>
        {status === 404 || status === 400 ? (
          <EmptyState title="Report not found" description="It may not exist, or it is outside your data access." />
        ) : (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        )}
      </Card>
    );
  }
  return q.data ? <Workspace key={q.data.report.id} ctx={q.data} /> : null;
}

function Workspace({ ctx }: { ctx: ReviewContextDto }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { report, permissions: perm } = ctx;
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<ItemFilter>('all');
  const [approveOpen, setApproveOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const setItemFeedback = (key: string, comment: string) => setFeedback((f) => ({ ...f, [key]: comment }));
  const visible = useMemo(() => filterItems(report.items, filter, feedback), [report.items, filter, feedback]);
  const groups = useMemo(() => groupBySection(visible), [visible]);
  const feedbackCount = feedbackPayload(feedback).length;

  const act = async (body: ReviewActionInput) => {
    try {
      const res = await api.post<ReviewActionResult>(`/inspection-reports/${report.id}/review-actions`, body);
      toast.success(OUTCOME_MESSAGE[res.data.outcome]);
      void qc.invalidateQueries({ queryKey: ['reviews'] });
      void qc.invalidateQueries({ queryKey: ['inspection-reports'] });
      void qc.invalidateQueries({ queryKey: ['work-orders'] });
      void qc.invalidateQueries({ queryKey: ['complaints'] });
      if (res.data.outcome === 'returned') navigate('/reviews');
      else if (res.data.context) qc.setQueryData(['reviews', 'context', report.id], res.data.context);
      return res.data;
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  };

  const startReview = async () => {
    setBusy('start');
    try {
      await act({ action: 'startReview', itemFeedback: [] });
    } catch {
      // toasted
    } finally {
      setBusy(null);
    }
  };

  const counts = {
    fail: report.items.filter((i) => i.result === 'FAIL').length,
    notChecked: report.items.filter((i) => i.result === 'NOT_CHECKED').length,
  };

  return (
    <div className="space-y-4 pb-28 lg:pb-0">
      <div>
        <Link to="/reviews" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-navy-900">
          <ArrowLeft className="h-4 w-4" /> Review queue
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-navy-900 sm:text-2xl">Review: {ctx.workOrder.workOrderNo}</h1>
            <p className="mt-0.5 text-sm text-slate-600">
              {report.template.name} · v{report.template.version} · revision {report.revisionNo}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
              <StatusBadge status={report.status} label={report.statusLabel} tone={toneOf(report.statusTone)} />
              <span>
                WO{' '}
                <Link to={`/work-orders/${ctx.workOrder.id}`} className="font-mono text-royal-700 hover:underline">
                  {ctx.workOrder.workOrderNo}
                </Link>{' '}
                ({ctx.workOrder.statusLabel})
              </span>
              <span>
                Complaint{' '}
                <Link to={`/complaints/${ctx.complaint.id}`} className="font-mono text-royal-700 hover:underline">
                  {ctx.complaint.referenceNo}
                </Link>{' '}
                ({ctx.complaint.statusLabel})
              </span>
              <span>
                Visit{' '}
                <Link to={`/visits/${ctx.visit.id}`} className="font-mono text-royal-700 hover:underline">
                  {ctx.visit.visitNo}
                </Link>
              </span>
              {ctx.complaint.priority && <Badge tone="warning">{ctx.complaint.priority}</Badge>}
            </div>
            <p className="mt-1 text-sm text-slate-600" data-testid="approval-progress">
              {ctx.approval.levels > 1
                ? `Approved ${ctx.approval.approvalsSoFar} of ${ctx.approval.levels}${ctx.approval.approvedBy.length ? ` by ${ctx.approval.approvedBy.join(', ')}` : ''}`
                : ctx.approval.approvalsSoFar
                  ? `Approved by ${ctx.approval.approvedBy.join(', ')}`
                  : 'Single-level approval'}
            </p>
          </div>
        </div>
      </div>

      {ctx.feedbackFromPreviousReview && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-medium">
            Resubmitted after correction — returned by {ctx.feedbackFromPreviousReview.reviewerName} on {formatDateTime(ctx.feedbackFromPreviousReview.actionAt)}
          </p>
          {ctx.feedbackFromPreviousReview.comments && <p className="mt-1 whitespace-pre-line">{ctx.feedbackFromPreviousReview.comments}</p>}
          {report.previousRevisionId && (
            <Link to={`/inspection-reports/${report.id}/compare?with=${report.previousRevisionId}`} className="mt-2 inline-flex items-center gap-1 font-medium underline">
              <GitCompare className="h-4 w-4" /> Compare with previous revision
            </Link>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter checklist items">
            {(
              [
                ['all', `All (${report.items.length})`],
                ['fail', `Fail (${counts.fail})`],
                ['notChecked', `Not checked (${counts.notChecked})`],
                ['feedback', `With feedback (${feedbackCount})`],
              ] as [ItemFilter, string][]
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={filter === k}
                onClick={() => setFilter(k)}
                className={cn('rounded-full border px-3 py-1 text-sm font-medium', filter === k ? 'border-navy-900 bg-navy-900 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50')}
              >
                {label}
              </button>
            ))}
          </div>
          {groups.length === 0 && (
            <Card>
              <EmptyState title="No items match this filter" />
            </Card>
          )}
          {groups.map((g) => (
            <section key={g.section} className="space-y-3" aria-labelledby={`rs-${g.section}`}>
              <h2 id={`rs-${g.section}`} className="text-base font-semibold text-navy-900">
                {g.section}
              </h2>
              {g.items.map((item) => (
                <ReviewItem key={item.key} item={item} canFeedback={perm.canReturn} feedback={feedback[item.key] ?? ''} onFeedback={(c) => setItemFeedback(item.key, c)} />
              ))}
            </section>
          ))}
          <Card>
            <CardHeader title="Findings and recommendations" />
            <CardBody className="space-y-3 text-sm">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Findings</p>
                <p className="whitespace-pre-line text-slate-800">{report.findings || '—'}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Recommendations</p>
                <p className="whitespace-pre-line text-slate-800">{report.recommendations || '—'}</p>
              </div>
            </CardBody>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <TimeLogCard ctx={ctx} />
          <FlagsCard flags={ctx.timeFlags} />
          <CorrectionsCard ctx={ctx} />
          <ContextCard ctx={ctx} />
          <RevisionsCard ctx={ctx} />
          <HistoryCard history={ctx.reviewHistory} />
          <Card>
            <CardHeader title="Non-conformance reports" />
            <CardBody className="text-sm text-slate-600">
              {ctx.ncrs.length ? (
                <ul className="space-y-1">
                  {ctx.ncrs.map((n) => (
                    <li key={n.id}>
                      {n.ncrNo} · {n.status}
                    </li>
                  ))}
                </ul>
              ) : (
                'NCRs arrive in Phase 8.'
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      <ActionBar
        ctx={ctx}
        busy={busy}
        feedbackCount={feedbackCount}
        onStart={startReview}
        onApprove={() => setApproveOpen(true)}
        onReturn={() => setReturnOpen(true)}
      />

      <ApproveDialog
        open={approveOpen}
        onOpenChange={setApproveOpen}
        levels={ctx.approval.levels}
        approvalsSoFar={ctx.approval.approvalsSoFar}
        onConfirm={(comments) => act({ action: 'approve', comments: comments || undefined, itemFeedback: [] })}
      />
      <ReturnDialog
        open={returnOpen}
        onOpenChange={setReturnOpen}
        items={report.items}
        feedback={feedback}
        onFeedbackChange={setItemFeedback}
        onConfirm={(comments) => act({ action: 'return', comments, itemFeedback: feedbackPayload(feedback) })}
      />
    </div>
  );
}

/** Sticky (mobile) action bar; shows why no action is possible when nothing is permitted. */
export function ActionBar({
  ctx,
  busy,
  feedbackCount,
  onStart,
  onApprove,
  onReturn,
}: {
  ctx: Pick<ReviewContextDto, 'permissions'>;
  busy: string | null;
  feedbackCount: number;
  onStart: () => void;
  onApprove: () => void;
  onReturn: () => void;
}) {
  const p = ctx.permissions;
  const none = !p.canStartReview && !p.canApprove && !p.canReturn;
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-white/95 px-4 py-3 shadow-lg backdrop-blur lg:static lg:rounded-xl lg:border lg:shadow-none">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
        {none ? (
          <p className="flex items-start gap-2 text-sm text-slate-600" role="status">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {p.reasonIfNot ?? 'No review actions are available for you on this report.'}
          </p>
        ) : (
          <p className="text-sm text-slate-600">{feedbackCount ? `${feedbackCount} item comment(s) ready` : 'Add item feedback to point engineers at specific lines.'}</p>
        )}
        <div className="flex flex-wrap gap-2">
          {p.canStartReview && (
            <Button variant="outline" onClick={onStart} loading={busy === 'start'}>
              <PlayCircle className="h-4 w-4" /> Start review
            </Button>
          )}
          {p.canReturn && (
            <Button variant="outline" className="text-red-700" onClick={onReturn}>
              <Undo2 className="h-4 w-4" /> Return for correction
            </Button>
          )}
          {p.canApprove && (
            <Button variant="accent" onClick={onApprove}>
              <CheckCircle2 className="h-4 w-4" /> Approve
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewItem({ item, canFeedback, feedback, onFeedback }: { item: ReportItemDto; canFeedback: boolean; feedback: string; onFeedback: (c: string) => void }) {
  const [open, setOpen] = useState(Boolean(feedback));
  const emphasis = item.result === 'FAIL' ? 'border-red-300 bg-red-50/30' : item.result === 'NOT_CHECKED' ? 'border-amber-300 bg-amber-50/30' : 'border-border bg-white';
  return (
    <div id={`ritem-${item.key}`} className={cn('rounded-xl border p-4', emphasis)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-navy-900">{item.description}</p>
          <p className="font-mono text-xs text-slate-400">{item.key}</p>
        </div>
        {item.result ? <Badge tone={RESULT_TONE[item.result]}>{INSPECTION_RESULT_LABELS[item.result]}</Badge> : <Badge>Not answered</Badge>}
      </div>
      {item.reason && (
        <p className="mt-2 text-sm text-slate-700">
          <span className="font-medium">Reason:</span> {item.reason}
        </p>
      )}
      {item.remarks && (
        <p className="mt-1 whitespace-pre-line text-sm text-slate-700">
          <span className="font-medium">Remarks:</span> {item.remarks}
        </p>
      )}
      {item.attachments.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2" aria-label={`Evidence for ${item.key}`}>
          {item.attachments.map((a) => (
            <Thumb key={a.id} a={a} />
          ))}
        </div>
      )}
      {item.feedback && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="font-medium">Earlier reviewer feedback:</span> {item.feedback}
        </p>
      )}
      {canFeedback && (
        <div className="mt-3">
          {open ? (
            <div>
              <label htmlFor={`fb-${item.key}`} className="field-label">
                Feedback for the engineer
              </label>
              <Textarea id={`fb-${item.key}`} rows={2} maxLength={2000} value={feedback} onChange={(e) => onFeedback(e.target.value)} />
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
              <MessageSquarePlus className="h-4 w-4" /> Add feedback
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function TimeLogCard({ ctx }: { ctx: ReviewContextDto }) {
  return (
    <Card>
      <CardHeader title="Time log" description={`Server times · ${ctx.visit.timezone}. Corrected times show the original struck through.`} />
      <CardBody className="space-y-5">
        {ctx.sequences.length === 0 && <p className="text-sm text-slate-500">No engineers on this visit.</p>}
        {ctx.sequences.map((s) => (
          <div key={s.engineer.id}>
            <p className="mb-2 flex items-center justify-between text-sm font-medium text-navy-900">
              {s.engineer.name}
              {s.complete ? <Badge tone="success">Complete</Badge> : <Badge tone="warning">Incomplete</Badge>}
            </p>
            <ol className="space-y-1 text-sm" aria-label={`Time events for ${s.engineer.name}`}>
              {s.events.map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <span className="text-slate-700">
                    {e.sequence}. {TIME_EVENT_LABELS[e.eventType]}
                  </span>
                  <span className="text-xs text-slate-600">
                    {formatDateTime(e.effectiveTimestamp)}
                    {e.corrected && (
                      <>
                        <Badge tone="warning" className="ml-1">
                          corrected
                        </Badge>
                        <span className="ml-1 text-slate-400 line-through" aria-label="Original server time">
                          {formatDateTime(e.serverTimestamp)}
                        </span>
                      </>
                    )}
                    {e.pendingCorrection && (
                      <Badge tone="danger" className="ml-1">
                        correction pending
                      </Badge>
                    )}
                  </span>
                </li>
              ))}
              {s.events.length === 0 && <li className="text-slate-500">No events recorded.</li>}
            </ol>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-slate-600" aria-label={`Durations for ${s.engineer.name}`}>
              <dt className="text-slate-500">Travel to site</dt>
              <dd className="text-right font-medium">{formatDuration(s.durations.travelToSite)}</dd>
              <dt className="text-slate-500">On-site work</dt>
              <dd className="text-right font-medium">{formatDuration(s.durations.onSiteWork)}</dd>
              <dt className="text-slate-500">Return travel</dt>
              <dd className="text-right font-medium">{formatDuration(s.durations.returnTravel)}</dd>
              <dt className="text-slate-500">Total elapsed</dt>
              <dd className="text-right font-semibold text-navy-900">{formatDuration(s.durations.totalElapsed)}</dd>
            </dl>
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

export function FlagsCard({ flags }: { flags: TimeLogFlag[] }) {
  return (
    <Card>
      <CardHeader title="Time-log checks" description="Warnings for the reviewer; they do not block approval on their own." />
      <CardBody>
        {flags.length === 0 ? (
          <p className="flex items-center gap-1.5 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4" aria-hidden /> No issues found in the time log.
          </p>
        ) : (
          <ul className="space-y-2" aria-label="Time-log flags">
            {flags.map((f, i) => (
              <li
                key={`${f.code}-${i}`}
                className={cn('flex items-start gap-2 rounded-lg px-3 py-2 text-sm', f.severity === 'danger' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-900')}
              >
                {f.severity === 'danger' ? <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
                {f.message}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function CorrectionsCard({ ctx }: { ctx: ReviewContextDto }) {
  if (!ctx.corrections.length) return null;
  return (
    <Card>
      <CardHeader
        title="Time corrections"
        actions={
          <Link to={`/visits/${ctx.visit.id}`} className="text-sm font-medium text-royal-700 hover:underline">
            Decide on the visit
          </Link>
        }
      />
      <ul className="divide-y divide-border">
        {ctx.corrections.map((c) => (
          <li key={c.id} className={cn('px-5 py-3 text-sm', c.status === 'PENDING' && 'bg-amber-50/60')}>
            <p className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-navy-900">
                {c.engineer.name} · {TIME_EVENT_LABELS[c.eventType]}
              </span>
              <StatusBadge status={c.status} label={c.status.charAt(0) + c.status.slice(1).toLowerCase()} tone={c.status === 'APPROVED' ? 'success' : c.status === 'REJECTED' ? 'neutral' : 'warning'} />
            </p>
            <p className="text-xs text-slate-600">
              {formatDateTime(c.originalTimestamp)} → {formatDateTime(c.proposedTimestamp)}
            </p>
            <p className="text-xs text-slate-500">{c.reason}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ContextCard({ ctx }: { ctx: ReviewContextDto }) {
  return (
    <Card>
      <CardHeader title="Work context" />
      <CardBody className="space-y-3 text-sm">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Work order</p>
          <p className="font-medium text-navy-900">{ctx.workOrder.title}</p>
          <p className="whitespace-pre-line text-slate-700">{ctx.workOrder.description}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {ctx.workOrder.shutdownRequired && <Badge tone="danger">Shutdown required</Badge>}
            {ctx.workOrder.materialRequired && <Badge tone="info">Materials required</Badge>}
          </div>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Complaint</p>
          <p className="text-slate-700">
            {ctx.complaint.customerName} — {ctx.complaint.description}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Visit</p>
          <p className="text-slate-700">
            {ctx.visit.visitNo} · {ctx.visit.statusLabel} — {ctx.visit.purpose}
          </p>
        </div>
      </CardBody>
    </Card>
  );
}

function RevisionsCard({ ctx }: { ctx: ReviewContextDto }) {
  const current = ctx.report;
  return (
    <Card>
      <CardHeader title="Revisions" />
      <ul className="divide-y divide-border">
        {ctx.revisions.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
            <span>
              <Link to={`/inspection-reports/${r.id}`} className={cn('font-medium hover:underline', r.id === current.id ? 'text-navy-900' : 'text-royal-700')}>
                Revision {r.revisionNo}
              </Link>
              {r.id === current.id && <span className="ml-1 text-xs text-slate-500">(this)</span>}
              <span className="block text-xs text-slate-500">{r.submittedAt ? `Submitted ${formatDateTime(r.submittedAt)}` : 'Not submitted'}</span>
            </span>
            <span className="flex items-center gap-2">
              <Badge>{r.statusLabel}</Badge>
              {r.id !== current.id && (
                <Link to={`/inspection-reports/${current.id}/compare?with=${r.id}`} className="inline-flex items-center gap-1 text-xs font-medium text-royal-700 hover:underline">
                  <GitCompare className="h-3.5 w-3.5" /> Compare
                </Link>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const ACTION_LABEL: Record<ReviewActionDto['action'], string> = { startReview: 'Started review', approve: 'Approved', return: 'Returned for correction' };

function HistoryCard({ history }: { history: ReviewActionDto[] }) {
  return (
    <Card>
      <CardHeader title="Review history" />
      {history.length === 0 ? (
        <CardBody className="text-sm text-slate-500">No review actions yet.</CardBody>
      ) : (
        <ol className="divide-y divide-border">
          {history.map((h) => (
            <li key={h.id} className="px-5 py-3 text-sm">
              <p className="font-medium text-navy-900">
                {ACTION_LABEL[h.action]}
                {h.action === 'approve' && h.level ? ` (level ${h.level})` : ''} · rev {h.revisionNo}
              </p>
              <p className="text-xs text-slate-500">
                {h.reviewerName} · {formatDateTime(h.actionAt)}
                {h.itemFeedback.length ? ` · ${h.itemFeedback.length} item comment(s)` : ''}
              </p>
              {h.comments && <p className="mt-1 whitespace-pre-line text-slate-700">{h.comments}</p>}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
