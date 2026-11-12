import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bell, CalendarClock, Globe2, MapPin } from 'lucide-react';
import type { Paged, PermissionKey } from '@mv/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState } from '@/components/states';
import { useAuth } from '@/features/auth/auth-context';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useMasterOptions } from '@/lib/queries';
import type { NotificationDto } from '@/lib/types';
import { AdminDashboard } from './admin-dashboard';

interface RoleDashboardDef {
  permission: PermissionKey;
  title: string;
  intro: string;
  upcoming: { label: string; phase: number }[];
}

/** Honest Phase 2 role dashboards: what exists today, and when each widget arrives. */
const ROLE_DASHBOARDS: RoleDashboardDef[] = [
  {
    permission: 'dashboard.supervisor',
    title: 'Supervisor dashboard',
    intro: 'Review incoming complaints, create work orders and keep field work on schedule.',
    upcoming: [
      { label: 'Complaint review queue and duplicate detection', phase: 3 },
      { label: 'Work-order assignment board (list and calendar)', phase: 4 },
      { label: 'Engineer workload and overdue work', phase: 4 },
      { label: 'Pending material requests for approval', phase: 7 },
      { label: 'Open NCRs and customer acceptance', phase: 8 },
    ],
  },
  {
    permission: 'dashboard.engineer',
    title: 'My work',
    intro: 'Your assigned jobs, visits, time tracking and inspection reports.',
    upcoming: [
      { label: "Assigned work orders, today's and upcoming visits", phase: 4 },
      { label: 'Six-step time tracking and site inspections', phase: 5 },
      { label: 'Returned reports awaiting correction', phase: 6 },
      { label: 'Material requests', phase: 7 },
    ],
  },
  {
    permission: 'dashboard.reviewer',
    title: 'Reviewer dashboard',
    intro: 'Review submitted inspection reports, time logs and NCR verifications.',
    upcoming: [
      { label: 'Reports awaiting review and revision comparison', phase: 6 },
      { label: 'Time-correction approvals', phase: 5 },
      { label: 'NCRs submitted for verification', phase: 8 },
    ],
  },
  {
    permission: 'dashboard.storekeeper',
    title: 'Store dashboard',
    intro: 'Issue and receive material against approved requests.',
    upcoming: [
      { label: 'Approved requests awaiting issue', phase: 7 },
      { label: 'Stock levels, reorder warnings and ledger', phase: 7 },
    ],
  },
  {
    permission: 'dashboard.management',
    title: 'Management dashboard',
    intro: 'Read-only view of service performance across your regions.',
    upcoming: [
      { label: 'Complaint volumes, SLA and ageing', phase: 9 },
      { label: 'Resolution time, first-time-fix and repeat complaints', phase: 9 },
      { label: 'Engineer utilisation and exports', phase: 9 },
    ],
  },
  {
    permission: 'dashboard.customer',
    title: 'Customer portal',
    intro: "Track your organisation's service requests and confirm completed work.",
    upcoming: [
      { label: "Your organisation's complaints and their status", phase: 3 },
      { label: 'Requests for additional information', phase: 3 },
      { label: 'Service acceptance and feedback', phase: 8 },
    ],
  },
];

export function DashboardPage() {
  const { hasPermission } = useAuth();
  if (hasPermission('dashboard.admin')) return <AdminDashboard />;
  const def = ROLE_DASHBOARDS.find((d) => hasPermission(d.permission));
  return <RoleDashboard def={def} />;
}

function RoleDashboard({ def }: { def?: RoleDashboardDef }) {
  const { user, hasPermission } = useAuth();
  const notes = useQuery({
    queryKey: ['notifications', 'dashboard-unread'],
    queryFn: async () => (await api.get<Paged<NotificationDto>>('/notifications', { params: { limit: 5, unread: 'true' } })).data,
    enabled: hasPermission('notification.read'),
  });
  if (!user) return null;
  const first = user.name.split(' ')[0];

  return (
    <div>
      <PageHeader title={def?.title ?? 'Dashboard'} description={def?.intro} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title={`Welcome, ${first}`} description="Your access in this system" />
          <CardBody className="space-y-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Roles</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {user.roles.map((r) => (
                  <Badge key={r.id} tone="primary">
                    {r.name}
                  </Badge>
                ))}
              </div>
            </div>
            <ScopeSummary />
            {def && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Coming to this dashboard</p>
                <ul className="mt-2 space-y-2">
                  {def.upcoming.map((u) => (
                    <li key={u.label} className="flex items-start gap-2 text-sm text-slate-700">
                      <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" aria-hidden />
                      <span className="flex-1">{u.label}</span>
                      <Badge tone="neutral">Phase {u.phase}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Unread notifications"
            actions={
              <Link to="/notifications" className="text-sm font-medium text-royal-700 hover:underline">
                View all
              </Link>
            }
          />
          {notes.isError ? (
            <ErrorState error={notes.error} onRetry={() => notes.refetch()} />
          ) : notes.isLoading ? (
            <div className="space-y-3 p-5">
              <div className="skeleton h-4" />
              <div className="skeleton h-4" />
            </div>
          ) : !notes.data?.data.length ? (
            <EmptyState icon={<Bell className="h-6 w-6" />} title="You're all caught up" />
          ) : (
            <ul className="divide-y divide-border">
              {notes.data.data.map((n) => (
                <li key={n.id} className="px-5 py-3 text-sm">
                  <p className="font-medium text-navy-900">{n.title}</p>
                  {n.body && <p className="text-slate-500">{n.body}</p>}
                  <p className="mt-0.5 text-xs text-slate-400">{timeAgo(n.createdAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function ScopeSummary() {
  const { user, hasPermission } = useAuth();
  const canRead = hasPermission('master.read');
  const orgs = useMasterOptions('organizations', { enabled: canRead && !user?.scope.global, includeInactive: true });
  const regions = useMasterOptions('regions', { enabled: canRead && !user?.scope.global, includeInactive: true });
  const sites = useMasterOptions('sites', { enabled: canRead && !user?.scope.global, includeInactive: true });
  if (!user) return null;
  const s = user.scope;
  const names = (ids: string[], opts?: { id: string; label: string }[]) =>
    ids.map((id) => opts?.find((o) => o.id === id)?.label ?? (canRead ? '…' : 'Restricted'));

  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Data access</p>
      {s.global ? (
        <p className="mt-1 flex items-center gap-2 text-sm text-slate-700">
          <Globe2 className="h-4 w-4 text-teal-600" aria-hidden /> All organisations, regions and sites
        </p>
      ) : !s.organizationIds.length && !s.regionIds.length && !s.siteIds.length ? (
        <p className="mt-1 text-sm text-slate-600">
          Records you are personally assigned to. No organisation, region or site access has been granted.
        </p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm text-slate-700">
          {s.organizationIds.length > 0 && <li>Organisations: {names(s.organizationIds, orgs.data).join(', ')}</li>}
          {s.regionIds.length > 0 && <li>Regions: {names(s.regionIds, regions.data).join(', ')}</li>}
          {s.siteIds.length > 0 && (
            <li className="flex gap-1">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden /> Sites: {names(s.siteIds, sites.data).join(', ')}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
