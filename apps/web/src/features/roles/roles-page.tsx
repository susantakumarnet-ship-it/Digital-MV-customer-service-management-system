import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { PermissionModuleDef } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/controls';
import { FormField, Input, Textarea } from '@/components/ui/form';
import { LoadingScreen } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState } from '@/components/states';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage, parseApiError } from '@/lib/api';
import { useRoles } from '@/lib/queries';
import type { RoleDto } from '@/lib/types';
import { cn } from '@/lib/utils';

type Draft = { id: string | null; name: string; description: string; permissions: string[] };

export function RolesPage() {
  const roles = useRoles(true);
  const catalog = useQuery({
    queryKey: ['roles', 'permissions'],
    queryFn: async () => (await api.get<PermissionModuleDef[]>('/roles/permissions')).data,
    staleTime: Infinity,
  });
  const { hasPermission } = useAuth();
  const [selected, setSelected] = useState<string | 'new' | null>(null);

  useEffect(() => {
    if (!selected && roles.data?.length) setSelected(roles.data[0]!.id);
  }, [roles.data, selected]);

  if (roles.isLoading || catalog.isLoading) return <LoadingScreen />;
  if (roles.isError || catalog.isError)
    return (
      <Card>
        <ErrorState error={roles.error ?? catalog.error} onRetry={() => (roles.refetch(), catalog.refetch())} />
      </Card>
    );

  const role = selected === 'new' ? null : roles.data?.find((r) => r.id === selected) ?? null;

  return (
    <div>
      <PageHeader
        title="Roles & permissions"
        description="Permissions are denied unless granted. You can only grant permissions you hold yourself."
        actions={
          hasPermission('role.create') && (
            <Button onClick={() => setSelected('new')}>
              <Plus className="h-4 w-4" /> New role
            </Button>
          )
        }
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <Card className="h-fit">
          <ul className="divide-y divide-border" aria-label="Roles">
            {roles.data?.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelected(r.id)}
                  className={cn('flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50', selected === r.id && 'bg-royal-50')}
                  aria-current={selected === r.id ? 'true' : undefined}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-navy-900">{r.name}</p>
                    <p className="text-xs text-slate-500">
                      {r.userCount} user{r.userCount === 1 ? '' : 's'} · {r.permissions.length} permissions
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Badge tone={r.isSystem ? 'primary' : 'accent'}>{r.isSystem ? 'System' : 'Custom'}</Badge>
                    {r.status === 'INACTIVE' && <StatusBadge status="INACTIVE" />}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        {selected ? (
          <RoleEditor
            key={selected}
            role={role}
            catalog={catalog.data ?? []}
            onSaved={(id) => setSelected(id)}
            onCancelNew={() => setSelected(roles.data?.[0]?.id ?? null)}
          />
        ) : (
          <Card>
            <EmptyState title="Select a role" />
          </Card>
        )}
      </div>
    </div>
  );
}

