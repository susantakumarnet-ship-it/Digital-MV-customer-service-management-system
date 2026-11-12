import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';

/** Last-resort boundary for render errors so users never see a blank screen. */
export function RouteError() {
  const err = useRouteError();
  const message = isRouteErrorResponse(err) ? `${err.status} ${err.statusText}` : err instanceof Error ? err.message : 'Unexpected error';
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="rounded-full bg-red-50 p-3 text-red-500">
        <AlertTriangle className="h-7 w-7" aria-hidden />
      </div>
      <h1 className="text-lg font-semibold text-navy-900">Something went wrong</h1>
      <p className="max-w-md text-sm text-slate-500">{message}</p>
      <div className="flex gap-3 text-sm">
        <button type="button" className="font-medium text-royal-700 hover:underline" onClick={() => window.location.reload()}>
          Reload
        </button>
        <Link to="/" className="font-medium text-royal-700 hover:underline">
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}
