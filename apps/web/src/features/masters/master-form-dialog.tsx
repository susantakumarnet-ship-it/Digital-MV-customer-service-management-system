import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MASTER_RESOURCES, masterSchemas, type MasterField, type MasterKey } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FormField, Input, Select, Textarea } from '@/components/ui/form';
import { api, applyFieldErrors, errorMessage } from '@/lib/api';
import { useMasterOptions } from '@/lib/queries';
import type { MasterRecord } from '@/lib/types';
import { cn } from '@/lib/utils';

type Values = Record<string, string>;

function toFormValues(resource: MasterKey, record?: MasterRecord | null): Values {
  const out: Values = {};
  for (const f of MASTER_RESOURCES[resource].fields) {
    const v = record?.[f.name];
    out[f.name] = v === undefined || v === null ? (f.kind === 'select' && f.options?.[0] ? '' : '') : String(v);
  }
  // Sensible defaults for enum selects on create.
  if (!record) for (const f of MASTER_RESOURCES[resource].fields) if (f.kind === 'select' && f.required && f.options?.[0]) out[f.name] = f.options[0].value;
  return out;
}

/**
 * Create/edit form generated from the shared master-resource definition and validated with the same
 * Zod schema the API uses. Raw string values are submitted so cleared optional fields are unset server-side.
 */
export function MasterFormDialog({
  resource,
  record,
  open,
  onOpenChange,
}: {
  resource: MasterKey;
  record: MasterRecord | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const def = MASTER_RESOURCES[resource];
  const qc = useQueryClient();
  const form = useForm<Values>({ resolver: zodResolver(masterSchemas[resource] as never), defaultValues: toFormValues(resource, record) });

  useEffect(() => {
    if (open) form.reset(toFormValues(resource, record));
  }, [open, record, resource, form]);

  const save = useMutation({
    mutationFn: async (values: Values) =>
      record ? (await api.patch(`/masters/${resource}/${record.id}`, values)).data : (await api.post(`/masters/${resource}`, values)).data,
    onSuccess: () => {
      toast.success(`${def.singular} ${record ? 'updated' : 'created'}`);
      qc.invalidateQueries({ queryKey: ['masters', resource] });
      onOpenChange(false);
    },
    onError: (err) => {
      if (!applyFieldErrors(err, form.setError)) toast.error(errorMessage(err));
    },
  });

  const onSubmit = form.handleSubmit(() => save.mutate(form.getValues()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title={record ? `Edit ${def.singular.toLowerCase()}` : `New ${def.singular.toLowerCase()}`}
        description={record ? `${record.name} (${record.code})` : undefined}
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button loading={save.isPending} onClick={onSubmit}>
              {record ? 'Save changes' : `Create ${def.singular.toLowerCase()}`}
            </Button>
          </>
        }
      >
        <form onSubmit={onSubmit} noValidate className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {def.fields.map((f) => (
            <MasterInput key={f.name} field={f} form={form} />
          ))}
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MasterInput({ field: f, form }: { field: MasterField; form: ReturnType<typeof useForm<Values>> }) {
  const error = form.formState.errors[f.name]?.message as string | undefined;
  const wide = f.kind === 'textarea';
  return (
    <FormField label={f.label} error={error} help={f.help} required={f.required} className={cn(wide && 'sm:col-span-2')}>
      {(p) => {
        switch (f.kind) {
          case 'textarea':
            return <Textarea {...p} {...form.register(f.name)} />;
          case 'select':
            return (
              <Select {...p} {...form.register(f.name)}>
                {!f.required && <option value="">—</option>}
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            );
          case 'ref':
            return <RefSelect controlProps={p} field={f} form={form} />;
          case 'number':
            return <Input {...p} inputMode="decimal" {...form.register(f.name)} />;
          case 'email':
            return <Input {...p} type="email" {...form.register(f.name)} />;
          case 'phone':
            return <Input {...p} type="tel" {...form.register(f.name)} />;
          default:
            return <Input {...p} {...form.register(f.name)} />;
        }
      }}
    </FormField>
  );
}

function RefSelect({
  controlProps,
  field: f,
  form,
}: {
  controlProps: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string };
  field: MasterField;
  form: ReturnType<typeof useForm<Values>>;
}) {
  const opts = useMasterOptions(f.ref);
  const current = form.watch(f.name);
  // Keep the current value visible even if the referenced record has since been deactivated.
  const inactive = useMasterOptions(f.ref, { includeInactive: true, enabled: Boolean(current) && !opts.data?.some((o) => o.id === current) && !opts.isLoading });
  const currentInactive = inactive.data?.find((o) => o.id === current);
  return (
    <Select {...controlProps} {...form.register(f.name)} disabled={opts.isLoading}>
      <option value="">{opts.isLoading ? 'Loading…' : f.required ? 'Select…' : '— None —'}</option>
      {opts.data?.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label} ({o.code})
        </option>
      ))}
      {currentInactive && (
        <option value={currentInactive.id}>
          {currentInactive.label} ({currentInactive.code}) — inactive
        </option>
      )}
    </Select>
  );
}
