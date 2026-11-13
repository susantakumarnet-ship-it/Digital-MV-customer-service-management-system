import { useSearchParams } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Pagination } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { ErrorState } from '@/components/states';
import { useAuth } from '@/features/auth/auth-context';
import { cn } from '@/lib/utils';
import { CorrectionsList } from './time-tracking';
import { useCorrections } from './visit-lib';

const TABS = [
  { key: 'PENDING', label: 'Pending' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'ALL', label: 'All' },
] as const;

/** TIME-07 review queue. Approvers see all in scope; engineers see their own requests. */
export function TimeCorrectionsPage() {
  const { user, hasPermission } = useAuth();
  const [sp, setSp] = useSearchParams();
  const approver = hasPermission('visit.approveCorrection');
  const status = (TABS.find((t) => t.key === sp.get('status'))?.key ?? 'PENDING') as (typeof TABS)[number]['key'];
  const page = Number(sp.get('page') ?? 1) || 1;
  const q = useCorrections({ status, page, limit: 20, mine: approver ? undefined : 'true' });
  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setSp(next, { replace: true });
  };
  return (
    <div>
      <PageHeader
        title={approver ? 'Time corrections' : 'My correction requests'}
        description={approver ? 'Approve or reject corrections to engineers’ recorded times. You cannot decide your own.' : 'Corrections you requested and their outcome.'}
      />
      <div className="mb-3 flex max-w-full gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Correction status">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === status}
            onClick={() => set({ status: t.key, page: undefined })}
            className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', t.key === status ? 'border-royal-700 text-royal-700' : 'border-transparent text-slate-600 hover:text-navy-900')}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Card>
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <div className="space-y-2 p-5">
            <div className="skeleton h-12" />
            <div className="skeleton h-12" />
          </div>
        ) : (
          <>
            <CorrectionsList corrections={q.data?.data ?? []} canApprove={approver} currentUserId={user?.id} onDecided={() => q.refetch()} showVisitLink />
            {q.data && q.data.meta.total > 0 && (
              <Pagination page={q.data.meta.page} pages={q.data.meta.pages} total={q.data.meta.total} limit={q.data.meta.limit} onPageChange={(p) => set({ page: String(p) })} />
            )}
          </>
        )}
      </Card>
    </div>
  );
}
