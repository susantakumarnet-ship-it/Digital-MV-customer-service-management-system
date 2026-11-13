import { useId, useState } from 'react';
import { Star } from 'lucide-react';
import type { AcceptanceSummaryDto } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { FormField, Input, Textarea } from '@/components/ui/form';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { formatMinutes, validateDecision, type DecisionDraft } from './acceptance-lib';

/** What was done: work orders, visits, on-site time and approved inspection summaries. */
export function ServiceSummary({ summary }: { summary: AcceptanceSummaryDto }) {
  const s = summary.serviceCompletion;
  return (
    <div className="space-y-4 text-sm">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Visits</dt>
          <dd className="text-lg font-semibold text-navy-900">{s.visits}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Time on site</dt>
          <dd className="text-lg font-semibold text-navy-900">{formatMinutes(s.onSiteMinutes)}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">First visit</dt>
          <dd className="text-slate-800">{s.firstVisitAt ? formatDate(s.firstVisitAt) : '—'}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Last visit</dt>
          <dd className="text-slate-800">{s.lastVisitAt ? formatDate(s.lastVisitAt) : '—'}</dd>
        </div>
      </dl>
      {summary.workOrders.length > 0 && (
        <div>
          <h3 className="font-medium text-navy-900">Work carried out</h3>
          <ul className="mt-1 space-y-1">
            {summary.workOrders.map((w) => (
              <li key={w.workOrderNo} className="flex flex-wrap justify-between gap-2">
                <span>
                  <span className="font-mono text-slate-600">{w.workOrderNo}</span> · {w.title}
                </span>
                {w.completedAt && <span className="text-xs text-slate-500">completed {formatDate(w.completedAt)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.approvedReports.length > 0 && (
        <div>
          <h3 className="font-medium text-navy-900">Approved inspection reports</h3>
          <ul className="mt-1 space-y-3">
            {summary.approvedReports.map((r, i) => (
              <li key={`${r.workOrderNo}-${i}`} className="rounded-lg border border-border p-3">
                <p className="font-medium text-navy-900">
                  {r.template} <span className="font-mono text-xs font-normal text-slate-500">({r.workOrderNo})</span>
                </p>
                <p className="text-xs text-slate-600">
                  {r.summary.pass} passed · {r.summary.fail} failed · {r.summary.notChecked} not checked · {r.summary.notApplicable} not applicable
                  {r.approvedAt ? ` · approved ${formatDate(r.approvedAt)}` : ''}
                </p>
                {r.findings && (
                  <p className="mt-2 whitespace-pre-line">
                    <span className="font-medium">Findings:</span> {r.findings}
                  </p>
                )}
                {r.recommendations && (
                  <p className="mt-1 whitespace-pre-line">
                    <span className="font-medium">Recommendations:</span> {r.recommendations}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function StarRating({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const name = useId();
  return (
    <fieldset>
      <legend className="field-label">How satisfied are you? (optional)</legend>
      <div className="flex gap-1" role="radiogroup" aria-label="Satisfaction rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className="cursor-pointer">
            <input type="radio" name={name} value={n} checked={value === n} onChange={() => onChange(n)} disabled={disabled} className="peer sr-only" aria-label={`${n} star${n > 1 ? 's' : ''}`} />
            <Star className={cn('h-7 w-7 rounded peer-focus-visible:ring-2 peer-focus-visible:ring-royal-600', n <= value ? 'fill-amber-400 text-amber-500' : 'text-slate-400')} aria-hidden />
          </label>
        ))}
        {value > 0 && (
          <button type="button" className="ml-2 text-xs text-slate-600 underline" onClick={() => onChange(0)} disabled={disabled}>
            Clear
          </button>
        )}
      </div>
    </fieldset>
  );
}

/** Accept / request further action form (portal and secure link). */
export function DecisionForm({ requireName, defaultName = '', onSubmit }: { requireName: boolean; defaultName?: string; onSubmit: (d: DecisionDraft) => Promise<unknown> }) {
  const [d, setD] = useState<DecisionDraft>({ decision: '', comments: '', rating: 0, feedback: '', signerName: defaultName });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const errors = touched ? validateDecision(d, requireName) : {};
  const submit = async () => {
    setTouched(true);
    if (Object.keys(validateDecision(d, requireName)).length) return;
    setBusy(true);
    try {
      await onSubmit(d);
    } catch {
      /* caller shows error */
    } finally {
      setBusy(false);
    }
  };
  const choice = (value: 'ACCEPT' | 'REJECT', label: string, hint: string) => (
    <label className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm', d.decision === value ? (value === 'ACCEPT' ? 'border-emerald-600 bg-emerald-50' : 'border-red-600 bg-red-50') : 'border-border hover:bg-slate-50')}>
      <input type="radio" name="decision" className="mt-1" checked={d.decision === value} onChange={() => setD((x) => ({ ...x, decision: value }))} disabled={busy} />
      <span>
        <span className="block font-medium text-navy-900">{label}</span>
        <span className="block text-slate-600">{hint}</span>
      </span>
    </label>
  );
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="field-label">Your decision</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {choice('ACCEPT', 'Accept the service', 'The work is complete to my satisfaction.')}
          {choice('REJECT', 'Request further action', 'Something still needs to be done.')}
        </div>
        {errors.decision && (
          <p className="mt-1 text-xs text-red-600" role="alert">
            {errors.decision}
          </p>
        )}
      </fieldset>
      <FormField label={d.decision === 'REJECT' ? 'What still needs to be done?' : 'Comments'} required={d.decision === 'REJECT'} error={errors.comments}>
        {(p) => <Textarea {...p} rows={3} maxLength={4000} value={d.comments} onChange={(e) => setD((x) => ({ ...x, comments: e.target.value }))} disabled={busy} />}
      </FormField>
      <StarRating value={d.rating} onChange={(rating) => setD((x) => ({ ...x, rating }))} disabled={busy} />
      <FormField label="Feedback (optional)">
        {(p) => <Textarea {...p} rows={2} maxLength={4000} value={d.feedback} onChange={(e) => setD((x) => ({ ...x, feedback: e.target.value }))} disabled={busy} />}
      </FormField>
      {requireName && (
        <FormField label="Your name" required error={errors.signerName} help="Recorded with your decision.">
          {(p) => <Input {...p} maxLength={150} autoComplete="name" value={d.signerName} onChange={(e) => setD((x) => ({ ...x, signerName: e.target.value }))} disabled={busy} />}
        </FormField>
      )}
      <div className="flex justify-end">
        <Button size="lg" variant={d.decision === 'REJECT' ? 'danger' : 'accent'} onClick={submit} loading={busy}>
          {d.decision === 'REJECT' ? 'Send request for further action' : 'Submit decision'}
        </Button>
      </div>
    </div>
  );
}

