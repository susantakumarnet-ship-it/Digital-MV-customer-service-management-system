import { Link } from 'react-router-dom';
import { CalendarClock, Plus } from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/page-header';
import { ErrorState } from '@/components/states';
import { useAuth } from '@/features/auth/auth-context';
import { useComplaintSummary } from '@/features/complaints/complaint-lib';
import { ComplaintCharts, ComplaintKpiGrid, ComplaintMiniList } from './complaint-widgets';
import { useWorkOrderSummary } from '@/features/work-orders/wo-lib';
import { TeamWorkloadCard, WorkOrderCharts, WorkOrderKpiGrid } from './work-order-widgets';

function Upcoming({ items }: { items: { label: string; phase: number }[] }) {
  return (
    <Card>
      <CardHeader title="Coming to this dashboard" />
      <ul className="space-y-2 px-5 py-4">
        {items.map((u) => (
          <li key={u.label} className="flex items-start gap-2 text-sm text-slate-700">
            <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" aria-hidden />
            <span className="flex-1">{u.label}</span>
            <Badge tone="neutral">Phase {u.phase}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function SupervisorDashboard() {
  const s = useComplaintSummary();
  const { hasPermission } = useAuth();
  const wo = useWorkOrderSummary(hasPermission('workOrder.read'));
  return (
    <div className="space-y-4">
      <PageHeader title="Supervisor dashboard" description="Review incoming complaints, classify them and keep work on schedule." />
      {s.isError ? (
        <Card>
          <ErrorState error={s.error} onRetry={() => s.refetch()} />
        </Card>
      ) : (
        <ComplaintKpiGrid data={s.data} loading={s.isLoading} keys={['new', 'unclassified', 'underReview', 'awaitingCustomer', 'overdue', 'open']} />
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ComplaintMiniList
          title="Review queue"
          description="New, reopened and under-review complaints — oldest first"
          params={{ status: 'NEW,UNDER_REVIEW,REOPENED', sort: 'receivedAt' }}
          emptyTitle="Nothing waiting for review"
          viewAllLink="/complaints?tab=review"
        />
        <ComplaintMiniList
          title="Overdue complaints"
          description="Past their SLA due date and not yet resolved"
          params={{ overdue: 'true', sort: 'dueAt' }}
          emptyTitle="No overdue complaints"
          viewAllLink="/complaints?tab=overdue"
        />
      </div>
      {hasPermission('workOrder.read') && (
        <section className="space-y-4" aria-labelledby="wo-heading">
          <h2 id="wo-heading" className="text-base font-semibold text-navy-900">
            Work orders
          </h2>
          {wo.isError ? (
            <Card>
              <ErrorState error={wo.error} onRetry={() => wo.refetch()} />
            </Card>
          ) : (
            <WorkOrderKpiGrid data={wo.data} loading={wo.isLoading} keys={['open', 'unassigned', 'awaitingAcceptance', 'inProgress', 'overdue']} />
          )}
          {hasPermission('workOrder.assign') && <TeamWorkloadCard />}
        </section>
      )}
      <Upcoming
        items={[
          { label: 'Pending material requests for approval', phase: 7 },
          { label: 'Open NCRs and customer acceptance', phase: 8 },
        ]}
      />
    </div>
  );
}

export function CustomerDashboard() {
  const { hasPermission } = useAuth();
  return (
    <div className="space-y-4">
      <PageHeader
        title="Customer portal"
        description="Track your organisation's service requests."
        actions={
          hasPermission('complaint.create') ? (
            <Link to="/complaints/new" className={buttonVariants({ variant: 'primary' })}>
              <Plus className="h-4 w-4" /> Report a new complaint
            </Link>
          ) : undefined
        }
      />
      <ComplaintMiniList
        title="Waiting for your information"
        description="Our team needs more details before continuing"
        params={{ status: 'AWAITING_CUSTOMER_INFO', sort: 'receivedAt' }}
        emptyTitle="Nothing needs your attention"
        viewAllLink="/complaints?tab=awaiting"
        highlightAwaiting
      />
      <ComplaintMiniList
        title="Your organisation's open complaints"
        params={{ status: 'OPEN' }}
        emptyTitle="No open complaints"
        viewAllLink="/complaints?tab=open"
        highlightAwaiting
      />
      <Upcoming items={[{ label: 'Service acceptance and feedback', phase: 8 }]} />
    </div>
  );
}

export function ManagementDashboard() {
  const s = useComplaintSummary();
  const { hasPermission } = useAuth();
  const wo = useWorkOrderSummary(hasPermission('workOrder.read'));
  return (
    <div className="space-y-4">
      <PageHeader title="Management dashboard" description="Read-only view of complaint volumes and status across your regions." />
      {s.isError ? (
        <Card>
          <ErrorState error={s.error} onRetry={() => s.refetch()} />
        </Card>
      ) : (
        <>
          <ComplaintKpiGrid data={s.data} loading={s.isLoading} keys={['total', 'receivedToday', 'open', 'new', 'awaitingCustomer', 'overdue']} />
          <ComplaintCharts data={s.data} loading={s.isLoading} />
        </>
      )}
      {hasPermission('workOrder.read') &&
        (wo.isError ? (
          <Card>
            <ErrorState error={wo.error} onRetry={() => wo.refetch()} />
          </Card>
        ) : (
          <>
            <WorkOrderKpiGrid data={wo.data} loading={wo.isLoading} keys={['open', 'awaitingAcceptance', 'inProgress', 'overdue', 'total']} />
            <WorkOrderCharts data={wo.data} loading={wo.isLoading} />
          </>
        ))}
      <Upcoming
        items={[
          { label: 'SLA, ageing, resolution time, first-time-fix and repeat complaints', phase: 9 },
          { label: 'Engineer utilisation and report exports', phase: 9 },
        ]}
      />
    </div>
  );
}
