import { useEffect, useMemo, useRef, useState } from 'react';
import { useRevisions } from '@/features/reviews/review-lib';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, CheckCircle2, CloudOff, Eye, GitCompare, History, Loader2, Lock, MessageSquareWarning, Save, Send } from 'lucide-react';
import { toast } from 'sonner';
import type { InspectionReportDto } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge, StatusBadge, toneOf } from '@/components/ui/badge';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState, ErrorState } from '@/components/states';
import { useBreadcrumb } from '@/app/breadcrumbs';
import { api, errorMessage, parseApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { usePublicSettings } from '@/lib/queries';
import { ChecklistItem } from './checklist-item';
import { groupBySection, initialValues, issueItemKey, useReportAutosave, type ItemValue, type SaveState } from './report-lib';

export function InspectionReportPage() {
  const { id = '' } = useParams();
  const q = useQuery({
    queryKey: ['inspection-reports', 'detail', id],
    queryFn: async () => (await api.get<InspectionReportDto>(`/inspection-reports/${id}`)).data,
  });
  useBreadcrumb(q.data ? `${q.data.visit.visitNo} · rev ${q.data.revisionNo}` : undefined);
  if (q.isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-8 w-64" />
        <div className="skeleton h-64" />
      </div>
    );
  }
  if (q.isError) {
    const status = parseApiError(q.error).status;
    return (
      <Card>
        {status === 404 || status === 400 ? (
          <EmptyState title="Inspection report not found" description="It may not exist, or it is outside your data access." />
        ) : (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        )}
      </Card>
    );
  }
  return q.data ? <ReportView key={q.data.id} report={q.data} /> : null;
}

export function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state.status === 'saving' || state.status === 'pending')
    return (
      <span className="inline-flex items-center gap-1 text-xs text-slate-500" aria-live="polite">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Saving…
      </span>
    );
  if (state.status === 'error')
    return (
      <span className="inline-flex items-center gap-1 text-xs text-red-700" role="alert">
        <CloudOff className="h-3.5 w-3.5" aria-hidden /> Save failed —{' '}
        <button type="button" className="font-medium underline" onClick={onRetry}>
          retry
        </button>
      </span>
    );
  if (state.status === 'saved' && state.savedAt)
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-700" aria-live="polite">
        <Save className="h-3.5 w-3.5" aria-hidden /> Saved {state.savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
    );
  return null;
}

