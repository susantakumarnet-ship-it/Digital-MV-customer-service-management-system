import { useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Checkbox } from './ui/controls';

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

/** Searchable multi-select with removable chips. */
export function MultiSelect({
  id,
  options,
  value,
  onChange,
  placeholder = 'Select…',
  disabled,
  invalid,
  loading,
}: {
  id?: string;
  options: Option[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  loading?: boolean;
}) {
  const [q, setQ] = useState('');
  const selected = useMemo(() => options.filter((o) => value.includes(o.value)), [options, value]);
  const filtered = useMemo(
    () => options.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase()) || o.hint?.toLowerCase().includes(q.toLowerCase())),
    [options, q],
  );
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  return (
    <Popover.Root>
      <Popover.Trigger asChild disabled={disabled}>
        <button
          id={id}
          type="button"
          aria-invalid={invalid || undefined}
          className={cn('input-base flex min-h-[40px] flex-wrap items-center gap-1 text-left', disabled && 'cursor-not-allowed')}
        >
          {selected.length === 0 && <span className="text-slate-400">{loading ? 'Loading…' : placeholder}</span>}
          {selected.map((o) => (
            <span key={o.value} className="inline-flex items-center gap-1 rounded-md bg-royal-50 px-1.5 py-0.5 text-xs text-royal-800">
              {o.label}
              {!disabled && (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Remove ${o.label}`}
                  className="rounded hover:bg-royal-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(o.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      toggle(o.value);
                    }
                  }}
                >
                  <X className="h-3 w-3" />
                </span>
              )}
            </span>
          ))}
          <ChevronDown className="ml-auto h-4 w-4 text-slate-400" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[var(--radix-popover-trigger-width)] min-w-[16rem] rounded-lg border border-border bg-white p-2 shadow-lg"
        >
          <input
            className="input-base mb-2"
            placeholder="Search…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search options"
          />
          <div className="max-h-60 overflow-y-auto">
            {filtered.length === 0 && <p className="px-2 py-3 text-sm text-slate-500">No options</p>}
            {filtered.map((o) => (
              <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50">
                <Checkbox checked={value.includes(o.value)} onCheckedChange={() => toggle(o.value)} />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.hint && <span className="text-xs text-slate-400">{o.hint}</span>}
              </label>
            ))}
          </div>
          {value.length > 0 && (
            <button type="button" className="mt-2 text-xs text-royal-700 hover:underline" onClick={() => onChange([])}>
              Clear selection
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
