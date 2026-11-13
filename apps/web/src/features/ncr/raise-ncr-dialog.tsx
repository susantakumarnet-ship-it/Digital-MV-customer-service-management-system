import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { NcrDetailDto } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FormField, Input, Select, Textarea } from '@/components/ui/form';
import { useAuth } from '@/features/auth/auth-context';
import { FilePicker } from '@/features/complaints/complaint-fields';
import { multipartBody } from '@/features/complaints/complaint-lib';
import { api, errorMessage, parseApiError } from '@/lib/api';
import { usePublicSettings } from '@/lib/queries';
import { dateInputToIso, useNcrLists, useOwnerCandidates, validateRaise, type RaiseDraft } from './ncr-lib';

export interface RaiseNcrContext {
  complaintId: string;
  complaintRef?: string;
  workOrderId?: string;
  workOrderNo?: string;
  inspectionReportId?: string;
  itemKey?: string;
  itemDescription?: string;
  assetId?: string;
}

const EMPTY: RaiseDraft = { category: '', severity: '', title: '', description: '', ownerId: '', dueAt: '' };

/** NCR-01: raise an NCR against a complaint (optionally a work order / failed checklist item) with evidence. */
export function RaiseNcrDialog({
  open,
  onOpenChange,
  context,
  navigateOnCreate = true,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  context: RaiseNcrContext;
  navigateOnCreate?: boolean;
  onCreated?: (n: NcrDetailDto) => void;
}) {
  const { hasPermission } = useAuth();
  const canAssign = hasPermission('ncr.assign');
  const lists = useNcrLists();
  const owners = useOwnerCandidates(open && canAssign, context.complaintId);
  const settings = usePublicSettings();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [d, setD] = useState<RaiseDraft>(EMPTY);
  const [files, setFiles] = useState<File[]>([]);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      setD({ ...EMPTY, title: context.itemDescription ? `Failed: ${context.itemDescription}`.slice(0, 150) : '' });
      setFiles([]);
      setTouched(false);
      setServerErrors({});
    }
  }, [open, context.itemDescription]);

  const errors = { ...validateRaise(d), ...serverErrors } as Record<string, string | undefined>;
  const show = (k: keyof RaiseDraft) => (touched || serverErrors[k] ? errors[k] : undefined);
  const set = (k: keyof RaiseDraft, v: string) => {
    setD((x) => ({ ...x, [k]: v }));
    if (serverErrors[k]) setServerErrors(({ [k]: _drop, ...rest }) => rest);
  };

  const submit = async () => {
    setTouched(true);
    if (Object.keys(validateRaise(d)).length) return;
    setBusy(true);
    try {
      const payload = {
        complaintId: context.complaintId,
        workOrderId: context.workOrderId,
        inspectionReportId: context.inspectionReportId,
        itemKey: context.itemKey,
        assetId: context.assetId,
        category: d.category,
        severity: d.severity,
        title: d.title.trim(),
        description: d.description.trim(),
        ownerId: canAssign && d.ownerId ? d.ownerId : undefined,
        dueAt: dateInputToIso(d.dueAt),
      };
      const { data } = await api.post<NcrDetailDto>('/ncrs', multipartBody(payload, files));
      void qc.invalidateQueries({ queryKey: ['ncrs'] });
      void qc.invalidateQueries({ queryKey: ['reviews', 'context'] });
      toast.success(`${data.ncrNo} raised`);
      onCreated?.(data);
      onOpenChange(false);
      if (navigateOnCreate) navigate(`/ncrs/${data.id}`);
    } catch (err) {
      const e = parseApiError(err);
      if (e.fields) setServerErrors(e.fields);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const linked = [context.complaintRef && `Complaint ${context.complaintRef}`, context.workOrderNo && `work order ${context.workOrderNo}`, context.itemKey && `checklist item ${context.itemKey}`]
    .filter(Boolean)
    .join(' · ');

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        title="Raise non-conformance report"
        description={linked || undefined}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy}>
              Raise NCR
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Category" required error={show('category')}>
            {(p) => (
              <Select {...p} value={d.category} onChange={(e) => set('category', e.target.value)}>
                <option value="">Select…</option>
                {lists.categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Severity" required error={show('severity')}>
            {(p) => (
              <Select {...p} value={d.severity} onChange={(e) => set('severity', e.target.value)}>
                <option value="">Select…</option>
                {lists.severities.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Title" required error={show('title')} className="sm:col-span-2">
            {(p) => <Input {...p} maxLength={150} value={d.title} onChange={(e) => set('title', e.target.value)} />}
          </FormField>
          <FormField label="Description" required error={show('description')} className="sm:col-span-2" help="What was found, where, and why it does not conform.">
            {(p) => <Textarea {...p} rows={4} maxLength={4000} value={d.description} onChange={(e) => set('description', e.target.value)} />}
          </FormField>
          {canAssign && (
            <FormField label="Owner (optional)" error={show('ownerId')} help="Leave empty to assign later.">
              {(p) => (
                <Select {...p} value={d.ownerId} onChange={(e) => set('ownerId', e.target.value)} disabled={owners.loading}>
                  <option value="">Assign later</option>
                  {owners.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          )}
          <FormField label="Due date (optional)" error={show('dueAt')} help="Defaults to the configured NCR due period.">
            {(p) => <Input {...p} type="date" value={d.dueAt} onChange={(e) => set('dueAt', e.target.value)} />}
          </FormField>
          <div className="sm:col-span-2">
            <FilePicker files={files} onChange={setFiles} policy={settings.data?.attachments} label="Evidence (photos or documents)" disabled={busy} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
