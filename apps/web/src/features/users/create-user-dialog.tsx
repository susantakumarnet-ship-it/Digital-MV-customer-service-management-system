import { useEffect, useState } from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { userCreateSchema } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/controls';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FormField, Input, Select } from '@/components/ui/form';
import { MultiSelect } from '@/components/multi-select';
import { api, applyFieldErrors, errorMessage } from '@/lib/api';
import { useMasterOptions, useRoles } from '@/lib/queries';
import type { UserDto } from '@/lib/types';
import { ScopeEditor } from './scope-editor';

type FormIn = z.input<typeof userCreateSchema>;
type FormOut = z.output<typeof userCreateSchema>;

const EMPTY: FormIn = {
  name: '',
  email: '',
  username: '',
  phone: '',
  jobTitle: '',
  roleIds: [],
  organizationId: null,
  scope: { global: false, organizationIds: [], regionIds: [], siteIds: [] },
  password: undefined,
  mustChangePassword: true,
};

export function CreateUserDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (u: UserDto) => void }) {
  const qc = useQueryClient();
  const roles = useRoles(false, open);
  const orgs = useMasterOptions('organizations', { enabled: open });
  const [setPassword, setSetPassword] = useState(false);

  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(userCreateSchema) as unknown as Resolver<FormIn, unknown, FormOut>,
    defaultValues: EMPTY,
  });
  const { register, control, handleSubmit, formState, watch, setValue, reset, setError } = form;

  useEffect(() => {
    if (open) {
      reset(EMPTY);
      setSetPassword(false);
    }
  }, [open, reset]);

  const assignable = (roles.data ?? []).filter((r) => r.assignable && r.status === 'ACTIVE');
  const roleIds = watch('roleIds');
  const isCustomer = assignable.some((r) => r.key === 'CUSTOMER' && roleIds.includes(r.id));

  const create = useMutation({
    mutationFn: async (v: FormOut) => (await api.post<UserDto>('/users', v)).data,
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(setPassword ? `User ${u.email} created` : `User created — an activation email has been sent to ${u.email}`);
      onOpenChange(false);
      onCreated(u);
    },
    onError: (err) => {
      if (!applyFieldErrors(err, setError)) toast.error(errorMessage(err));
    },
  });

  const onSubmit = handleSubmit((v) => {
    const payload = { ...v, password: setPassword ? v.password : undefined };
    if (isCustomer) payload.scope = { global: false, organizationIds: v.organizationId ? [v.organizationId] : [], regionIds: [], siteIds: [] };
    create.mutate(payload);
  });

  const e = formState.errors;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title="New user"
        description="Users without an initial password receive an activation email to set their own."
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={onSubmit} loading={create.isPending}>
              Create user
            </Button>
          </>
        }
      >
        <form onSubmit={onSubmit} noValidate className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Full name" error={e.name?.message} required>
              {(p) => <Input {...p} {...register('name')} />}
            </FormField>
            <FormField label="Email" error={e.email?.message} required>
              {(p) => <Input {...p} type="email" {...register('email')} />}
            </FormField>
            <FormField label="Username" error={e.username?.message} help="Optional alternative sign-in name">
              {(p) => <Input {...p} {...register('username')} />}
            </FormField>
            <FormField label="Phone" error={e.phone?.message}>
              {(p) => <Input {...p} type="tel" {...register('phone')} />}
            </FormField>
            <FormField label="Job title" error={e.jobTitle?.message}>
              {(p) => <Input {...p} {...register('jobTitle')} />}
            </FormField>
            <FormField label="Organization" error={e.organizationId?.message} required={isCustomer}>
              {(p) => (
                <Controller
                  control={control}
                  name="organizationId"
                  render={({ field }) => (
                    <Select {...p} value={field.value ?? ''} onChange={(ev) => field.onChange(ev.target.value || null)}>
                      <option value="">— None —</option>
                      {orgs.data?.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label} ({o.code})
                        </option>
                      ))}
                    </Select>
                  )}
                />
              )}
            </FormField>
          </div>

          <FormField
            label="Roles"
            error={e.roleIds?.message}
            required
            help="You can only assign roles whose permissions you hold. The Customer User role cannot be combined with others."
          >
            {(p) => (
              <Controller
                control={control}
                name="roleIds"
                render={({ field }) => (
                  <MultiSelect
                    id={p.id}
                    invalid={Boolean(e.roleIds)}
                    loading={roles.isLoading}
                    options={assignable.map((r) => ({ value: r.id, label: r.name }))}
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
            )}
          </FormField>

          <fieldset>
            <legend className="field-label">Data access</legend>
            {isCustomer ? (
              <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
                Customer users can only see records of their own organization.
              </p>
            ) : (
              <Controller
                control={control}
                name="scope"
                render={({ field }) => (
                  <ScopeEditor
                    value={{ global: false, organizationIds: [], regionIds: [], siteIds: [], ...field.value }}
                    onChange={field.onChange}
                    errors={Object.fromEntries(
                      Object.entries(formState.errors.scope ?? {}).map(([k, v]) => [`scope.${k}`, (v as { message?: string })?.message]),
                    )}
                  />
                )}
              />
            )}
          </fieldset>

          <fieldset className="space-y-3 rounded-lg border border-border p-3">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <Checkbox
                checked={setPassword}
                onCheckedChange={(v) => {
                  setSetPassword(v === true);
                  if (v !== true) setValue('password', undefined);
                }}
              />
              Set an initial password instead of sending an activation email
            </label>
            {setPassword && (
              <>
                <FormField label="Initial password" error={e.password?.message} help="At least 12 characters, with upper-case, lower-case and a number." required>
                  {(p) => <Input {...p} type="password" autoComplete="new-password" {...register('password')} />}
                </FormField>
                <Controller
                  control={control}
                  name="mustChangePassword"
                  render={({ field }) => (
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />
                      Require the user to change it at first sign-in
                    </label>
                  )}
                />
              </>
            )}
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
