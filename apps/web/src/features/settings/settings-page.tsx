import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Controller, useForm, type FieldValues } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SETTINGS_GROUPS, settingsSchemas, type Settings, type SettingsGroup } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Switch, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/controls';
import { FormField, Input, Select, Textarea } from '@/components/ui/form';
import { LoadingScreen } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageHeader } from '@/components/page-header';
import { ErrorState } from '@/components/states';
import { TagInput } from '@/components/tag-input';
import { useAuth } from '@/features/auth/auth-context';
import { api, applyFieldErrors, errorMessage } from '@/lib/api';
import { formatReference } from '@mv/shared';
import { listTimeZones } from '@/lib/format';

type Kind = 'text' | 'number' | 'bool' | 'select' | 'textarea' | 'tz' | 'tags';
interface FieldSpec {
  path: string;
  label: string;
  kind: Kind;
  help?: string;
  options?: { value: string; label: string }[];
}
interface GroupSpec {
  label: string;
  description: string;
  fields: FieldSpec[];
}

const NUMBERING_KINDS = [
  ['complaint', 'Complaint reference'],
  ['workOrder', 'Work order number'],
  ['visit', 'Visit number'],
  ['materialRequest', 'Material request number'],
  ['ncr', 'NCR number'],
] as const;

const GROUPS: Record<SettingsGroup, GroupSpec> = {
  general: {
    label: 'General',
    description: 'Application identity, display timezone and date format.',
    fields: [
      { path: 'applicationName', label: 'Application name', kind: 'text' },
      { path: 'organizationName', label: 'Operating organization', kind: 'text' },
      { path: 'timezone', label: 'Display timezone', kind: 'tz', help: 'All timestamps are stored in UTC and displayed in this timezone (D-26).' },
      {
        path: 'dateFormat',
        label: 'Date format',
        kind: 'select',
        options: [
          { value: 'dd/MM/yyyy', label: 'dd/MM/yyyy' },
          { value: 'MM/dd/yyyy', label: 'MM/dd/yyyy' },
          { value: 'yyyy-MM-dd', label: 'yyyy-MM-dd' },
        ],
      },
      { path: 'supportEmail', label: 'Support email', kind: 'text' },
      { path: 'supportPhone', label: 'Support phone', kind: 'text' },
    ],
  },
  numbering: {
    label: 'Numbering',
    description: 'Reference number formats. Numbers are generated atomically on the server (BR-001, decision D-13).',
    fields: NUMBERING_KINDS.flatMap(([k, label]) => [
      { path: `${k}.prefix`, label: `${label}: prefix`, kind: 'text' as const },
      { path: `${k}.padding`, label: `${label}: digits`, kind: 'number' as const },
      { path: `${k}.resetYearly`, label: `${label}: include year & reset yearly`, kind: 'bool' as const },
    ]),
  },
  workflow: {
    label: 'Workflow rules',
    description: 'Business-rule switches. SLA targets per priority are configured under Master Data › Priorities & SLA.',
    fields: [
      { path: 'allowMultipleWorkOrdersPerComplaint', label: 'Allow multiple work orders per complaint', kind: 'bool', help: 'Decision D-03 (BR-004).' },
      { path: 'allowConcurrentTimeSequences', label: 'Allow concurrent time sequences per engineer', kind: 'bool', help: 'Decision D-14.' },
      { path: 'pauseSlaWhileAwaitingCustomer', label: 'Pause SLA while awaiting customer information', kind: 'bool', help: 'Decision D-15.' },
      { path: 'inspectionApprovalLevels', label: 'Inspection approval levels', kind: 'number', help: '1–3 (D-17).' },
      { path: 'allowSelfApproval', label: 'Allow self-approval (segregation-of-duties exception)', kind: 'bool', help: 'BR-012 — keep off unless an approved exception policy exists.' },
      { path: 'acceptanceTokenValidityDays', label: 'Customer acceptance link validity (days)', kind: 'number' },
      { path: 'duplicateLookbackDays', label: 'Duplicate detection look-back (days)', kind: 'number' },
      { path: 'repeatComplaintWindowDays', label: 'Repeat complaint window (days)', kind: 'number', help: 'Decision D-19.' },
    ],
  },
  attachments: {
    label: 'Attachments',
    description: 'Upload limits enforced on the server (HO §7.1, decision D-20).',
    fields: [
      { path: 'allowedExtensions', label: 'Allowed file extensions', kind: 'tags', help: 'Lower-case, without the dot. Press Enter to add.' },
      { path: 'maxFileSizeMb', label: 'Maximum file size (MB)', kind: 'number' },
      { path: 'maxFilesPerRecord', label: 'Maximum files per record', kind: 'number' },
      { path: 'maxTotalSizeMbPerRecord', label: 'Maximum total size per record (MB)', kind: 'number' },
    ],
  },
  security: {
    label: 'Security',
    description: 'Sign-in protection and session lifetimes.',
    fields: [
      { path: 'mfaRequiredForPrivileged', label: 'Require MFA for Administrator, Supervisor and Reviewer roles', kind: 'bool', help: 'Decision D-21. Affected users must enrol at their next sign-in.' },
      { path: 'maxFailedLogins', label: 'Failed sign-ins before lockout', kind: 'number' },
      { path: 'lockoutMinutes', label: 'Lockout duration (minutes)', kind: 'number' },
      { path: 'sessionIdleTimeoutMinutes', label: 'Idle session timeout (minutes)', kind: 'number' },
      { path: 'sessionAbsoluteTimeoutHours', label: 'Maximum session length (hours)', kind: 'number' },
      { path: 'passwordResetValidityMinutes', label: 'Password reset link validity (minutes)', kind: 'number' },
    ],
  },
  notifications: {
    label: 'Notifications',
    description: 'Channels and timing. SMS and WhatsApp require a configured provider (decision D-09).',
    fields: [
      { path: 'emailEnabled', label: 'Email notifications', kind: 'bool' },
      { path: 'smsEnabled', label: 'SMS notifications', kind: 'bool' },
      { path: 'whatsappEnabled', label: 'WhatsApp notifications', kind: 'bool' },
      { path: 'dueSoonHours', label: '"Due soon" warning (hours before due)', kind: 'number' },
      { path: 'digestHourLocal', label: 'Daily digest hour (local, 0–23)', kind: 'number' },
    ],
  },
  publicForm: {
    label: 'Public complaint form',
    description: 'Public registration page (Phase 3) and its anti-spam controls.',
    fields: [
      { path: 'enabled', label: 'Public form enabled', kind: 'bool' },
      { path: 'privacyNoticeVersion', label: 'Privacy notice version', kind: 'text', help: 'Increase when the text changes; stored with every consent.' },
      { path: 'privacyNoticeText', label: 'Privacy notice text', kind: 'textarea' },
      { path: 'minimumFillSeconds', label: 'Minimum seconds to fill the form', kind: 'number' },
      { path: 'maxSubmissionsPerHourPerIp', label: 'Maximum submissions per hour per IP', kind: 'number' },
    ],
  },
};

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (SETTINGS_GROUPS as string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as SettingsGroup) : 'general';
  const q = useQuery({ queryKey: ['settings'], queryFn: async () => (await api.get<Settings>('/settings')).data });

  return (
    <div>
      <PageHeader title="System configuration" description="All changes are validated, take effect within seconds and are recorded in the audit log." />
      {q.isLoading ? (
        <LoadingScreen />
      ) : q.isError || !q.data ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : (
        <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
          <TabsList>
            {SETTINGS_GROUPS.map((g) => (
              <TabsTrigger key={g} value={g}>
                {GROUPS[g].label}
              </TabsTrigger>
            ))}
          </TabsList>
          {SETTINGS_GROUPS.map((g) => (
            <TabsContent key={g} value={g}>
              <GroupForm group={g} value={q.data[g]} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

function GroupForm<G extends SettingsGroup>({ group, value }: { group: G; value: Settings[G] }) {
  const spec = GROUPS[group];
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('settings.update');
  const form = useForm<FieldValues>({ resolver: zodResolver(settingsSchemas[group] as never), defaultValues: value as FieldValues });
  const [pending, setPending] = useState<FieldValues | null>(null);
  useEffect(() => form.reset(value as FieldValues), [value, form]);
  const timezones = useMemo(() => (spec.fields.some((f) => f.kind === 'tz') ? listTimeZones() : []), [spec]);

  const save = useMutation({
    mutationFn: async ({ v, reason }: { v: FieldValues; reason: string }) => (await api.put(`/settings/${group}`, { value: v, reason: reason || undefined })).data,
    onSuccess: () => {
      toast.success(`${spec.label} settings saved`);
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err) => {
      if (!applyFieldErrors(err, form.setError)) toast.error(errorMessage(err));
    },
  });

  const watched = form.watch();
  return (
    <Card>
      <CardHeader title={spec.label} description={spec.description} />
      <CardBody>
        <form onSubmit={form.handleSubmit((v) => setPending(v))} noValidate className="space-y-5">
          <fieldset disabled={!canEdit} className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {spec.fields.map((f) => {
              const err = getPath(form.formState.errors, f.path) as { message?: string } | undefined;
              if (f.kind === 'bool') {
                return (
                  <Controller
                    key={f.path}
                    control={form.control}
                    name={f.path}
                    render={({ field }) => (
                      <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3 md:col-span-2">
                        <div>
                          <label htmlFor={`s-${f.path}`} className="text-sm font-medium text-slate-700">
                            {f.label}
                          </label>
                          {f.help && <p className="text-xs text-slate-500">{f.help}</p>}
                        </div>
                        <Switch id={`s-${f.path}`} checked={Boolean(field.value)} onCheckedChange={field.onChange} disabled={!canEdit} />
                      </div>
                    )}
                  />
                );
              }
              return (
                <FormField key={f.path} label={f.label} help={f.help} error={err?.message} className={f.kind === 'textarea' || f.kind === 'tags' ? 'md:col-span-2' : undefined}>
                  {(p) => {
                    if (f.kind === 'textarea') return <Textarea {...p} rows={5} {...form.register(f.path)} />;
                    if (f.kind === 'select')
                      return (
                        <Select {...p} {...form.register(f.path)}>
                          {f.options!.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </Select>
                      );
                    if (f.kind === 'tz')
                      return (
                        <Select {...p} {...form.register(f.path)}>
                          {timezones.map((tz) => (
                            <option key={tz} value={tz}>
                              {tz}
                            </option>
                          ))}
                        </Select>
                      );
                    if (f.kind === 'tags')
                      return (
                        <Controller
                          control={form.control}
                          name={f.path}
                          render={({ field }) => (
                            <TagInput
                              id={p.id}
                              invalid={p['aria-invalid']}
                              disabled={!canEdit}
                              value={(field.value as string[]) ?? []}
                              onChange={field.onChange}
                              normalize={(s) => s.trim().toLowerCase().replace(/^\./, '')}
                            />
                          )}
                        />
                      );
                    return <Input {...p} inputMode={f.kind === 'number' ? 'numeric' : undefined} {...form.register(f.path)} />;
                  }}
                </FormField>
              );
            })}
          </fieldset>
          {group === 'numbering' && <NumberingPreview values={watched as Settings['numbering']} />}
          {group === 'workflow' && (
            <p className="text-sm text-slate-500">
              Status labels and optional transitions are edited under <Link to="/admin/workflows" className="text-royal-700 hover:underline">Workflows</Link>.
            </p>
          )}
          {canEdit && (
            <div className="flex gap-2">
              <Button type="submit" disabled={!form.formState.isDirty} loading={save.isPending}>
                Save {spec.label.toLowerCase()}
              </Button>
              <Button variant="outline" disabled={!form.formState.isDirty} onClick={() => form.reset(value as FieldValues)}>
                Discard
              </Button>
            </div>
          )}
        </form>
      </CardBody>
      <ConfirmDialog
        open={Boolean(pending)}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Save ${spec.label.toLowerCase()} settings?`}
        description="The change applies to all users and is recorded in the audit log."
        confirmLabel="Save"
        reason="optional"
        reasonLabel="Reason for change"
        onConfirm={(reason) => save.mutateAsync({ v: pending!, reason })}
      />
    </Card>
  );
}

function NumberingPreview({ values }: { values: Settings['numbering'] }) {
  const year = new Date().getFullYear();
  return (
    <div className="rounded-lg bg-slate-50 p-3 text-sm">
      <p className="mb-1 font-medium text-navy-900">Preview</p>
      <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {NUMBERING_KINDS.map(([k, label]) => {
          const cfg = values?.[k];
          let sample = '—';
          try {
            if (cfg?.prefix) sample = formatReference({ prefix: cfg.prefix, padding: Number(cfg.padding) || 6, resetYearly: Boolean(cfg.resetYearly) }, year, 1);
          } catch {
            /* invalid while typing */
          }
          return (
            <li key={k} className="flex justify-between gap-2">
              <span className="text-slate-500">{label}</span>
              <code>{sample}</code>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
