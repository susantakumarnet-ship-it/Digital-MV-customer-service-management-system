import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Circle, Clock, History, MapPin, Navigation, Pencil, Timer } from 'lucide-react';
import { toast } from 'sonner';
import type { EngineerSequenceDto, TimeCorrectionDto, TimeEventDto, TimeEventType, VisitDetailDto } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/controls';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FormField, Input, Textarea } from '@/components/ui/form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/states';
import { api, errorMessage, parseApiError } from '@/lib/api';
import { formatDateTime, tzAbbrev } from '@/lib/format';
import { cn } from '@/lib/utils';
import { fromLocalInput, toLocalInput } from '@/features/work-orders/wo-lib';
import {
  CONFIRM_EVENTS,
  SEGMENTS,
  TIME_EVENT_LABELS,
  TIME_EVENT_TYPES,
  clockSkewSeconds,
  correctionWindow,
  formatDuration,
  osmLink,
  readPosition,
  runningMinutes,
  timeEventKey,
  validateCorrection,
} from './visit-lib';

type OnChanged = (v: VisitDetailDto) => void;

// ---- Recording ------------------------------------------------------------------------------------

/** User-facing explanation for time-event errors (codes from visit.service.ts). */
function describeTimeError(err: unknown, workOrderId: string): { message: string; link?: { to: string; label: string } } {
  const e = parseApiError(err);
  if (e.code === 'NOT_ACCEPTED') {
    return { message: 'Accept the work order before recording time.', link: { to: `/work-orders/${workOrderId}`, label: 'Open work order to accept' } };
  }
  // OUT_OF_ORDER, DUPLICATE_EVENT, SEQUENCE_COMPLETE, ACTIVE_SEQUENCE_EXISTS (names the other visit), WORK_ORDER_ON_HOLD
  return { message: e.message };
}

/**
 * "My time" card (VIS-01 / TIME-06): one large button for the next permitted event, optional GPS
 * capture on tap, and a vertical six-step stepper. The server records the authoritative time.
 */
export function MyTimeCard({ visit, onChanged }: { visit: VisitDetailDto; onChanged: OnChanged }) {
  const seq = visit.mySequence;
  const [shareLocation, setShareLocation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmEvent, setConfirmEvent] = useState<TimeEventType | null>(null);
  const [error, setError] = useState<{ message: string; link?: { to: string; label: string } } | null>(null);

  if (!seq) return null;
  const next = seq.nextEvent;

  const record = async (eventType: TimeEventType) => {
    setBusy(true);
    setError(null);
    try {
      let gps = null;
      if (shareLocation) {
        const r = await readPosition();
        gps = r.gps;
        if (!r.gps && r.error) toast.warning(`${r.error} The time was recorded without a location.`);
      }
      const res = await api.post<VisitDetailDto>(
        `/visits/${visit.id}/time-events`,
        { eventType, clientTimestamp: new Date().toISOString(), ...(gps ? { gps } : {}) },
        { headers: { 'Idempotency-Key': timeEventKey(visit.id, eventType) } },
      );
      onChanged(res.data);
      toast.success(`${TIME_EVENT_LABELS[eventType]} recorded`);
    } catch (err) {
      const d = describeTimeError(err, visit.workOrder.id);
      setError(d);
      toast.error(d.message);
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const tap = () => {
    if (!next) return;
    if (CONFIRM_EVENTS.includes(next)) setConfirmEvent(next);
    else void record(next).catch(() => undefined);
  };

  return (
    <Card>
      <CardHeader title="My time" description={`Times are recorded by the server (${tzAbbrev()}). Your device clock is not used.`} />
      <CardBody className="space-y-4">
        {visit.permissions.canRecordTime && next ? (
          <>
            <Button
              size="lg"
              variant="accent"
              className="h-14 w-full text-base sm:w-auto sm:min-w-[18rem]"
              loading={busy}
              onClick={tap}
              data-testid="next-event-button"
            >
              <Timer className="h-5 w-5" aria-hidden /> {TIME_EVENT_LABELS[next]}
            </Button>
            <div className="flex items-start gap-3 rounded-lg border border-border p-3">
              <Switch id="share-location" checked={shareLocation} onCheckedChange={setShareLocation} aria-describedby="share-location-help" />
              <div className="min-w-0">
                <label htmlFor="share-location" className="text-sm font-medium text-navy-900">
                  Share my location with this event
                </label>
                <p id="share-location-help" className="text-xs text-slate-500">
                  Optional. Your position is read once, only when you tap the button, after your browser asks for permission. It is not tracked.
                </p>
              </div>
            </div>
          </>
        ) : seq.complete ? (
          <p className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <Check className="h-4 w-4" aria-hidden /> All six time events are recorded for this visit.
          </p>
        ) : (
          <p className="text-sm text-slate-500">Time recording is not available for this visit.</p>
        )}
        {error && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error.message}
            {error.link && (
              <>
                {' '}
                <Link to={error.link.to} className="font-medium underline">
                  {error.link.label}
                </Link>
              </>
            )}
          </div>
        )}
        <Stepper sequence={seq} />
      </CardBody>
      <ConfirmDialog
        open={Boolean(confirmEvent)}
        onOpenChange={(o) => !o && setConfirmEvent(null)}
        title={confirmEvent ? `${TIME_EVENT_LABELS[confirmEvent]}?` : ''}
        description="This cannot be undone. If the time turns out to be wrong, use a correction request."
        confirmLabel={confirmEvent ? TIME_EVENT_LABELS[confirmEvent] : 'Confirm'}
        onConfirm={() => record(confirmEvent!)}
      />
    </Card>
  );
}

