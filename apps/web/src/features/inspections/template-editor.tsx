import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { EVIDENCE_REQUIREMENTS, inspectionTemplateSchema, type InspectionTemplateDto, type TemplateItem } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/controls';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FormField, Input, Select, Textarea } from '@/components/ui/form';
import { api, parseApiError } from '@/lib/api';
import { useMasterOptions } from '@/lib/queries';

export interface TemplateForm {
  name: string;
  equipmentTypeId: string;
  description: string;
  items: (Omit<TemplateItem, 'section' | 'guidance'> & { section: string; guidance: string })[];
}

/** Suggests a stable item key from its description, e.g. "Check SF6 gas pressure" → "CHECK_SF6_GAS". */
export function suggestKey(description: string, taken: string[] = []) {
  const base =
    description
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join('_')
      .slice(0, 30) || 'ITEM';
  let key = base;
  let n = 2;
  while (taken.includes(key)) key = `${base}_${n++}`;
  return key;
}

export const emptyItem = (): TemplateForm['items'][number] => ({
  key: '',
  section: '',
  description: '',
  guidance: '',
  required: true,
  evidence: 'NONE',
  naReasonRequired: false,
  evidenceOnFail: false,
});

/** Validates with the shared schema; returns field errors keyed like "items.2.key". */
export function validateTemplate(form: TemplateForm): Record<string, string> {
  const r = inspectionTemplateSchema.safeParse(form);
  if (r.success) return {};
  const out: Record<string, string> = {};
  for (const i of r.error.issues) out[i.path.join('.') || '_'] ??= i.message;
  return out;
}

