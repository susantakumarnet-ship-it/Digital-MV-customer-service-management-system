import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LogOut, MonitorSmartphone, ShieldCheck, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { profileUpdateSchema, type Paged } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FormField, Input, Select } from '@/components/ui/form';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageHeader } from '@/components/page-header';
import { ErrorState } from '@/components/states';
import { useAuth } from '@/features/auth/auth-context';
import { MfaSetupWizard } from '@/features/auth/mfa-setup';
import { ChangePasswordForm } from '@/features/auth/password-pages';
import { ActivityCard } from '@/features/users/user-detail-page';
import { api, applyFieldErrors, errorMessage, parseApiError } from '@/lib/api';
import { describeUserAgent, formatDateTime, listTimeZones, timeAgo } from '@/lib/format';
import type { ActivityRow, SessionRow } from '@/lib/types';

export function ProfilePage() {
  return (
    <div>
      <PageHeader title="Profile & security" description="Your personal details, password, two-step verification and sessions." />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ProfileForm />
        <Card>
          <CardHeader title="Change password" description="Changing your password signs out your other devices." />
          <CardBody>
            <ChangePasswordForm />
          </CardBody>
        </Card>
        <MfaCard />
        <SessionsCard />
      </div>
      <MyActivity />
    </div>
  );
}

