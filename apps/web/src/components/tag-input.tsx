import { useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Free-text tag list (e.g. allowed file extensions). Enter or comma adds; Backspace removes last. */
export function TagInput({
  id,
  value,
  onChange,
  placeholder,
  normalize = (s) => s.trim(),
  invalid,
  disabled,
}: {
  id?: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  normalize?: (s: string) => string;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const add = () => {
    const parts = text.split(/[,\s]+/).map(normalize).filter(Boolean);
    if (parts.length) onChange(Array.from(new Set([...value, ...parts])));
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div className={cn('input-base flex min-h-[40px] flex-wrap items-center gap-1', invalid && 'border-red-500')} aria-invalid={invalid || undefined}>
      {value.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
          {t}
          {!disabled && (
            <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))} className="rounded hover:bg-slate-200">
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      <input
        id={id}
        disabled={disabled}
        className="min-w-[6rem] flex-1 border-0 bg-transparent p-0 text-sm focus:outline-none focus:ring-0"
        value={text}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onBlur={add}
      />
    </div>
  );
}
