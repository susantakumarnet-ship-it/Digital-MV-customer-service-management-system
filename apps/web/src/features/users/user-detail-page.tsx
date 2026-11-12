import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { KeyRound, LogOut, Power, ShieldOff, Unlock } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { userUpdateSchema, type Paged, type UserScope } from '@mv/shared';
import { useBreadcrumb } from '@/app/breadcrumbs';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/controls';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FormField, Input, Select } from '@/components/ui/form';
import { LoadingScreen } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { MultiSelect } from '@/components/multi-select';
import { PageHeader } from '@/components/page-header';
import { ErrorState } from '@/components/states';
import { useAuth } from '@/features/auth/auth-context';
import { Can } from '@/features/auth/guards';
import { api, applyFieldErrors, errorMessage } from '@/lib/api';
import { describeUserAgent, formatDateTime } from '@/lib/format';
import { useMasterOptions, useRoles } from '@/lib/queries';
import type { ActivityRow, UserDto } from '@/lib/types';
import { humanize } from '@/lib/utils';
import { ScopeEditor } from './scope-editor';

type Action = 'deactivate' | 'activate' | 'unlock' | 'mfa' | 'sessions' | null;

export function UserDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const q = useQuery({ queryKey: ['users', id], queryFn: async () => (await api.get<UserDto>(`/users/${id}`)).data });
  const [action, setAction] = useState<Action>(null);
  const [resetOpen, setResetOpen] = useState(false);
  useBreadcrumb(q.data?.name);

  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  };

  if (q.isLoading) return <LoadingScreen />;
  if (q.isError || !q.data)
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
        <div className="pb-6 text-center">
          <Button variant="link" onClick={() => navigate('/admin/users')}>
            Back to users
          </Button>
        </div>
      </Card>
    );

  const u = q.data;
  const isSelf = me?.id === u.id;
  const isCustomer = (u.roles ?? []).some((r) => r.key === 'CUSTOMER');

  return (
    <div>
      <PageHeader
        title={u.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="break-all">{u.email}</span>
            <StatusBadge status={u.status} />
            {u.mfaEnabled ? <Badge tone="accent">MFA on</Badge> : <Badge tone="neutral">MFA off</Badge>}
          </span>
        }
        actions={
          <Can all={['user.administer']}>
            {u.status === 'LOCKED' && (
              <Button variant="outline" size="sm" onClick={() => setAction('unlock')}>
                <Unlock className="h-4 w-4" /> Unlock
              </Button>
            )}
            {u.status !== 'INACTIVE' && (
              <Button variant="outline" size="sm" onClick={() => setResetOpen(true)}>
                <KeyRound className="h-4 w-4" /> Reset password
              </Button>
            )}
            {u.mfaEnabled && (
              <Button variant="outline" size="sm" onClick={() => setAction('mfa')}>
                <ShieldOff className="h-4 w-4" /> Reset MFA
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setAction('sessions')}>
              <LogOut className="h-4 w-4" /> Sign out everywhere
            </Button>
            {u.status === 'INACTIVE' ? (
              <Button variant="accent" size="sm" onClick={() => setAction('activate')}>
                <Power className="h-4 w-4" /> Activate
              </Button>
            ) : (
              !isSelf && (
                <Button variant="danger" size="sm" onClick={() => setAction('deactivate')}>
                  <Power className="h-4 w-4" /> Deactivate
                </Button>
              )
            )}
          </Can>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <ProfileCard user={u} />
          <RolesCard user={u} />
          {!isCustomer && <ScopeCard user={u} />}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Account" />
            <CardBody>
              <dl className="space-y-2 text-sm">
                <Row label="Last sign-in" value={formatDateTime(u.lastLoginAt)} />
                <Row label="Active sessions" value={String(u.activeSessions ?? 0)} />
                <Row label="Must change password" value={u.mustChangePassword ? 'Yes' : 'No'} />
                {u.lockedUntil && <Row label="Locked until" value={formatDateTime(u.lockedUntil)} />}
                {u.deactivationReason && u.status === 'INACTIVE' && <Row label="Deactivation reason" value={u.deactivationReason} />}
                <Row label="Created" value={formatDateTime(u.createdAt)} />
                <Row label="Updated" value={formatDateTime(u.updatedAt)} />
              </dl>
            </CardBody>
          </Card>
        </div>
      </div>

      <Can all={['user.read', 'audit.read']}>
        <LoginActivity userId={u.id} />
      </Can>

      <ConfirmDialog
        open={action === 'deactivate'}
        onOpenChange={(o) => !o && setAction(null)}
        title={`Deactivate ${u.name}?`}
        description="The user will be signed out of all sessions immediately and will not be able to sign in. Their history is retained."
        confirmLabel="Deactivate"
        tone="danger"
        reason="required"
        onConfirm={(reason) => run(() => api.post(`/users/${u.id}/deactivate`, { reason }), 'User deactivated')}
      />
      <ConfirmDialog
        open={action === 'activate'}
        onOpenChange={(o) => !o && setAction(null)}
        title={`Activate ${u.name}?`}
        description="The user will be able to sign in again."
        confirmLabel="Activate"
        reason="optional"
        onConfirm={(reason) => run(() => api.post(`/users/${u.id}/activate`, { reason: reason || undefined }), 'User activated')}
      />
      <ConfirmDialog
        open={action === 'unlock'}
        onOpenChange={(o) => !o && setAction(null)}
        title="Clear sign-in lockout?"
        confirmLabel="Unlock"
        onConfirm={() => run(() => api.post(`/users/${u.id}/unlock`), 'Account unlocked')}
      />
      <ConfirmDialog
        open={action === 'mfa'}
        onOpenChange={(o) => !o && setAction(null)}
        title="Reset two-step verification?"
        description="Use this when the user has lost their device. Their MFA enrolment is removed and all sessions are signed out."
        confirmLabel="Reset MFA"
        tone="danger"
        reason="required"
        onConfirm={(reason) => run(() => api.post(`/users/${u.id}/mfa/reset`, { reason }), 'MFA reset')}
      />
      <ConfirmDialog
        open={action === 'sessions'}
        onOpenChange={(o) => !o && setAction(null)}
        title="Sign this user out everywhere?"
        description={isSelf ? 'This includes your current session.' : 'All of the user’s active sessions will end.'}
        confirmLabel="Sign out all sessions"
        tone="danger"
        onConfirm={() => run(() => api.post(`/users/${u.id}/sessions/revoke`), 'All sessions revoked')}
      />
      <ResetPasswordDialog user={u} open={resetOpen} onOpenChange={setResetOpen} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right text-navy-900">{value}</dd>
    </div>
  );
}

type ProfileValues = z.input<typeof userUpdateSchema>;
const profileValues = (u: UserDto): ProfileValues => ({
  name: u.name,
  email: u.email,
  username: u.username ?? '',
  phone: u.phone ?? '',
  jobTitle: u.jobTitle ?? '',
  organizationId: u.organizationId,
});

function ProfileCard({ user }: { user: UserDto }) {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('user.update');
  const orgs = useMasterOptions('organizations', { includeInactive: true });
  const form = useForm<ProfileValues, unknown, z.output<typeof userUpdateSchema>>({ resolver: zodResolver(userUpdateSchema) });
  useEffect(() => form.reset(profileValues(user)), [user, form]);
  const values = profileValues;

  const save = useMutation({
    mutationFn: async (v: z.output<typeof userUpdateSchema>) => (await api.patch<UserDto>(`/users/${user.id}`, v)).data,
    onSuccess: () => {
      toast.success('Profile saved');
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => {
      if (!applyFieldErrors(err, form.setError)) toast.error(errorMessage(err));
    },
  });
  const e = form.formState.errors;
  return (
    <Card>
      <CardHeader title="Profile" />
      <CardBody>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <fieldset disabled={!canEdit} className="contents">
            <FormField label="Full name" error={e.name?.message} required>
              {(p) => <Input {...p} {...form.register('name')} />}
            </FormField>
            <FormField label="Email" error={e.email?.message} required>
              {(p) => <Input {...p} type="email" {...form.register('email')} />}
            </FormField>
            <FormField label="Username" error={e.username?.message}>
              {(p) => <Input {...p} {...form.register('username')} />}
            </FormField>
            <FormField label="Phone" error={e.phone?.message}>
              {(p) => <Input {...p} type="tel" {...form.register('phone')} />}
            </FormField>
            <FormField label="Job title" error={e.jobTitle?.message}>
              {(p) => <Input {...p} {...form.register('jobTitle')} />}
            </FormField>
            <FormField label="Organization" error={e.organizationId?.message}>
              {(p) => (
                <Select
                  {...p}
                  value={form.watch('organizationId') ?? ''}
                  onChange={(ev) => form.setValue('organizationId', ev.target.value || null, { shouldDirty: true })}
                >
                  <option value="">— None —</option>
                  {orgs.data?.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label} ({o.code}){o.status === 'INACTIVE' ? ' — inactive' : ''}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          </fieldset>
          {canEdit && (
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit" loading={save.isPending} disabled={!form.formState.isDirty}>
                Save changes
              </Button>
              <Button variant="outline" disabled={!form.formState.isDirty} onClick={() => form.reset(values(user))}>
                Discard
              </Button>
            </div>
          )}
        </form>
      </CardBody>
    </Card>
  );
}

function RolesCard({ user }: { user: UserDto }) {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('user.administer');
  const roles = useRoles(false, canEdit);
  const [value, setValue] = useState<string[]>(user.roleIds);
  useEffect(() => setValue(user.roleIds), [user.roleIds]);
  const dirty = [...value].sort().join() !== [...user.roleIds].sort().join();
  const save = useMutation({
    mutationFn: async () => api.put(`/users/${user.id}/roles`, { roleIds: value }),
    onSuccess: () => {
      toast.success('Roles updated');
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Card>
      <CardHeader title="Roles" description="Effective permissions are the union of all assigned roles." />
      <CardBody className="space-y-3">
        {canEdit ? (
          <>
            <MultiSelect
              loading={roles.isLoading}
              options={(roles.data ?? []).filter((r) => r.assignable).map((r) => ({ value: r.id, label: r.name }))}
              value={value}
              onChange={setValue}
            />
            <div className="flex gap-2">
              <Button disabled={!dirty || value.length === 0} loading={save.isPending} onClick={() => save.mutate()}>
                Save roles
              </Button>
              {dirty && (
                <Button variant="outline" onClick={() => setValue(user.roleIds)}>
                  Discard
                </Button>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {(user.roles ?? []).map((r) => (
              <Badge key={r.id} tone="primary">
                {r.name}
              </Badge>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function ScopeCard({ user }: { user: UserDto }) {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('user.update');
  const [scope, setScope] = useState<UserScope>(user.scope);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => setScope(user.scope), [user.scope]);
  const dirty = JSON.stringify(scope) !== JSON.stringify(user.scope);
  const save = useMutation({
    mutationFn: async () => api.put(`/users/${user.id}/scope`, { scope }),
    onSuccess: () => {
      setErrors({});
      toast.success('Data access updated');
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => {
      const fields: Record<string, string> = {};
      applyFieldErrors(err, ((name: string, e: { message: string }) => (fields[name] = e.message)) as never);
      setErrors(fields);
      if (!Object.keys(fields).length) toast.error(errorMessage(err));
    },
  });
  return (
    <Card>
      <CardHeader title="Data access" description="Which organisations, regions and sites this user's records are limited to." />
      <CardBody className="space-y-3">
        <fieldset disabled={!canEdit}>
          <ScopeEditor value={scope} onChange={setScope} errors={errors} />
        </fieldset>
        {canEdit && (
          <div className="flex gap-2">
            <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              Save data access
            </Button>
            {dirty && (
              <Button variant="outline" onClick={() => setScope(user.scope)}>
                Discard
              </Button>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function ResetPasswordDialog({ user, open, onOpenChange }: { user: UserDto; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [mode, setMode] = useState<'email' | 'set'>('email');
  const [password, setPassword] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  useEffect(() => {
    if (open) {
      setMode('email');
      setPassword('');
      setMustChange(true);
      setError(null);
    }
  }, [open]);
  const submit = useMutation({
    mutationFn: async () =>
      (await api.post<{ message: string }>(`/users/${user.id}/reset-password`, mode === 'set' ? { password, mustChangePassword: mustChange } : {})).data,
    onSuccess: (r) => {
      toast.success(r.message);
      qc.invalidateQueries({ queryKey: ['users'] });
      onOpenChange(false);
    },
    onError: (err) => {
      const fields: Record<string, string> = {};
      applyFieldErrors(err, ((n: string, e: { message: string }) => (fields[n] = e.message)) as never);
      if (fields.password) setError(fields.password);
      else toast.error(errorMessage(err));
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Reset password"
        description={`For ${user.email}`}
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button loading={submit.isPending} onClick={() => submit.mutate()} disabled={mode === 'set' && !password}>
              {mode === 'email' ? 'Send reset link' : 'Set password'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div role="radiogroup" className="space-y-2">
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="mode" className="mt-1" checked={mode === 'email'} onChange={() => setMode('email')} />
              <span>
                <span className="font-medium">Email a reset link</span>
                <span className="block text-slate-500">The user chooses their own password.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" name="mode" className="mt-1" checked={mode === 'set'} onChange={() => setMode('set')} />
              <span>
                <span className="font-medium">Set a temporary password</span>
                <span className="block text-slate-500">All the user's sessions are signed out.</span>
              </span>
            </label>
          </div>
          {mode === 'set' && (
            <>
              <FormField label="New password" error={error ?? undefined} help="At least 12 characters, with upper-case, lower-case and a number." required>
                {(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
              </FormField>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={mustChange} onCheckedChange={(v) => setMustChange(v === true)} />
                Require a change at next sign-in
              </label>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LoginActivity({ userId }: { userId: string }) {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['users', userId, 'login-activity', page],
    queryFn: async () => (await api.get<Paged<ActivityRow>>(`/users/${userId}/login-activity`, { params: { page, limit: 10 } })).data,
    placeholderData: keepPreviousData,
  });
  return <ActivityCard title="Sign-in activity" q={q} page={page} setPage={setPage} />;
}

export function ActivityCard({
  title,
  q,
  page,
  setPage,
}: {
  title: string;
  q: { data?: Paged<ActivityRow>; isLoading: boolean; error: unknown; refetch: () => unknown };
  page: number;
  setPage: (p: number) => void;
}) {
  return (
    <Card className="mt-4">
      <CardHeader title={title} />
      <DataTable
        caption={title}
        columns={[
          { key: 'time', header: 'When', cell: (r) => formatDateTime(r.timestamp) },
          { key: 'action', header: 'Event', cell: (r) => humanize(r.action.replace(/^auth\./, '')) },
          { key: 'outcome', header: 'Result', cell: (r) => <StatusBadge status={r.outcome} /> },
          { key: 'ip', header: 'IP address', hideOnMobile: true, cell: (r) => r.ip ?? '—' },
          { key: 'ua', header: 'Device', hideOnMobile: true, cell: (r) => describeUserAgent(r.userAgent) },
        ]}
        rows={q.data?.data}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        page={page}
        pages={q.data?.meta.pages}
        total={q.data?.meta.total}
        limit={q.data?.meta.limit}
        onPageChange={setPage}
        emptyTitle="No sign-in activity recorded"
      />
    </Card>
  );
}