function RoleEditor({
  role,
  catalog,
  onSaved,
  onCancelNew,
}: {
  role: RoleDto | null;
  catalog: PermissionModuleDef[];
  onSaved: (id: string) => void;
  onCancelNew: () => void;
}) {
  const qc = useQueryClient();
  const { hasPermission, user } = useAuth();
  const isNew = !role;
  const readOnly = role?.key === 'PUBLIC_REPORTER' || (isNew ? !hasPermission('role.create') : !hasPermission('role.update'));
  const initial: Draft = useMemo(
    () => ({ id: role?.id ?? null, name: role?.name ?? '', description: role?.description ?? '', permissions: role?.permissions ?? [] }),
    [role],
  );
  const [draft, setDraft] = useState<Draft>(initial);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  useEffect(() => setDraft(initial), [initial]);

  const mine = new Set(user?.permissions ?? []);
  const dirty = JSON.stringify({ ...draft, permissions: [...draft.permissions].sort() }) !== JSON.stringify({ ...initial, permissions: [...initial.permissions].sort() });
  const has = (k: string) => draft.permissions.includes(k);
  const toggle = (k: string) =>
    setDraft((d) => ({ ...d, permissions: d.permissions.includes(k) ? d.permissions.filter((x) => x !== k) : [...d.permissions, k] }));
  const toggleModule = (m: PermissionModuleDef, on: boolean) => {
    const keys = m.actions.map((a) => `${m.module}.${a.action}`).filter((k) => mine.has(k));
    setDraft((d) => ({ ...d, permissions: on ? Array.from(new Set([...d.permissions, ...keys])) : d.permissions.filter((p) => !keys.includes(p)) }));
  };

  const save = useMutation({
    mutationFn: async (reason: string) => {
      const body = { name: draft.name.trim(), description: draft.description.trim(), permissions: draft.permissions };
      if (isNew) return (await api.post<RoleDto>('/roles', body)).data;
      const patch: Record<string, unknown> = { permissions: body.permissions, description: body.description, reason: reason || undefined };
      if (!role!.isSystem) patch.name = body.name;
      return (await api.patch<RoleDto>(`/roles/${role!.id}`, patch)).data;
    },
    onSuccess: (r) => {
      toast.success(isNew ? 'Role created' : 'Role saved');
      qc.invalidateQueries({ queryKey: ['roles'] });
      onSaved(r.id);
    },
    onError: (err) => {
      const e = parseApiError(err);
      if (e.fields?.name) setNameError(e.fields.name);
      toast.error(e.message);
    },
  });

  const submit = () => {
    if (draft.name.trim().length < 2) {
      setNameError('Role name is required');
      return;
    }
    setNameError(null);
    if (isNew) save.mutate('');
    else setSaveOpen(true);
  };

  return (
    <Card>
      <CardHeader
        title={isNew ? 'New role' : role!.name}
        description={
          role?.key === 'PUBLIC_REPORTER'
            ? 'Represents unauthenticated public access. It cannot be edited or assigned.'
            : role?.isSystem
              ? 'System role: the name is fixed; permissions can be adjusted.'
              : undefined
        }
        actions={
          !isNew &&
          !role!.isSystem &&
          hasPermission('role.update') && (
            <Button variant={role!.status === 'ACTIVE' ? 'outline' : 'accent'} size="sm" onClick={() => setStatusOpen(true)}>
              {role!.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
            </Button>
          )
        }
      />
      <CardBody className="space-y-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FormField label="Role name" error={nameError ?? undefined} required>
            {(p) => (
              <Input {...p} value={draft.name} disabled={readOnly || Boolean(role?.isSystem)} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            )}
          </FormField>
          <FormField label="Description">
            {(p) => <Textarea {...p} rows={2} value={draft.description} disabled={readOnly} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />}
          </FormField>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-navy-900">Permissions</h3>
            <span className="text-xs text-slate-500">{draft.permissions.length} selected</span>
          </div>
          <div className="divide-y divide-border rounded-lg border border-border">
            {catalog.map((m) => {
              const keys = m.actions.map((a) => `${m.module}.${a.action}`);
              const count = keys.filter(has).length;
              const all = count === keys.length;
              return (
                <div key={m.module} className="p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2 text-sm font-medium text-navy-900">
                      <Checkbox
                        checked={all ? true : count ? 'indeterminate' : false}
                        disabled={readOnly}
                        onCheckedChange={() => toggleModule(m, !all)}
                        aria-label={`All ${m.label} permissions`}
                      />
                      {m.label}
                    </label>
                    <Badge tone={m.phase <= 2 ? 'success' : 'neutral'}>Phase {m.phase}</Badge>
                  </div>
                  <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1.5 pl-6 sm:grid-cols-2 xl:grid-cols-3">
                    {m.actions.map((a) => {
                      const k = `${m.module}.${a.action}`;
                      const cannot = !mine.has(k);
                      return (
                        <label key={k} className={cn('flex items-start gap-2 text-sm', cannot && 'text-slate-400')} title={k}>
                          <Checkbox className="mt-0.5" checked={has(k)} disabled={readOnly || cannot} onCheckedChange={() => toggle(k)} />
                          <span>
                            {a.label}
                            {cannot && <Lock className="ml-1 inline h-3 w-3" aria-label="You do not hold this permission" />}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={submit} loading={save.isPending} disabled={!isNew && !dirty}>
              {isNew ? 'Create role' : 'Save changes'}
            </Button>
            {isNew ? (
              <Button variant="outline" onClick={onCancelNew}>
                Cancel
              </Button>
            ) : (
              dirty && (
                <Button variant="outline" onClick={() => setDraft(initial)}>
                  Discard
                </Button>
              )
            )}
          </div>
        )}
      </CardBody>

      <ConfirmDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        title={`Save changes to ${role?.name ?? 'role'}?`}
        description={`This affects ${role?.userCount ?? 0} user(s) immediately.`}
        confirmLabel="Save"
        reason="optional"
        reasonLabel="Reason for change (recorded in the audit log)"
        onConfirm={(reason) => save.mutateAsync(reason)}
      />
      {role && (
        <ConfirmDialog
          open={statusOpen}
          onOpenChange={setStatusOpen}
          title={role.status === 'ACTIVE' ? `Deactivate ${role.name}?` : `Activate ${role.name}?`}
          description={role.status === 'ACTIVE' ? 'A role can only be deactivated when no active users hold it.' : undefined}
          tone={role.status === 'ACTIVE' ? 'danger' : 'primary'}
          confirmLabel={role.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
          reason={role.status === 'ACTIVE' ? 'required' : undefined}
          onConfirm={async (reason) => {
            try {
              await api.post(`/roles/${role.id}/${role.status === 'ACTIVE' ? 'deactivate' : 'activate'}`, role.status === 'ACTIVE' ? { reason } : undefined);
              toast.success(role.status === 'ACTIVE' ? 'Role deactivated' : 'Role activated');
              qc.invalidateQueries({ queryKey: ['roles'] });
            } catch (err) {
              toast.error(errorMessage(err));
              throw err;
            }
          }}
        />
      )}
    </Card>
  );
}
