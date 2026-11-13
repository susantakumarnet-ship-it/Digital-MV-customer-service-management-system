import { useCallback, useEffect, useRef, useState } from 'react';
import type { InspectionReportDto, InspectionResult, ReportItemDto, TemplateItem } from '@mv/shared';
import { api } from '@/lib/api';

export interface ItemValue {
  result: InspectionResult | null;
  remarks: string;
  reason: string;
}

/** BR-007: Not Checked always needs a reason; Not Applicable only when the template says so. */
export function reasonRequired(item: Pick<TemplateItem, 'naReasonRequired'>, result: InspectionResult | null | undefined) {
  return result === 'NOT_CHECKED' || (result === 'NOT_APPLICABLE' && Boolean(item.naReasonRequired));
}

/** Groups checklist items by section, preserving template order. */
export function groupBySection<T extends { section?: string }>(items: T[]): { section: string; items: T[] }[] {
  const out: { section: string; items: T[] }[] = [];
  for (const it of items) {
    const name = it.section?.trim() || 'Checklist';
    let g = out.find((x) => x.section === name);
    if (!g) {
      g = { section: name, items: [] };
      out.push(g);
    }
    g.items.push(it);
  }
  return out;
}

/** Extracts the item key from a server submission issue ("KEY — description: problem"). */
export function issueItemKey(issue: string): string | null {
  const m = /^([A-Za-z0-9_-]+) — /.exec(issue);
  return m ? m[1]! : null;
}

export function initialValues(items: ReportItemDto[]): Record<string, ItemValue> {
  return Object.fromEntries(items.map((i) => [i.key, { result: i.result ?? null, remarks: i.remarks ?? '', reason: i.reason ?? '' }]));
}

export interface PendingDraft {
  results: Record<string, ItemValue>;
  findings?: string;
  recommendations?: string;
}

/** Builds the PUT body containing ONLY changed items/fields. */
export function buildDraftPayload(p: PendingDraft) {
  return {
    results: Object.entries(p.results).map(([itemKey, v]) => ({
      itemKey,
      result: v.result,
      remarks: v.remarks || undefined,
      reason: v.reason || undefined,
    })),
    ...(p.findings !== undefined ? { findings: p.findings } : {}),
    ...(p.recommendations !== undefined ? { recommendations: p.recommendations } : {}),
  };
}

export type SaveState = { status: 'idle' | 'pending' | 'saving' | 'saved' | 'error'; savedAt?: Date; error?: string };

/**
 * Debounced autosave for draft reports (INSP-05 / UI-07). Changes are queued per item and sent
 * together 1.5 s after the last edit (or immediately on flush — blur, tab hidden, before submit).
 */
export function useReportAutosave(reportId: string, onSaved: (r: InspectionReportDto) => void, delayMs = 1500) {
  const pending = useRef<PendingDraft>({ results: {} });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const savedCb = useRef(onSaved);
  savedCb.current = onSaved;
  const [state, setState] = useState<SaveState>({ status: 'idle' });

  const hasPending = () => Object.keys(pending.current.results).length > 0 || pending.current.findings !== undefined || pending.current.recommendations !== undefined;

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inflight.current) await inflight.current;
    if (!hasPending()) return;
    const batch = pending.current;
    pending.current = { results: {} };
    setState((s) => ({ ...s, status: 'saving' }));
    const run = (async () => {
      try {
        const res = await api.put<InspectionReportDto>(`/inspection-reports/${reportId}`, buildDraftPayload(batch));
        setState({ status: 'saved', savedAt: new Date() });
        savedCb.current(res.data);
      } catch (err) {
        // Re-queue the failed batch underneath any newer edits so nothing is lost.
        pending.current = {
          results: { ...batch.results, ...pending.current.results },
          findings: pending.current.findings ?? batch.findings,
          recommendations: pending.current.recommendations ?? batch.recommendations,
        };
        setState({ status: 'error', error: err instanceof Error ? err.message : 'Save failed' });
      }
    })();
    inflight.current = run;
    await run;
    inflight.current = null;
  }, [reportId]);

  const schedule = useCallback(() => {
    setState((s) => ({ ...s, status: 'pending' }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delayMs);
  }, [flush, delayMs]);

  const queueItem = useCallback(
    (key: string, value: ItemValue) => {
      pending.current.results[key] = value;
      schedule();
    },
    [schedule],
  );
  const queueText = useCallback(
    (field: 'findings' | 'recommendations', value: string) => {
      pending.current[field] = value;
      schedule();
    },
    [schedule],
  );

  // Save when the tab is hidden (phone locked, app switched) and on unmount.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      if (timer.current) clearTimeout(timer.current);
      if (hasPending()) void flush();
    };
  }, [flush]);

  return { state, queueItem, queueText, flush };
}
