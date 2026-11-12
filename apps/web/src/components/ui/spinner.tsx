import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role="status" className="inline-flex items-center">
      <Loader2 className={cn('h-5 w-5 animate-spin text-royal-700', className)} aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function LoadingScreen({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] w-full flex-col items-center justify-center gap-3 text-sm text-slate-500">
      <Spinner className="h-7 w-7" label={label} />
      <span aria-hidden>{label}</span>
    </div>
  );
}
