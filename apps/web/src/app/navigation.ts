import type { LucideIcon } from 'lucide-react';
import { Bell, CalendarRange, ClipboardList, Database, Wrench, FileClock, GitBranch, LayoutDashboard, Settings2, ShieldCheck, Users } from 'lucide-react';
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
  new: 'New',
};
