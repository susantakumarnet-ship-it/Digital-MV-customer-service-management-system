import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const ACCENTS = {
  navy: 'bg-navy-50 text-navy-800',
  royal: 'bg-royal-50 text-royal-700',
  teal: 'bg-teal-50 text-teal-700',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-700',
  slate: 'bg-slate-100 text-slate-600',
};

export function KpiCard({
  label,
  value,
  icon,
  hint,
  accent = 'navy',
  loading,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  accent?: keyof typeof ACCENTS;
  loading?: boolean;
}) {
  return (
    <div className="card flex items-start gap-3 p-4">
      {icon && <div className={cn('rounded-lg p-2.5', ACCENTS[accent])}>{icon}</div>}
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        {loading ? <div className="skeleton mt-2 h-7 w-16" /> : <p className="mt-1 text-2xl font-semibold tabular-nums text-navy-900">{value}</p>}
        {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
      </div>
    </div>
  );
}
