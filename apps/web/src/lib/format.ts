import { format as fmt, formatDistanceToNowStrict } from 'date-fns';
import { TZDate } from '@date-fns/tz';

/**
 * Timezone-aware display (UI-08). The display timezone comes from the configured system timezone
 * (GET /settings/public), overridden by the user's profile timezone when set.
 */
let displayTz = 'UTC';
let dateFormat = 'dd/MM/yyyy';

export function configureDisplay(opts: { timezone?: string; dateFormat?: string }) {
  if (opts.timezone && isValidTimeZone(opts.timezone)) displayTz = opts.timezone;
  if (opts.dateFormat) dateFormat = opts.dateFormat;
}
export function getDisplayTimezone() {
  return displayTz;
}

export function isValidTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function toDate(v: string | number | Date | null | undefined): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(v: string | Date | null | undefined) {
  const d = toDate(v);
  return d ? fmt(new TZDate(d, displayTz), dateFormat) : '—';
}

export function formatDateTime(v: string | Date | null | undefined, withTz = true) {
  const d = toDate(v);
  if (!d) return '—';
  const s = fmt(new TZDate(d, displayTz), `${dateFormat} HH:mm`);
  return withTz ? `${s} ${tzAbbrev(d)}` : s;
}

export function tzAbbrev(d: Date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: displayTz, timeZoneName: 'short' }).formatToParts(d);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? displayTz;
  } catch {
    return displayTz;
  }
}

export function timeAgo(v: string | Date | null | undefined) {
  const d = toDate(v);
  return d ? `${formatDistanceToNowStrict(d)} ago` : '—';
}

export function listTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    const list = intl.supportedValuesOf?.('timeZone');
    if (list?.length) return list.includes('UTC') ? list : ['UTC', ...list];
  } catch {
    /* fall through */
  }
  return ['UTC', 'Europe/London', 'Europe/Paris', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'America/New_York'];
}

/** Short device description from a user-agent string. */
export function describeUserAgent(ua?: string | null) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}
