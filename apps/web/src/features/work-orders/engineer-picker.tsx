import { AlertTriangle, Star } from 'lucide-react';
import type { EngineerWorkloadDto } from '@mv/shared';
import { Checkbox } from '@/components/ui/controls';
import { Select } from '@/components/ui/form';
import { cn } from '@/lib/utils';

/**
 * Engineer selection with live workload (active / overdue / due in 7 days) and an
 * "outside usual area" warning when the engineer's data scope does not cover the site.
 */
export function EngineerPicker({
  engineers,
  loading,
  value,
  onChange,
  lead,
  onLeadChange,
  error,
  leadError,
  idPrefix = 'eng',
}: {
  engineers: EngineerWorkloadDto[] | undefined;
  loading?: boolean;
  value: string[];
  onChange: (ids: string[]) => void;
  lead: string;
  onLeadChange: (id: string) => void;
  error?: string;
  leadError?: string;
  idPrefix?: string;
}) {
  const toggle = (id: string) => {
    const next = value.includes(id) ? value.filter((x) => x !== id) : [...value, id];
    onChange(next);
    if (!next.includes(lead)) onLeadChange(next[0] ?? '');
  };
  const chosen = (engineers ?? []).filter((e) => value.includes(e.id));

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="field-label">Engineers / technicians</legend>
        {loading ? (
          <div className="space-y-2">
            <div className="skeleton h-9" />
            <div className="skeleton h-9" />
          </div>
        ) : !engineers?.length ? (
          <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">No active field engineers are available.</p>
        ) : (
          <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border" aria-invalid={error ? true : undefined}>
            {engineers.map((e) => {
              const id = `${idPrefix}-${e.id}`;
              return (
                <li key={e.id} className={cn('flex items-start gap-3 px-3 py-2', value.includes(e.id) && 'bg-royal-50/50')}>
                  <Checkbox id={id} checked={value.includes(e.id)} onCheckedChange={() => toggle(e.id)} className="mt-0.5" />
                  <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                    <span className="block text-sm font-medium text-navy-900">{e.name}</span>
                    <span className="block text-xs text-slate-500">
                      {e.activeWorkOrders} active · {e.dueNext7Days} due in 7 days
                      {e.overdue > 0 && <span className="font-medium text-red-700"> · {e.overdue} overdue</span>}
                    </span>
                    {!e.eligible && (
                      <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-amber-700" data-testid={`outside-${e.id}`}>
                        <AlertTriangle className="h-3 w-3" aria-hidden /> Outside usual area
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {error && (
          <p className="mt-1 text-xs text-red-600" role="alert">
            {error}
          </p>
        )}
      </fieldset>
      {chosen.length > 1 && (
        <div>
          <label htmlFor={`${idPrefix}-lead`} className="field-label">
            <Star className="mr-1 inline h-3 w-3 text-amber-500" aria-hidden />
            Lead engineer
          </label>
          <Select id={`${idPrefix}-lead`} value={lead || chosen[0]!.id} onChange={(ev) => onLeadChange(ev.target.value)} aria-invalid={leadError ? true : undefined}>
            {chosen.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
          {leadError && (
            <p className="mt-1 text-xs text-red-600" role="alert">
              {leadError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
