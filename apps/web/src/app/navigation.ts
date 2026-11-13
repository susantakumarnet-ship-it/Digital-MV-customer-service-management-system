import type { LucideIcon } from 'lucide-react';
import { Bell, Boxes, SearchCheck, CalendarRange, ClipboardCheck, ClipboardList, Database, Wrench, FileClock, GitBranch, History, LayoutDashboard, ListChecks, MapPinned, Settings2, ShieldCheck, Users } from 'lucide-react';
import type { PermissionKey } from '@mv/shared';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Visible when the user holds ANY of these (empty = any authenticated user). */
  anyOf?: PermissionKey[];
  end?: boolean;
  /** Label shown to field engineers (workOrder.accept without workOrder.assign). */
  engineerLabel?: string;
  /** Live count badge (e.g. pending time corrections). */
  badge?: 'pendingCorrections' | 'pendingReviews';
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/complaints', label: 'Complaints', icon: ClipboardList, anyOf: ['complaint.read'] },
      { to: '/work-orders', label: 'Work orders', icon: Wrench, anyOf: ['workOrder.read'], engineerLabel: 'My work orders' },
      { to: '/work-orders/board', label: 'Assignment board', icon: CalendarRange, anyOf: ['workOrder.assign'] },
      { to: '/visits', label: 'Visits', icon: MapPinned, anyOf: ['visit.read'], engineerLabel: 'My visits' },
      { to: '/inspection-reports', label: 'Inspection reports', icon: ClipboardCheck, anyOf: ['inspection.read'] },
      { to: '/reviews', label: 'Reviews', icon: SearchCheck, anyOf: ['inspection.approve', 'inspection.return'], badge: 'pendingReviews' },
      { to: '/time-corrections', label: 'Time corrections', icon: History, anyOf: ['visit.approveCorrection'], badge: 'pendingCorrections' },
      { to: '/inspections/temporary-assets', label: 'Temporary assets', icon: Boxes, anyOf: ['inspection.reviewTempAsset'] },
      { to: '/notifications', label: 'Notifications', icon: Bell, anyOf: ['notification.read'] },
    ],
  },
  {
    label: 'Administration',
    items: [
      { to: '/admin/users', label: 'Users', icon: Users, anyOf: ['user.read'] },
      { to: '/admin/roles', label: 'Roles & Permissions', icon: ShieldCheck, anyOf: ['role.read'] },
      { to: '/admin/masters', label: 'Master Data', icon: Database, anyOf: ['master.read'] },
      { to: '/admin/settings', label: 'Configuration', icon: Settings2, anyOf: ['settings.read'] },
      { to: '/admin/checklists', label: 'Checklist templates', icon: ListChecks, anyOf: ['inspection.manageTemplates'] },
      { to: '/admin/workflows', label: 'Workflows', icon: GitBranch, anyOf: ['workflow.read'] },
      { to: '/admin/audit', label: 'Audit Log', icon: FileClock, anyOf: ['audit.read'] },
    ],
  },
];

/** Groups with items filtered by permission; empty groups removed. */
export function visibleNav(hasAny: (ps: PermissionKey[]) => boolean): NavGroup[] {
  const engineer = hasAny(['workOrder.accept']) && !hasAny(['workOrder.assign']);
  return NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items
      .filter((i) => !i.anyOf?.length || hasAny(i.anyOf))
      .map((i) => (engineer && i.engineerLabel ? { ...i, label: i.engineerLabel } : i)),
  })).filter(
    (g) => g.items.length > 0,
  );
}

/** Static breadcrumb labels by path segment. */
export const SEGMENT_LABELS: Record<string, string> = {
  admin: 'Administration',
  users: 'Users',
  roles: 'Roles & Permissions',
  masters: 'Master Data',
  settings: 'Configuration',
  workflows: 'Workflows',
  audit: 'Audit Log',
  profile: 'Profile & Security',
  notifications: 'Notifications',
  complaints: 'Complaints',
  'work-orders': 'Work orders',
  board: 'Assignment board',
  visits: 'Visits',
  'inspection-reports': 'Inspection reports',
  'time-corrections': 'Time corrections',
  inspections: 'Inspections',
  'temporary-assets': 'Temporary assets',
  checklists: 'Checklist templates',
  reviews: 'Reviews',
  compare: 'Compare revisions',
  new: 'New',
};
