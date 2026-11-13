import { Link } from 'react-router-dom';
import { AlertTriangle, ClipboardCheck, HelpCircle, Package, PackageCheck, PackageOpen, Truck } from 'lucide-react';
import type { MaterialRequestSummaryDto, StockBalanceDto } from '@mv/shared';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge, StatusBadge, toneOf } from '@/components/ui/badge';
import { KpiCard } from '@/components/kpi-card';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState } from '@/components/states';
import { useAuth } from '@/features/auth/auth-context';
import { timeAgo } from '@/lib/format';
import { formatQty, OPEN_MATERIAL_STATUSES, sortForStore, urgencyLabel, urgencyTone, useBalances, useMaterialRequests, useMaterialSummary, type MaterialSummary } from './material-lib';

type KpiKey = keyof MaterialSummary;
const KPI_DEFS: Record<KpiKey, { label: string; icon: JSX.Element; accent: 'navy' | 'royal' | 'teal' | 'amber' | 'red' | 'slate'; to: string }> = {
  pendingApproval: { label: 'Pending approval', icon: <ClipboardCheck className="h-5 w-5" />, accent: 'amber', to: '/materials?tab=pending' },
  clarification: { label: 'Awaiting clarification', icon: <HelpCircle className="h-5 w-5" />, accent: 'slate', to: '/materials?tab=clarification' },
  readyToIssue: { label: 'Ready to issue', icon: <PackageOpen className="h-5 w-5" />, accent: 'royal', to: '/materials?tab=approved' },
  partiallyIssued: { label: 'Partially issued', icon: <Truck className="h-5 w-5" />, accent: 'teal', to: '/materials?tab=partial' },
  issued: { label: 'Issued', icon: <PackageCheck className="h-5 w-5" />, accent: 'teal', to: '/materials?tab=issued' },
  criticalOpen: { label: 'Critical open', icon: <AlertTriangle className="h-5 w-5" />, accent: 'red', to: '/materials' },
  total: { label: 'All requests', icon: <Package className="h-5 w-5" />, accent: 'navy', to: '/materials?tab=all' },
};

/** Material KPI tiles from GET /material-requests/summary (scoped server-side). */
export function MaterialKpiGrid({ keys }: { keys: KpiKey[] }) {
  const q = useMaterialSummary();
  if (q.isError)
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {keys.map((k) => {
        const d = KPI_DEFS[k];
        const v = q.data?.[k] ?? 0;
        return (
          <Link key={k} to={d.to} className="rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-royal-600">
            <KpiCard label={d.label} value={v} icon={d.icon} accent={k === 'criticalOpen' && !v ? 'slate' : d.accent} loading={q.isLoading} />
          </Link>
        );
      })}
    </div>
  );
}

function MiniList({ title, description, q, empty, more, sort }: { title: string; description?: string; q: ReturnType<typeof useMaterialRequests>; empty: string; more: string; sort?: boolean }) {
  const rows = q.data ? (sort ? sortForStore(q.data.data) : q.data.data) : [];
  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        actions={
          <Link to={more} className="text-sm font-medium text-royal-700 hover:underline">
            View all
          </Link>
        }
      />
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <div className="space-y-2 p-5">
          <div className="skeleton h-5" />
          <div className="skeleton h-5" />
        </div>
      ) : !rows.length ? (
        <EmptyState title={empty} />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r: MaterialRequestSummaryDto) => (
            <li key={r.id}>
              <Link to={`/materials/${r.id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm hover:bg-slate-50">
                <span className="min-w-0">
                  <span className="font-mono font-medium text-royal-700">{r.requestNo}</span>
                  <span className="ml-2 font-mono text-xs text-slate-500">{r.workOrder.workOrderNo}</span>
                  <span className="block text-xs text-slate-500">
                    {r.requester.name} · {r.lineCount} item{r.lineCount === 1 ? '' : 's'}
                    {r.site ? ` · ${r.site.name}` : ''} · {timeAgo(r.submittedAt ?? r.createdAt)}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  {r.urgency !== 'NORMAL' && <Badge tone={urgencyTone(r.urgency)}>{urgencyLabel(r.urgency)}</Badge>}
                  <StatusBadge status={r.status} label={r.statusLabel} tone={toneOf(r.statusTone)} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Supervisor: material requests waiting for my decision (MAT-02). */
export function PendingMaterialApprovalsCard() {
  const { hasPermission } = useAuth();
  const enabled = hasPermission('material.approve');
  const q = useMaterialRequests({ status: 'SUBMITTED', limit: 6, sort: 'submittedAt' }, enabled);
  if (!enabled) return null;
  return <MiniList title="Material requests awaiting approval" description="Oldest first" q={q} empty="No requests awaiting approval" more="/materials?tab=pending" />;
}

/** Engineer: my open material requests. */
export function MyMaterialRequestsCard() {
  const { hasPermission } = useAuth();
  const enabled = hasPermission('material.read');
  const q = useMaterialRequests({ mine: 'true', status: OPEN_MATERIAL_STATUSES, limit: 6, sort: '-createdAt' }, enabled);
  if (!enabled) return null;
  return <MiniList title="My material requests" description="Open requests you raised" q={q} empty="No open material requests" more="/materials" />;
}

function LowStockCard() {
  const q = useBalances({ lowStock: 'true', limit: 8 });
  return (
    <Card>
      <CardHeader
        title="Low stock"
        description="At or below the reorder level"
        actions={
          <Link to="/inventory?lowStock=true" className="text-sm font-medium text-royal-700 hover:underline">
            View all
          </Link>
        }
      />
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <div className="space-y-2 p-5">
          <div className="skeleton h-5" />
        </div>
      ) : !q.data?.data.length ? (
        <EmptyState title="Nothing is low on stock" />
      ) : (
        <ul className="divide-y divide-border text-sm">
          {q.data.data.map((b: StockBalanceDto) => (
            <li key={`${b.item.id}:${b.warehouse.id}`} className="flex items-center justify-between gap-2 px-5 py-2.5">
              <span className="min-w-0">
                <span className="font-medium text-navy-900">{b.item.name}</span>
                <span className="block text-xs text-slate-500">{b.warehouse.name}</span>
              </span>
              <span className="text-right">
                <span className="tabular-nums text-red-700">{formatQty(b.available, b.item.unit)}</span>
                {b.item.reorderLevel != null && <span className="block text-xs text-slate-500">reorder at {formatQty(b.item.reorderLevel)}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Storekeeper dashboard: queue to issue, KPIs, low stock. */
export function StoreDashboard() {
  const { hasPermission } = useAuth();
  const q = useMaterialRequests({ store: 'true', limit: 8, sort: 'submittedAt' }, hasPermission('inventory.issue'));
  return (
    <div className="space-y-4">
      <PageHeader title="Store dashboard" description="Issue and receive material against approved requests — critical first." />
      <MaterialKpiGrid keys={['readyToIssue', 'partiallyIssued', 'criticalOpen', 'issued']} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {hasPermission('inventory.issue') && <MiniList title="Waiting to issue" description="Approved requests by urgency" q={q} empty="Nothing to issue" more="/store" sort />}
        {hasPermission('inventory.read') && <LowStockCard />}
      </div>
    </div>
  );
}
