import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';
import { MASTER_RESOURCES, type MasterKey } from '@mv/shared';
import { SEGMENT_LABELS } from './navigation';

const Ctx = createContext<{ labels: Record<string, string>; setLabel: (path: string, label: string | null) => void } | null>(null);

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [labels, setLabels] = useState<Record<string, string>>({});
  const setLabel = (path: string, label: string | null) =>
    setLabels((prev) => {
      if (label === null) {
        if (!(path in prev)) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      }
      return prev[path] === label ? prev : { ...prev, [path]: label };
    });
  return <Ctx.Provider value={{ labels, setLabel }}>{children}</Ctx.Provider>;
}

/** Pages with dynamic segments (e.g. a user id) register a friendly label for their crumb. */
export function useBreadcrumb(label: string | undefined) {
  const ctx = useContext(Ctx);
  const { pathname } = useLocation();
  useEffect(() => {
    if (!ctx || !label) return;
    ctx.setLabel(pathname, label);
    return () => ctx.setLabel(pathname, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, pathname]);
}

function labelFor(segment: string, path: string, labels: Record<string, string>) {
  if (labels[path]) return labels[path];
  if (SEGMENT_LABELS[segment]) return SEGMENT_LABELS[segment];
  if (segment in MASTER_RESOURCES) return MASTER_RESOURCES[segment as MasterKey].label;
  if (/^[a-f\d]{24}$/i.test(segment)) return 'Details';
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

export function Breadcrumbs() {
  const ctx = useContext(Ctx);
  const { pathname } = useLocation();
  const segments = pathname.split('/').filter(Boolean);
  const crumbs = segments.map((s, i) => {
    const path = '/' + segments.slice(0, i + 1).join('/');
    return { path, label: labelFor(s, path, ctx?.labels ?? {}), linkable: s !== 'admin' };
  });
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-sm text-slate-500">
        <li className="shrink-0">
          <Link to="/" className="flex items-center hover:text-navy-900" aria-label="Dashboard">
            <Home className="h-4 w-4" />
          </Link>
        </li>
        {crumbs.map((c, i) => (
          <li key={c.path} className="flex min-w-0 items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {i === crumbs.length - 1 ? (
              <span className="truncate font-medium text-navy-900" aria-current="page">
                {c.label}
              </span>
            ) : c.linkable ? (
              <Link to={c.path} className="truncate hover:text-navy-900">
                {c.label}
              </Link>
            ) : (
              <span className="truncate">{c.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