/** Vertical six-step stepper (done / next / upcoming). */
export function Stepper({ sequence, compact }: { sequence: EngineerSequenceDto; compact?: boolean }) {
  return (
    <ol className={cn('relative', compact ? 'space-y-1' : 'space-y-3')} aria-label={`Time events for ${sequence.engineer.name}`}>
      {TIME_EVENT_TYPES.map((t) => {
        const e = sequence.events.find((x) => x.eventType === t);
        const isNext = sequence.nextEvent === t;
        return (
          <li key={t} className="flex items-start gap-3" aria-current={isNext ? 'step' : undefined}>
            <span
              className={cn(
                'mt-0.5 flex shrink-0 items-center justify-center rounded-full',
                compact ? 'h-5 w-5' : 'h-7 w-7',
                e ? 'bg-teal-600 text-white' : isNext ? 'border-2 border-royal-700 bg-white text-royal-700' : 'border border-slate-300 bg-white text-slate-300',
              )}
              aria-hidden
            >
              {e ? <Check className={compact ? 'h-3 w-3' : 'h-4 w-4'} /> : <Circle className={compact ? 'h-2 w-2' : 'h-2.5 w-2.5'} fill="currentColor" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn('text-sm', e ? 'font-medium text-navy-900' : isNext ? 'font-medium text-royal-700' : 'text-slate-500')}>
                {TIME_EVENT_LABELS[t]}
                {isNext && !compact && <span className="ml-2 text-xs font-normal text-royal-700">Next</span>}
              </p>
              {e && (
                <p className="text-xs text-slate-500">
                  {formatDateTime(e.effectiveTimestamp)}
                  {e.corrected && (
                    <Badge tone="warning" className="ml-1.5">
                      corrected
                    </Badge>
                  )}
                  {e.gps && <MapPin className="ml-1 inline h-3 w-3 text-teal-600" aria-label="Location captured" />}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Duration tiles with a live estimate for the running segment. */
export function DurationsGrid({ sequence }: { sequence: EngineerSequenceDto }) {
  const [now, setNow] = useState(() => Date.now());
  const running = useMemo(() => SEGMENTS.some((s) => runningMinutes(sequence.events, s.from, s.to) !== null), [sequence.events]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [running]);
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {SEGMENTS.map((s) => {
        const done = sequence.durations[s.key];
        const live = done === null ? runningMinutes(sequence.events, s.from, s.to, now) : null;
        return (
          <div key={s.key} className={cn('rounded-lg border p-3', s.key === 'totalElapsed' ? 'border-navy-200 bg-navy-50' : 'border-border')}>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{s.label}</dt>
            <dd className="mt-1 text-lg font-semibold text-navy-900">
              {done !== null ? (
                formatDuration(done)
              ) : live !== null ? (
                <span className="text-teal-700">
                  {formatDuration(live)}
                  <span className="ml-1 block text-[11px] font-normal text-teal-700">running · estimate</span>
                </span>
              ) : (
                '—'
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** Compact steppers for every engineer on the visit (supervisors, co-engineers). */
export function TeamSequences({ visit }: { visit: VisitDetailDto }) {
  if (!visit.sequences.length) return null;
  return (
    <Card>
      <CardHeader title="Team progress" description="Each engineer records their own six events." />
      <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
        {visit.sequences.map((s) => (
          <div key={s.engineer.id} className="rounded-lg border border-border p-3">
            <p className="mb-2 flex items-center justify-between gap-2 text-sm font-medium text-navy-900">
              {s.engineer.name}
              {s.complete ? <Badge tone="success">Complete</Badge> : s.events.length ? <Badge tone="accent">In progress</Badge> : <Badge>Not started</Badge>}
            </p>
            <Stepper sequence={s} compact />
            {/* TIME-06: full breakdown for supervisors/reviewers checking time logs. */}
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
      </div>
    </Card>
  );
}

// ---- Events table & corrections ---------------------------------------------------------------------

export function TimeEventsTable({ visit, onChanged }: { visit: VisitDetailDto; onChanged: OnChanged }) {
  const [correcting, setCorrecting] = useState<{ event: TimeEventDto; events: TimeEventDto[] } | null>(null);
  const withEvents = visit.sequences.filter((s) => s.events.length);
  return (
    <Card>
      <CardHeader title="Time events" description={`Server-recorded times in ${tzAbbrev()}. Corrections never overwrite the original.`} />
      {!withEvents.length ? (
        <EmptyState icon={<Clock className="h-6 w-6" />} title="No time recorded yet" />
      ) : (
        <div className="divide-y divide-border">
          {withEvents.map((s) => {
            const mine = s.engineer.id === visit.mySequence?.engineer.id;
            return (
              <div key={s.engineer.id} className="px-5 py-4">
                <p className="mb-2 text-sm font-semibold text-navy-900">{s.engineer.name}</p>
                <ul className="space-y-2">
                  {s.events.map((e) => {
                    const skew = clockSkewSeconds(e);
                    return (
                      <li key={e.id} className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="font-medium text-navy-900">
                            {e.sequence}. {TIME_EVENT_LABELS[e.eventType]}
                          </p>
                          <p className="text-slate-700">
                            {formatDateTime(e.effectiveTimestamp)}{' '}
                            <span className="text-xs text-slate-500">(server time)</span>
                            {e.corrected && (
                              <>
                                <Badge tone="warning" className="ml-1.5">
                                  corrected
                                </Badge>
                                <span className="ml-1.5 text-xs text-slate-500 line-through" aria-label="Original server time">
                                  {formatDateTime(e.serverTimestamp)}
                                </span>
                              </>
                            )}
                          </p>
                          <p className="flex flex-wrap gap-x-3 text-xs text-slate-500">
                            {skew !== null && Math.abs(skew) >= 60 && <span>Device clock {skew > 0 ? 'ahead' : 'behind'} by {formatDuration(Math.abs(skew) / 60)}</span>}
                            {e.gps && (
                              <a href={osmLink(e.gps.latitude, e.gps.longitude)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-royal-700 hover:underline">
                                <Navigation className="h-3 w-3" aria-hidden /> Location{e.gps.accuracy ? ` (±${Math.round(e.gps.accuracy)} m)` : ''}
                              </a>
                            )}
                            {e.note && <span>Note: {e.note}</span>}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {e.pendingCorrection && <Badge tone="warning">Correction pending</Badge>}
                          {mine && visit.permissions.canRequestCorrection && (
                            <Button size="sm" variant="outline" disabled={Boolean(e.pendingCorrection)} onClick={() => setCorrecting({ event: e, events: s.events })}>
                              <Pencil className="h-3.5 w-3.5" /> Request correction
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      {correcting && (
        <CorrectionDialog visitId={visit.id} event={correcting.event} events={correcting.events} open onOpenChange={(o) => !o && setCorrecting(null)} onChanged={onChanged} />
      )}
    </Card>
  );
}

/** TIME-07: request a correction — original kept, proposed time + mandatory reason. */
export function CorrectionDialog({
  visitId,
  event,
  events,
  open,
  onOpenChange,
  onChanged,
}: {
  visitId: string;
  event: TimeEventDto;
  events: TimeEventDto[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onChanged: OnChanged;
}) {
  const [when, setWhen] = useState(() => toLocalInput(event.effectiveTimestamp));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const win = correctionWindow(events, event);

  const submit = async () => {
    const iso = fromLocalInput(when);
    const errs = validateCorrection(events, event, iso ? new Date(iso) : null, reason);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const res = await api.post<VisitDetailDto>(`/visits/${visitId}/time-corrections`, { timeEventId: event.id, proposedTimestamp: iso, reason: reason.trim() });
      onChanged(res.data);
      toast.success('Correction requested — a supervisor will review it');
      onOpenChange(false);
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
        title={`Request correction — ${TIME_EVENT_LABELS[event.eventType]}`}
        description="The original server time stays on record. An approver decides whether the corrected time is used."
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy}>
              Request correction
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Recorded: <span className="font-medium text-navy-900">{formatDateTime(event.effectiveTimestamp)}</span>
          </p>
          <FormField
            label="Correct date and time"
            required
            error={errors.proposedTimestamp}
            help={[win.after && `after ${win.afterLabel} (${formatDateTime(win.after)})`, win.before && `before ${win.beforeLabel} (${formatDateTime(win.before)})`].filter(Boolean).join(' and ') || 'Your local time'}
          >
            {(p) => <Input {...p} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}
          </FormField>
          <FormField label="Reason" required error={errors.reason}>
            {(p) => <Textarea {...p} rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. No signal on site — tapped Arrive late" />}
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Corrections for a visit with inline approve/reject for authorised approvers (not the engineer). */
export function CorrectionsList({
  corrections,
  canApprove,
  currentUserId,
  onDecided,
  showVisitLink,
}: {
  corrections: (TimeCorrectionDto & { visitLabel?: string })[];
  canApprove: boolean;
  currentUserId?: string;
  onDecided: () => void;
  showVisitLink?: boolean;
}) {
  const [rejecting, setRejecting] = useState<TimeCorrectionDto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const decide = async (c: TimeCorrectionDto, decision: 'APPROVE' | 'REJECT', comment?: string) => {
    setBusy(c.id);
    try {
      await api.post(`/time-corrections/${c.id}/decision`, { decision, comment: comment || undefined });
      toast.success(decision === 'APPROVE' ? 'Correction approved' : 'Correction rejected');
      onDecided();
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    } finally {
      setBusy(null);
    }
  };

  if (!corrections.length) return <EmptyState icon={<History className="h-6 w-6" />} title="No correction requests" />;
  return (
    <>
      <ul className="divide-y divide-border">
        {corrections.map((c) => {
          const own = c.engineer.id === currentUserId;
          return (
            <li key={c.id} className="flex flex-col gap-2 px-5 py-3 text-sm lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium text-navy-900">
                  {c.engineer.name} · {TIME_EVENT_LABELS[c.eventType]}
                  {showVisitLink && (
                    <Link to={`/visits/${c.visitId}`} className="ml-2 font-normal text-royal-700 hover:underline">
                      Open visit
                    </Link>
                  )}
                </p>
                <p className="text-slate-700">
                  <span className="line-through">{formatDateTime(c.originalTimestamp)}</span> → <span className="font-medium">{formatDateTime(c.proposedTimestamp)}</span>
                </p>
                <p className="text-slate-600">Reason: {c.reason}</p>
                <p className="text-xs text-slate-500">
                  Requested by {c.requestedByName} · {formatDateTime(c.requestedAt)}
                  {c.reviewerName && ` · ${c.status === 'APPROVED' ? 'Approved' : 'Rejected'} by ${c.reviewerName} ${c.decidedAt ? formatDateTime(c.decidedAt) : ''}`}
                </p>
                {c.decisionComment && <p className="text-xs text-slate-600">Comment: {c.decisionComment}</p>}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Badge tone={c.status === 'APPROVED' ? 'success' : c.status === 'REJECTED' ? 'danger' : 'warning'}>{c.status === 'PENDING' ? 'Pending' : c.status === 'APPROVED' ? 'Approved' : 'Rejected'}</Badge>
                {c.status === 'PENDING' && canApprove && !own && (
                  <>
                    <Button size="sm" variant="accent" loading={busy === c.id} onClick={() => decide(c, 'APPROVE').catch(() => undefined)}>
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" className="text-red-700" disabled={busy === c.id} onClick={() => setRejecting(c)}>
                      Reject
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={Boolean(rejecting)}
        onOpenChange={(o) => !o && setRejecting(null)}
        title="Reject time correction?"
        description="The original time remains in use. The engineer is notified with your comment."
        confirmLabel="Reject"
        tone="danger"
        reason="required"
        reasonLabel="Comment"
        onConfirm={(comment) => decide(rejecting!, 'REJECT', comment)}
      />
    </>
  );
}
