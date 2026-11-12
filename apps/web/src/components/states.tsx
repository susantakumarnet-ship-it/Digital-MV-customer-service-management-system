import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, ShieldOff } from 'lucide-react';
import { errorMessage } from '@/lib/api';
import { Button } from './ui/button';

export function EmptyState({ title, description, action, icon }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="mb-1 rounded-full bg-slate-100 p-3 text-slate-400">{icon ?? <Inbox className="h-6 w-6" aria-hidden />}</div>
      <p className="font-medium text-navy-900">{title}</p>
      {description && <p className="max-w-md text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Could not load data' }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <div className="mb-1 rounded-full bg-red-50 p-3 text-red-500">
        <AlertTriangle className="h-6 w-6" aria-hidden />
      </div>
      <p className="font-medium text-navy-900">{title}</p>
      <p className="max-w-md text-sm text-slate-500">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function ForbiddenState() {
  return (
    <EmptyState
      icon={<ShieldOff className="h-6 w-6" aria-hidden />}
      title="You do not have access to this page"
      description="Ask your administrator if you believe you should have access."
    />
  );
}