export function TemplateEditorDialog({
  open,
  onOpenChange,
  template,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Existing DRAFT version to edit; undefined = new template. */
  template?: InspectionTemplateDto;
  onSaved: (t: InspectionTemplateDto) => void;
}) {
  const eq = useMasterOptions('equipmentTypes', { enabled: open });
  const [form, setForm] = useState<TemplateForm>({ name: '', equipmentTypeId: '', description: '', items: [emptyItem()] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setForm(
      template
        ? {
            name: template.name,
            equipmentTypeId: template.equipmentType.id,
            description: template.description ?? '',
            items: template.items.map((i) => ({ ...i, section: i.section ?? '', guidance: i.guidance ?? '' })),
          }
        : { name: '', equipmentTypeId: '', description: '', items: [emptyItem()] },
    );
  }, [open, template]);

  const setItem = (idx: number, patch: Partial<TemplateForm['items'][number]>) =>
    setForm((f) => ({ ...f, items: f.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) }));
  const move = (idx: number, dir: -1 | 1) =>
    setForm((f) => {
      const items = [...f.items];
      const j = idx + dir;
      if (j < 0 || j >= items.length) return f;
      [items[idx], items[j]] = [items[j]!, items[idx]!];
      return { ...f, items };
    });

  const save = async () => {
    const errs = validateTemplate(form);
    setErrors(errs);
    if (Object.keys(errs).length) {
      toast.error('Please correct the highlighted fields');
      return;
    }
    setBusy(true);
    try {
      const res = template
        ? await api.put<InspectionTemplateDto>(`/inspections/templates/${template.id}`, form)
        : await api.post<InspectionTemplateDto>('/inspections/templates', form);
      toast.success(`Draft ${res.data.name} v${res.data.version} saved`);
      onSaved(res.data);
      onOpenChange(false);
    } catch (err) {
      const e = parseApiError(err);
      if (e.fields) setErrors(e.fields);
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={template ? `Edit draft — ${template.name} v${template.version}` : 'New checklist template'}
        description="Drafts can be edited freely. Publishing makes the version active for new inspections."
        size="xl"
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={save} loading={busy}>
              Save draft
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Name" required error={errors.name}>
              {(p) => <Input {...p} maxLength={150} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
            </FormField>
            <FormField label="Equipment type" required error={errors.equipmentTypeId} help={template ? 'Fixed for an existing version.' : undefined}>
              {(p) => (
                <Select {...p} value={form.equipmentTypeId} disabled={Boolean(template)} onChange={(e) => setForm({ ...form, equipmentTypeId: e.target.value })}>
                  <option value="">Select…</option>
                  {eq.data?.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label="Description" error={errors.description} className="sm:col-span-2">
              {(p) => <Textarea {...p} rows={2} maxLength={1000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}
            </FormField>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold text-navy-900">Checklist items ({form.items.length})</p>
              {errors.items && <p className="text-xs text-red-600">{errors.items}</p>}
            </div>
            <ol className="space-y-3">
              {form.items.map((it, idx) => {
                const err = (f: string) => errors[`items.${idx}.${f}`];
                return (
                  <li key={idx} className="rounded-lg border border-border p-3" data-testid="template-item">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-500">Item {idx + 1}</span>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" aria-label={`Move item ${idx + 1} up`} disabled={idx === 0} onClick={() => move(idx, -1)}>
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" aria-label={`Move item ${idx + 1} down`} disabled={idx === form.items.length - 1} onClick={() => move(idx, 1)}>
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove item ${idx + 1}`}
                          disabled={form.items.length === 1}
                          onClick={() => setForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== idx) }))}
                        >
                          <Trash2 className="h-4 w-4 text-red-600" />
                        </Button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
                      <FormField label="What to inspect" required error={err('description')} className="sm:col-span-4">
                        {(p) => (
                          <Input
                            {...p}
                            maxLength={500}
                            value={it.description}
                            onChange={(e) => setItem(idx, { description: e.target.value })}
                            onBlur={() => {
                              if (!it.key && it.description.trim())
                                setItem(idx, { key: suggestKey(it.description, form.items.filter((_, i) => i !== idx).map((x) => x.key)) });
                            }}
                          />
                        )}
                      </FormField>
                      <FormField label="Key" required error={err('key')} help="Stable across versions" className="sm:col-span-2">
                        {(p) => <Input {...p} maxLength={40} value={it.key} onChange={(e) => setItem(idx, { key: e.target.value })} className="font-mono" />}
                      </FormField>
                      <FormField label="Section" error={err('section')} className="sm:col-span-2">
                        {(p) => <Input {...p} maxLength={120} value={it.section} onChange={(e) => setItem(idx, { section: e.target.value })} />}
                      </FormField>
                      <FormField label="Evidence" error={err('evidence')} className="sm:col-span-2">
                        {(p) => (
                          <Select {...p} value={it.evidence} onChange={(e) => setItem(idx, { evidence: e.target.value as TemplateItem['evidence'] })}>
                            {EVIDENCE_REQUIREMENTS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </Select>
                        )}
                      </FormField>
                      <div className="flex flex-col justify-end gap-2 sm:col-span-2">
                        {(
                          [
                            ['required', 'Result required'],
                            ['naReasonRequired', 'N/A needs a reason'],
                            ['evidenceOnFail', 'Evidence if failed'],
                          ] as const
                        ).map(([k, label]) => (
                          <label key={k} className="flex items-center gap-2 text-sm text-slate-700">
                            <Checkbox checked={it[k]} onCheckedChange={(c) => setItem(idx, { [k]: c === true })} />
                            {label}
                          </label>
                        ))}
                      </div>
                      <FormField label="Guidance" error={err('guidance')} className="sm:col-span-6">
                        {(p) => <Textarea {...p} rows={2} maxLength={1000} value={it.guidance} onChange={(e) => setItem(idx, { guidance: e.target.value })} />}
                      </FormField>
                    </div>
                  </li>
                );
              })}
            </ol>
            <Button variant="outline" className="mt-3" onClick={() => setForm((f) => ({ ...f, items: [...f.items, emptyItem()] }))}>
              <Plus className="h-4 w-4" /> Add item
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