function ReportView({ report: initial }: { report: InspectionReportDto }) {
  const qc = useQueryClient();
  const settings = usePublicSettings();
  const [report, setReport] = useState(initial);
  const [values, setValues] = useState<Record<string, ItemValue>>(() => initialValues(initial.items));
  const [findings, setFindings] = useState(initial.findings ?? '');
  const [recommendations, setRecommendations] = useState(initial.recommendations ?? '');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const readOnly = !report.permissions.canEdit;

  // Autosave and evidence uploads can overlap; a slower, older response must not overwrite newer
  // server state (e.g. a just-uploaded photo). Apply each response immediately for responsiveness,
  // then re-fetch the authoritative report once activity settles so the final state always wins.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
  }, []);
  const applyServer = (r: InspectionReportDto) => {
    setReport(r);
    qc.setQueryData(['inspection-reports', 'detail', r.id], r);
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => {
      void qc.invalidateQueries({ queryKey: ['inspection-reports', 'detail', r.id] });
    }, 400);
  };
  const autosave = useReportAutosave(report.id, applyServer);

  // Keep server-derived data (issues, attachments) fresh when the cache changes elsewhere.
  useEffect(() => setReport(initial), [initial]);

  const change = (key: string, v: ItemValue) => {
    setValues((cur) => ({ ...cur, [key]: v }));
    autosave.queueItem(key, v);
  };

  const groups = useMemo(() => groupBySection(report.items), [report.items]);
  const answered = Object.values(values).filter((v) => v.result).length;
  const fails = Object.values(values).filter((v) => v.result === 'FAIL').length;

  const openPreview = async () => {
    await autosave.flush();
    setPreviewOpen(true);
  };

  const submit = async () => {
    try {
      await autosave.flush();
      const res = await api.post<InspectionReportDto>(`/inspection-reports/${report.id}/submit`);
      applyServer(res.data);
      void qc.invalidateQueries({ queryKey: ['visits'] });
      void qc.invalidateQueries({ queryKey: ['work-orders'] });
      void qc.invalidateQueries({ queryKey: ['inspection-reports', 'list'] });
      setPreviewOpen(false);
      toast.success('Report submitted for review');
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  };

  const goTo = (key: string) => {
    setPreviewOpen(false);
    setTimeout(() => document.getElementById(`item-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  return (
    <div className="space-y-4 pb-24 sm:pb-0">
      <div>
        <Link to={`/visits/${report.visit.id}`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-navy-900">
          <ArrowLeft className="h-4 w-4" /> Visit {report.visit.visitNo}
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-navy-900 sm:text-2xl">Inspection report</h1>
            <p className="mt-0.5 text-sm text-slate-600">
              {report.template.name} · v{report.template.version} · revision {report.revisionNo}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <StatusBadge status={report.status} label={report.statusLabel} tone={toneOf(report.statusTone)} />
              <Link to={`/work-orders/${report.workOrder.id}`} className="font-mono text-royal-700 hover:underline">
                {report.workOrder.workOrderNo}
              </Link>
              <span>· {report.site?.name}</span>
              {report.asset && (
                <span>
                  · {report.asset.name} {report.asset.code && <span className="text-slate-500">({report.asset.code})</span>}
                </span>
              )}
              {report.equipmentType && <span>· {report.equipmentType.name}</span>}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            {!readOnly && <SaveIndicator state={autosave.state} onRetry={() => void autosave.flush()} />}
            <RevisionsMenu reportId={report.id} currentRevision={report.revisionNo} />
          </div>
        </div>
      </div>

      {report.reviewFeedback && <ReturnedBanner report={report} />}

      {report.locked && (
        <div className="flex items-start gap-2 rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Submitted reports are read-only.
            {report.submittedAt && ` Submitted ${formatDateTime(report.submittedAt)}${report.submittedByName ? ` by ${report.submittedByName}` : ''}.`}
          </span>
        </div>
      )}

      {groups.map((g) => (
        <section key={g.section} aria-labelledby={`sec-${g.section}`} className="space-y-3">
          <h2 id={`sec-${g.section}`} className="text-base font-semibold text-navy-900">
            {g.section}
          </h2>
          {g.items.map((item) => (
            <ChecklistItem
              key={item.key}
              item={item}
              value={values[item.key] ?? { result: null, remarks: '', reason: '' }}
              onChange={(v) => change(item.key, v)}
              onBlur={() => void autosave.flush()}
              readOnly={readOnly}
              reportId={report.id}
              policy={settings.data?.attachments}
              onReportChanged={applyServer}
            />
          ))}
        </section>
      ))}

      <Card>
        <CardHeader title="Findings and recommendations" />
        <CardBody className="space-y-4">
          <div>
            <label htmlFor="findings" className="field-label">
              Findings
            </label>
            <Textarea
              id="findings"
              rows={4}
              maxLength={4000}
              disabled={readOnly}
              value={findings}
              onChange={(e) => {
                setFindings(e.target.value);
                autosave.queueText('findings', e.target.value);
              }}
              onBlur={() => void autosave.flush()}
            />
          </div>
          <div>
            <label htmlFor="recommendations" className="field-label">
              Recommendations
            </label>
            <Textarea
              id="recommendations"
              rows={4}
              maxLength={4000}
              disabled={readOnly}
              value={recommendations}
              onChange={(e) => {
                setRecommendations(e.target.value);
                autosave.queueText('recommendations', e.target.value);
              }}
              onBlur={() => void autosave.flush()}
            />
          </div>
        </CardBody>
      </Card>

      {!readOnly && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-white/95 px-4 py-3 shadow-lg backdrop-blur sm:static sm:rounded-xl sm:border sm:shadow-none">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
            <div className="min-w-0 text-sm">
              <p className="font-medium text-navy-900">
                {answered} of {report.items.length} answered
              </p>
              <p className="text-xs text-slate-500">{fails ? `${fails} failed` : 'No failures recorded'}</p>
            </div>
            <Button size="lg" className="h-12" onClick={openPreview}>
              <Eye className="h-4 w-4" /> Preview &amp; submit
            </Button>
          </div>
        </div>
      )}

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent
          title="Preview report"
          description={`${report.template.name} v${report.template.version} · revision ${report.revisionNo}`}
          size="lg"
          footer={
            <>
              <Button variant="outline" onClick={() => setPreviewOpen(false)}>
                Keep editing
              </Button>
              <Button variant="accent" disabled={!report.permissions.canSubmit} onClick={() => setConfirmSubmit(true)} data-testid="submit-report">
                <Send className="h-4 w-4" /> Submit for review
              </Button>
            </>
          }
        >
          <ReportPreview report={report} onGoTo={goTo} />
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmSubmit}
        onOpenChange={setConfirmSubmit}
        title="Submit this report for review?"
        description="After submission the report cannot be changed. Corrections are made in a new revision if a reviewer returns it."
        confirmLabel="Submit"
        onConfirm={submit}
      />
    </div>
  );
}

/** Summary counts + blocking issues (each links to its checklist item). */
export function ReportPreview({ report, onGoTo }: { report: InspectionReportDto; onGoTo: (key: string) => void }) {
  const s = report.summary;
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[
          ['Pass', s.pass, 'success'],
          ['Fail', s.fail, 'danger'],
          ['Not checked', s.notChecked, 'warning'],
          ['Not applicable', s.notApplicable, 'neutral'],
          ['Unanswered', s.unanswered, s.unanswered ? 'warning' : 'neutral'],
        ].map(([label, n, tone]) => (
          <div key={label as string} className="rounded-lg border border-border p-3">
            <dt className="text-xs text-slate-500">{label as string}</dt>
            <dd className="text-lg font-semibold text-navy-900">
              <Badge tone={tone as never}>{n as number}</Badge>
            </dd>
          </div>
        ))}
      </dl>
      {report.submissionIssues.length ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-900">
            <AlertTriangle className="h-4 w-4" aria-hidden /> Fix these before submitting ({report.submissionIssues.length})
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {report.submissionIssues.map((i) => {
              const key = issueItemKey(i);
              return (
                <li key={i}>
                  {key ? (
                    <button type="button" className="text-left text-amber-900 underline-offset-2 hover:underline" onClick={() => onGoTo(key)}>
                      {i}
                    </button>
                  ) : (
                    <span className="text-amber-900">{i}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <CheckCircle2 className="h-4 w-4" aria-hidden /> The report is complete and ready to submit.
        </p>
      )}
      {report.findings && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Findings</p>
          <p className="whitespace-pre-line text-sm text-slate-800">{report.findings}</p>
        </div>
      )}
    </div>
  );
}

/** Shown on a revision created by a reviewer's return (REV-02). */
export function ReturnedBanner({ report }: { report: InspectionReportDto }) {
  const fb = report.reviewFeedback!;
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="note" data-testid="returned-banner">
      <p className="flex items-start gap-2 font-medium">
        <MessageSquareWarning className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          Returned for correction by {fb.reviewerName} on {formatDateTime(fb.at)}
          {fb.comments ? `: ${fb.comments}` : ''}
        </span>
      </p>
      <p className="mt-1 pl-6 text-amber-800">Items with reviewer feedback are highlighted below. Correct them and submit this revision again.</p>
      {report.previousRevisionId && (
        <Link to={`/inspection-reports/${report.id}/compare?with=${report.previousRevisionId}`} className="mt-2 inline-flex items-center gap-1 pl-6 font-medium underline">
          <GitCompare className="h-4 w-4" aria-hidden /> Compare with previous revision
        </Link>
      )}
    </div>
  );
}

/** Revision switcher (only shown when more than one revision exists). */
function RevisionsMenu({ reportId, currentRevision }: { reportId: string; currentRevision: number }) {
  const q = useRevisions(reportId);
  const rows = Array.isArray(q.data) ? q.data : [];
  if (rows.length < 2) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <History className="h-4 w-4" /> Revisions ({rows.length})
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {rows.map((r) => (
          <DropdownMenuItem key={r.id} asChild>
            <Link to={`/inspection-reports/${r.id}`} className="flex w-full items-center justify-between gap-3">
              <span className={r.revisionNo === currentRevision ? 'font-semibold' : undefined}>Revision {r.revisionNo}</span>
              <span className="text-xs text-slate-500">{r.statusLabel}</span>
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
