import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, SYSTEM_ROLES } from '@mv/shared';
import { visibleNav } from '@/app/navigation';
import { SidebarNav } from '@/app/layout/sidebar';
import { makeAuth, makeUser, Wrapper } from './utils';

const ADMIN_LINKS = ['Users', 'Roles & Permissions', 'Master Data', 'Configuration', 'Workflows', 'Audit Log'];
const perms = (key: string) => SYSTEM_ROLES.find((r) => r.key === key)!.permissions;

describe('permission-filtered navigation', () => {
  it('administrator sees every administration link', () => {
    const user = makeUser(ALL_PERMISSIONS);
    render(
      <Wrapper auth={makeAuth(user)}>
        <SidebarNav collapsed={false} />
      </Wrapper>,
    );
    for (const l of ADMIN_LINKS) expect(screen.getByRole('link', { name: l })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('engineer sees only read-only master data, no other administration links', () => {
    const user = makeUser(perms('ENGINEER'), { roles: [{ id: 'r2', key: 'ENGINEER', name: 'Field Engineer / Technician' }] });
    render(
      <Wrapper auth={makeAuth(user)}>
        <SidebarNav collapsed={false} />
      </Wrapper>,
    );
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Notifications' })).toBeInTheDocument();
    // master.read is granted so engineers can use location/asset dropdowns; the page is read-only for them.
    expect(screen.getByRole('link', { name: 'Master Data' })).toBeInTheDocument();
    for (const l of ADMIN_LINKS.filter((x) => x !== 'Master Data')) expect(screen.queryByRole('link', { name: l })).not.toBeInTheDocument();
  });

  it('a user with no permissions sees only the dashboard', () => {
    render(
      <Wrapper auth={makeAuth(makeUser([]))}>
        <SidebarNav collapsed={false} />
      </Wrapper>,
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.queryByText('Administration')).not.toBeInTheDocument();
  });

  it('supervisor can reach master data (read) but not configuration', () => {
    const p = new Set(perms('SUPERVISOR'));
    const groups = visibleNav((ps) => ps.some((x) => p.has(x)));
    const labels = groups.flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toContain('Master Data');
    expect(labels).toContain('Users');
    expect(labels).not.toContain('Configuration');
    expect(labels).not.toContain('Audit Log');
  });
});
