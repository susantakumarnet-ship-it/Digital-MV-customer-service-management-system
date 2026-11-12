import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import type { MasterResourceDef } from '@mv/shared';
import { Card } from '@/components/ui/card';
import { LoadingScreen } from '@/components/ui/spinner';
import { PageHeader } from '@/components/page-header';
import { ErrorState } from '@/components/states';
import { api } from '@/lib/api';

export function useMasterDefinitions() {
  return useQuery({
    queryKey: ['masters', 'definitions'],
    queryFn: async () => (await api.get<MasterResourceDef[]>('/masters')).data,
    staleTime: Infinity,
  });
}

export function MastersIndexPage() {
  const defs = useMasterDefinitions();
  if (defs.isLoading) return <LoadingScreen />;
  if (defs.isError)
    return (
      <Card>
        <ErrorState error={defs.error} onRetry={() => defs.refetch()} />
      </Card>
    );

  const groups = new Map<string, MasterResourceDef[]>();
  for (const d of defs.data ?? []) groups.set(d.group, [...(groups.get(d.group) ?? []), d]);

  return (
    <div>
      <PageHeader
        title="Master data"
        description="Reference data used across complaints and service work. Records referenced by transactions are deactivated, never deleted."
      />
      <div className="space-y-6">
        {[...groups.entries()].map(([group, items]) => (
          <section key={group}>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{group}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {items.map((d) => (
                <Link key={d.key} to={`/admin/masters/${d.key}`} className="card group flex items-center gap-3 p-4 hover:border-royal-200 hover:shadow-md">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-navy-900">{d.label}</p>
                    <p className="truncate text-xs text-slate-500">
                      {d.refs.length ? `Linked to ${d.refs.map((r) => r.ref).join(', ')}` : `${d.fields.length} fields`}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-royal-700" aria-hidden />
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
