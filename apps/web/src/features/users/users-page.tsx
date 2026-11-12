import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus, Search, ShieldCheck } from 'lucide-react';
import type { Paged } from '@mv/shared';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { Can } from '@/features/auth/guards';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useRoles } from '@/lib/queries';
import type { UserDto } from '@/lib/types';
import { useDebounced } from '@/lib/use-debounced';
import { CreateUserDialog } from './create-user-dialog';

const STATUSES = [
  { value: 'ALL', label: 'All statuses' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'LOCKED', label: 'Locked' },
  { value: 'PENDING_ACTIVATION', label: 'Pending activation' },
];

export function UsersPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const page = Number(params.get('page') ?? 1);
  const status = params.get('status') ?? 'ALL';
  const roleId = params.get('roleId') ?? '';
  const sort = params.get('sort') ?? 'name';
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search, 300);
  const roles = useRoles();

  const update = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const list = useQuery({
    queryKey: ['users', { page, status, roleId, sort, q }],
    queryFn: async () =>
      (await api.get<Paged<UserDto>>('/users', { params: { page, limit: 20, status, roleId: roleId || undefined, sort, q: q || undefined } })).data,
    placeholderData: keepPreviousData,
  });

  const columns: Column<UserDto>[] = [
    {
      key: 'name',
      header: 'Name',
      sortKey: 'name',
      cell: (u) => (
        <div className="min-w-0">
          <p className="font-medium text-navy-900">{u.name}</p>
          <p className="truncate text-xs text-slate-500">{u.jobTitle || u.username || ''}</p>
        </div>
      ),
    },
    { key: 'email', header: 'Email', sortKey: 'email', cell: (u) => <span className="break-all">{u.email}</span> },
    {
      key: 'roles',
      header: 'Roles',
      cell: (u) => (
        <div className="flex flex-wrap gap-1">
          {(u.roles ?? []).map((r) => (
            <Badge key={r.id} tone="primary">
              {r.name}
            </Badge>
          ))}
        </div>
      ),
    },
    { key: 'org', header: 'Organization', hideOnMobile: true, cell: (u) => u.organizationName ?? '—' },
    {
      key: 'status',
      header: 'Status',
      sortKey: 'status',
      cell: (u) => (
        <div className="flex items-center gap-1.5">
          <StatusBadge status={u.status} />
          {u.mfaEnabled && <ShieldCheck className="h-4 w-4 text-teal-600" aria-label="MFA enabled" />}
        </div>
      ),
    },
    { key: 'lastLoginAt', header: 'Last sign-in', sortKey: 'lastLoginAt', hideOnMobile: true, cell: (u) => formatDateTime(u.lastLoginAt) },
  ];

  return (
    <div>
      <PageHeader
        title="Users"
        description="Manage accounts, roles and data access. Accounts are deactivated, never deleted."
        actions={
          <Can all={['user.create', 'user.administer']}>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> New user
            </Button>
          </Can>
        }
      />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-border p-3">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input
              aria-label="Search users"
              placeholder="Search name, email or username"
              className="pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                update({ q: e.target.value || undefined });
              }}
            />
          </div>
          <Select aria-label="Filter by status" className="w-auto" value={status} onChange={(e) => update({ status: e.target.value })}>
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
          <Select aria-label="Filter by role" className="w-auto" value={roleId} onChange={(e) => update({ roleId: e.target.value || undefined })}>
            <option value="">All roles</option>
            {roles.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </div>
        <DataTable
          caption="Users"
          columns={columns}
          rows={list.data?.data}
          rowKey={(u) => u.id}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => list.refetch()}
          sort={sort}
          onSortChange={(s) => update({ sort: s })}
          page={page}
          pages={list.data?.meta.pages}
          total={list.data?.meta.total}
          limit={list.data?.meta.limit}
          onPageChange={(p) => update({ page: String(p) })}
          onRowClick={(u) => navigate(`/admin/users/${u.id}`)}
          emptyTitle={q || status !== 'ALL' || roleId ? 'No users match your filters' : 'No users yet'}
        />
      </Card>
      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={(u) => navigate(`/admin/users/${u.id}`)} />
    </div>
  );
}
