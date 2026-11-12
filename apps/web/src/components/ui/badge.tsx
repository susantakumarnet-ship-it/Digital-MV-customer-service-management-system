import type { HTMLAttributes } from 'react';
import { STATUS_TONES, type StatusTone } from '@mv/shared';
import { cn } from '@/lib/utils';

/** Tone → classes. Keys mirror the shared STATUS_TONES so workflow-configured tones always render. */
export const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-300',
  info: 'bg-sky-50 text-sky-800 ring-sky-200',
  primary: 'bg-royal-50 text-royal-800 ring-royal-200',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200',
  success: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  danger: 'bg-red-50 text-red-700 ring-red-200',
  accent: 'bg-teal-50 text-teal-700 ring-teal-100',
};

export function toneOf(value: string | undefined): StatusTone {
  return (STATUS_TONES as readonly string[]).includes(value ?? '') ? (value as StatusTone) : 'neutral';
}

export function Badge({ tone = 'neutral', className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: StatusTone }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', TONE_CLASSES[tone], className)}
      {...props}
    />
  );
}

/** Generic status → tone mapping for platform records (users, masters, roles). */
const STATUS_TONE_MAP: Record<string, StatusTone> = {
  ACTIVE: 'success',
  INACTIVE: 'neutral',
  LOCKED: 'danger',
  PENDING_ACTIVATION: 'warning',
  SUCCESS: 'success',
  FAILURE: 'danger',
};

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  LOCKED: 'Locked',
  PENDING_ACTIVATION: 'Pending activation',
  SUCCESS: 'Success',
  FAILURE: 'Failure',
};

export function StatusBadge({ status, label, tone }: { status: string; label?: string; tone?: StatusTone }) {
  const t = tone ?? STATUS_TONE_MAP[status] ?? 'neutral';
  return (
    <Badge tone={t} data-tone={t}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden />
      {label ?? STATUS_LABELS[status] ?? status}
    </Badge>
  );
}
