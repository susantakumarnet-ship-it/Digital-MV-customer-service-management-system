import { useQuery } from '@tanstack/react-query';
import {
  TIME_EVENT_LABELS,
  TIME_EVENT_TYPES,
  type GpsInput,
  type Paged,
  type TimeCorrectionDto,
  type TimeEventDto,
  type TimeEventType,
  type VisitDetailDto,
  type VisitSummaryDto,
} from '@mv/shared';
import { api } from '@/lib/api';

export { TIME_EVENT_LABELS, TIME_EVENT_TYPES };

/** Minutes → "1 h 25 min" / "45 min" / "—". */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '—';
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} min`;
  if (rest === 0) return `${h} h`;
  return `${h} h ${rest} min`;
}

/** Idempotency-Key for one tap on a time button (API-04): [A-Za-z0-9_-], 16–100 chars. */
export function timeEventKey(visitId: string, eventType: TimeEventType) {
  const rand = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`;
  return `${visitId}-${eventType}-${rand}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
}

/** Visit statuses during which a sequence is actively running (dashboard "active visit"). */
export const ACTIVE_VISIT_STATUSES = ['TRAVEL_STARTED', 'ARRIVED', 'WORK_STARTED', 'WORK_ENDED', 'RETURN_TRAVEL'];

/** Events whose recording ends a phase of work — ask for confirmation. */
export const CONFIRM_EVENTS: TimeEventType[] = ['END_WORK', 'ARRIVE_BASE'];

/** Duration segments shown on the time screen, with the events that bound them. */
export const SEGMENTS: { key: 'travelToSite' | 'onSiteWaiting' | 'onSiteWork' | 'returnTravel' | 'totalElapsed'; label: string; from: TimeEventType; to: TimeEventType }[] = [
  { key: 'travelToSite', label: 'Travel to site', from: 'START_TRAVEL', to: 'ARRIVE_SITE' },
  { key: 'onSiteWaiting', label: 'Waiting on site', from: 'ARRIVE_SITE', to: 'START_WORK' },
  { key: 'onSiteWork', label: 'On-site work', from: 'START_WORK', to: 'END_WORK' },
  { key: 'returnTravel', label: 'Return travel', from: 'START_RETURN', to: 'ARRIVE_BASE' },
  { key: 'totalElapsed', label: 'Total elapsed', from: 'START_TRAVEL', to: 'ARRIVE_BASE' },
];

/**
 * Live estimate (minutes) for a segment that has started but not finished, measured from the
 * effective start to `now`. Returns null when the segment has not started or is already complete.
 */
export function runningMinutes(events: TimeEventDto[], from: TimeEventType, to: TimeEventType, now = Date.now()): number | null {
  const start = events.find((e) => e.eventType === from);
  const end = events.find((e) => e.eventType === to);
  if (!start || end) return null;
  return Math.max(0, Math.round((now - new Date(start.effectiveTimestamp).getTime()) / 60000));
}

/**
 * Allowed window for a corrected time: strictly after the previous event's effective time and
 * strictly before the next one's (server enforces the same rule), never in the future.
 */
export function correctionWindow(events: TimeEventDto[], event: TimeEventDto) {
  const prev = events.find((e) => e.sequence === event.sequence - 1);
  const next = events.find((e) => e.sequence === event.sequence + 1);
  return {
    after: prev ? new Date(prev.effectiveTimestamp) : null,
    before: next ? new Date(next.effectiveTimestamp) : null,
    afterLabel: prev ? TIME_EVENT_LABELS[prev.eventType] : null,
    beforeLabel: next ? TIME_EVENT_LABELS[next.eventType] : null,
  };
}

/** Validates a proposed correction; returns an error message or null. */
export function validateCorrection(events: TimeEventDto[], event: TimeEventDto, proposed: Date | null, reason: string, now = Date.now()): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!proposed || Number.isNaN(proposed.getTime())) errors.proposedTimestamp = 'Enter the correct date and time';
  else {
    const w = correctionWindow(events, event);
    if (proposed.getTime() > now + 60_000) errors.proposedTimestamp = 'The corrected time cannot be in the future';
    else if (w.after && proposed <= w.after) errors.proposedTimestamp = `Must be after ${w.afterLabel}`;
    else if (w.before && proposed >= w.before) errors.proposedTimestamp = `Must be before ${w.beforeLabel}`;
    else if (proposed.getTime() === new Date(event.effectiveTimestamp).getTime()) errors.proposedTimestamp = 'This is the time already recorded';
  }
  if (reason.trim().length < 5) errors.reason = 'Explain why the time is wrong (at least 5 characters)';
  return errors;
}

/** Client clock skew in seconds (clientTimestamp − serverTimestamp), shown as a diagnostic. */
export function clockSkewSeconds(e: TimeEventDto): number | null {
  if (!e.clientTimestamp) return null;
  return Math.round((new Date(e.clientTimestamp).getTime() - new Date(e.serverTimestamp).getTime()) / 1000);
}

export function osmLink(lat: number, lon: number) {
  return `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=17/${lat.toFixed(6)}/${lon.toFixed(6)}`;
}

/**
 * One-shot GPS read after an explicit user action (ENG-03). Resolves null when the browser has no
 * geolocation, the user denies permission, or the read times out — the event is then recorded
 * without a location.
 */
export function readPosition(timeoutMs = 10_000): Promise<{ gps: GpsInput | null; error?: string }> {
  const geo = typeof navigator !== 'undefined' ? navigator.geolocation : undefined;
  if (!geo) return Promise.resolve({ gps: null, error: 'Location is not available on this device.' });
  return new Promise((resolve) => {
    geo.getCurrentPosition(
      (p) =>
        resolve({
          gps: {
            latitude: p.coords.latitude,
            longitude: p.coords.longitude,
            accuracy: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : undefined,
            capturedAt: new Date(p.timestamp),
          },
        }),
      (err) =>
        resolve({
          gps: null,
          error: err.code === 1 ? 'Location permission was denied.' : 'Your location could not be read.',
        }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

// ---- Queries ------------------------------------------------------------------------------------

export function useVisit(id: string) {
  return useQuery({
    queryKey: ['visits', 'detail', id],
    queryFn: async () => (await api.get<VisitDetailDto>(`/visits/${id}`)).data,
    enabled: Boolean(id),
  });
}

export function useVisits(params: Record<string, string | number | undefined>, enabled = true) {
  return useQuery({
    queryKey: ['visits', 'list', params],
    queryFn: async () => (await api.get<Paged<VisitSummaryDto>>('/visits', { params })).data,
    enabled,
  });
}

export function useCorrections(params: Record<string, string | number | undefined>, enabled = true) {
  return useQuery({
    queryKey: ['time-corrections', params],
    queryFn: async () => (await api.get<Paged<TimeCorrectionDto>>('/time-corrections', { params })).data,
    enabled,
    refetchInterval: 60_000,
  });
}
