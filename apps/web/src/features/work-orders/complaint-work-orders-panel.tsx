import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { ComplaintDetailDto } from '@mv/shared';
import { Card, CardHeader } from '@/components/ui/card';
import { StatusBadge, toneOf } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/states';
import { formatDateTime } from '@/lib/format';

/** Work orders raised against a complaint (staff only — customers receive an empty list). */
export function ComplaintWorkOrdersPanel({ complaint, onCreate }: { complaint: ComplaintDetailDto; onCreate?: () => void }) {
  const list = complaint.workOrders ?? [];
  const canCreate = complaint.permissions.canCreateWorkOrder;
  if (!list.length && !canCreate) return null;
  return (
    <Card>
      <CardHeader
        title="Work orders"
        description={list.length ? `${list.length} raised against this complaint` : undefined}
        actions={
          canCreate && onCreate ? (
            <Button size="sm" variant="secondary" onClick={onCreate}>
              <Plus className="h-4 w-4" /> Create work order
            </Button>
          ) : undefined
        }
      />
      {!list.length ? (
        <EmptyState title="No work orders yet" description="Create a work order to plan the field work and assign engineers." />
      ) : (
        <ul className="divide-y divide-border">
          {list.map((w) => (
            <li key={w.id} className="flex flex-wrap items-start justify-between gap-2 px-5 py-3 text-sm">
              <div className="min-w-0">
                <Link to={`/work-orders/${w.id}`} className="font-mono font-medium text-royal-700 hover:underline">
                  {w.workOrderNo}
                </Link>
                <p className="truncate text-slate-700">{w.title}</p>
                <p className="text-xs text-slate-500">
                  {w.assignees.length ? w.assignees.join(', ') : 'Unassigned'}
                  {w.plannedVisitAt ? ` · planned ${formatDateTime(w.plannedVisitAt)}` : ''}
                  {w.dueAt ? ` · due ${formatDateTime(w.dueAt)}` : ''}
                </p>
              </div>
              <StatusBadge status={w.status} label={w.statusLabel} tone={toneOf(w.statusTone)} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