function ProfileForm() {
  const { user, reloadMe } = useAuth();
  type V = z.input<typeof profileUpdateSchema>;
  const timezones = useMemo(() => listTimeZones(), []);
  const form = useForm<V>({ resolver: zodResolver(profileUpdateSchema) });
  useEffect(() => {
    if (user) form.reset({ name: user.name, phone: user.phone ?? '', timezone: user.timezone ?? '' });
  }, [user, form]);
  const save = useMutation({
    mutationFn: async (v: V) => api.patch('/auth/me', v),
    onSuccess: async () => {
      toast.success('Profile saved');
      await reloadMe();
    },
    onError: (err) => {
      if (!applyFieldErrors(err, form.setError)) toast.error(errorMessage(err));
    },
  });
  if (!user) return null;
  const e = form.formState.errors;
  return (
    <Card>
      <CardHeader title="Your details" description={user.email} />
      <CardBody>
        <form
          onSubmit={form.handleSubmit((v) => {
            // Send only changed fields; clearing a field (sending '') removes it on the server.
            const dirty = form.formState.dirtyFields;
            const payload = Object.fromEntries(Object.entries(v).filter(([k]) => dirty[k as keyof V])) as V;
            save.mutate(payload);
          })}
          noValidate
          className="space-y-4"
        >
          <FormField label="Full name" error={e.name?.message} required>
            {(p) => <Input {...p} {...form.register('name')} />}
          </FormField>
          <FormField label="Phone" error={e.phone?.message} help="Clear the field to remove your number.">
            {(p) => <Input {...p} type="tel" {...form.register('phone')} />}
          </FormField>
          <FormField label="Display timezone" error={e.timezone?.message} help="Overrides the system timezone for your own view.">
            {(p) => (
              <Select {...p} {...form.register('timezone')}>
                <option value="">Use system timezone</option>
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <div className="flex flex-wrap gap-1.5">
            {user.roles.map((r) => (
              <Badge key={r.id} tone="primary">
                {r.name}
              </Badge>
            ))}
          </div>
          <Button type="submit" loading={save.isPending} disabled={!form.formState.isDirty}>
            Save details
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function MfaCard() {
  const { user, reloadMe } = useAuth();
  const [setupOpen, setSetupOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  if (!user) return null;
  return (
    <Card>
      <CardHeader
        title="Two-step verification"
        description="Protect your account with a code from an authenticator app."
        actions={user.mfaEnabled ? <Badge tone="success">On</Badge> : <Badge tone="neutral">Off</Badge>}
      />
      <CardBody className="space-y-3">
        {user.mfaEnabled ? (
          <>
            <p className="flex items-center gap-2 text-sm text-slate-700">
              <ShieldCheck className="h-5 w-5 text-teal-600" aria-hidden /> You will be asked for a code each time you sign in.
            </p>
            {user.mfaRequired ? (
              <p className="text-xs text-slate-500">Two-step verification is mandatory for your role.</p>
            ) : (
              <Button variant="outline" onClick={() => setDisableOpen(true)}>
                <ShieldOff className="h-4 w-4" /> Turn off
              </Button>
            )}
          </>
        ) : (
          <Button onClick={() => setSetupOpen(true)}>
            <ShieldCheck className="h-4 w-4" /> Set up two-step verification
          </Button>
        )}
      </CardBody>
      <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
        <DialogContent title="Set up two-step verification">
          {setupOpen && (
            <MfaSetupWizard
              onComplete={async () => {
                setSetupOpen(false);
                toast.success('Two-step verification is on');
                await reloadMe();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <DisableMfaDialog open={disableOpen} onOpenChange={setDisableOpen} />
    </Card>
  );
}

function DisableMfaDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { reloadMe } = useAuth();
  const schema = z.object({ password: z.string().min(1, 'Password is required'), code: z.string().trim().min(6, 'Enter the code') });
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { password: '', code: '' } });
  useEffect(() => {
    if (open) form.reset({ password: '', code: '' });
  }, [open, form]);
  const submit = form.handleSubmit(async (v) => {
    try {
      await api.post('/auth/mfa/disable', v);
      toast.success('Two-step verification turned off');
      onOpenChange(false);
      await reloadMe();
    } catch (err) {
      if (!applyFieldErrors(err, form.setError)) toast.error(parseApiError(err).message);
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Turn off two-step verification?"
        description="Confirm with your password and a current code."
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={form.formState.isSubmitting} onClick={submit}>
              Turn off
            </Button>
          </>
        }
      >
        <form onSubmit={submit} noValidate className="space-y-4">
          <FormField label="Password" error={form.formState.errors.password?.message} required>
            {(p) => <Input {...p} type="password" autoComplete="current-password" {...form.register('password')} />}
          </FormField>
          <FormField label="Authenticator code" error={form.formState.errors.code?.message} required>
            {(p) => <Input {...p} inputMode="numeric" autoComplete="one-time-code" {...form.register('code')} />}
          </FormField>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SessionsCard() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const q = useQuery({ queryKey: ['auth', 'sessions'], queryFn: async () => (await api.get<SessionRow[]>('/auth/sessions')).data });
  const [revoke, setRevoke] = useState<SessionRow | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  return (
    <Card>
      <CardHeader
        title="Active sessions"
        description="Devices currently signed in to your account."
        actions={
          <Button variant="outline" size="sm" onClick={() => setAllOpen(true)}>
            <LogOut className="h-4 w-4" /> Sign out everywhere
          </Button>
        }
      />
      {q.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <ul className="divide-y divide-border">
          {q.data?.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <MonitorSmartphone className="h-5 w-5 shrink-0 text-slate-400" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-navy-900">
                  {describeUserAgent(s.userAgent)} {s.current && <Badge tone="accent">This device</Badge>}
                </p>
                <p className="text-xs text-slate-500">
                  {s.ip ?? 'Unknown IP'} · signed in {formatDateTime(s.createdAt)} · active {timeAgo(s.lastSeenAt)}
                </p>
              </div>
              {!s.current && (
                <Button variant="ghost" size="sm" className="text-red-600" onClick={() => setRevoke(s)}>
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={Boolean(revoke)}
        onOpenChange={(o) => !o && setRevoke(null)}
        title="Sign out this session?"
        description={revoke ? `${describeUserAgent(revoke.userAgent)} · ${revoke.ip ?? ''}` : undefined}
        confirmLabel="Sign out"
        tone="danger"
        onConfirm={async () => {
          try {
            await api.delete(`/auth/sessions/${revoke!.id}`);
            toast.success('Session signed out');
            qc.invalidateQueries({ queryKey: ['auth', 'sessions'] });
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
        }}
      />
      <ConfirmDialog
        open={allOpen}
        onOpenChange={setAllOpen}
        title="Sign out everywhere?"
        description="All sessions, including this one, will end. You will need to sign in again."
        confirmLabel="Sign out everywhere"
        tone="danger"
        onConfirm={async () => {
          try {
            await api.post('/auth/logout-all');
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
          await logout().catch(() => undefined);
          navigate('/login', { replace: true });
        }}
      />
    </Card>
  );
}

function MyActivity() {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['auth', 'activity', page],
    queryFn: async () => (await api.get<Paged<ActivityRow>>('/auth/activity', { params: { page, limit: 10 } })).data,
    placeholderData: keepPreviousData,
  });
  return <ActivityCard title="My sign-in history" q={q} page={page} setPage={setPage} />;
}
