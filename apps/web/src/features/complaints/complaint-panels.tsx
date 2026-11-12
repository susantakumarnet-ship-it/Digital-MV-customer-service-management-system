import { useEffect, useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download, Lock, MessageSquare, Paperclip, StickyNote } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { classificationSchema, complaintUpdateSchema, type ComplaintDetailDto, type Paged } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/controls';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FormField, Input, Select, Textarea } from '@/components/ui/form';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/states';
import { JsonView } from '@/components/json-view';
import { api, applyFieldErrors, errorMessage } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/format';
import { usePublicSettings } from '@/lib/queries';
import { cn, humanize } from '@/lib/utils';
import { FilePicker, LocationFields, type LocationValue } from './complaint-fields';
import { formatBytes, multipartBody, openAttachment, useLookup } from './complaint-lib';

type Detail = ComplaintDetailDto;
type OnChanged = (c: Detail) => void;

// ---- Classification (CMP-03) --------------------------------------------------------------------

type ClassIn = z.input<typeof classificationSchema>;
type ClassOut = z.output<typeof classificationSchema>;

export function ClassificationPanel({ complaint, onChanged }: { complaint: Detail; onChanged: OnChanged }) {
  const requestTypes = useLookup('masters', 'requestTypes');
  const priorities = useLookup('masters', 'priorities');
  const equipment = useLookup('masters', 'equipmentTypes');
  const assets = useLookup('masters', 'assets', { parentField: 'siteId', parentId: complaint.site?.id });
  const reviewers = useQuery({
    queryKey: ['complaints', 'reviewers'],
    queryFn: async () => (await api.get<{ id: string; name: string; email: string }[]>('/complaints/reviewers')).data,
    staleTime: 60_000,
  });

  const defaults = (): ClassIn => ({
    requestTypeId: complaint.requestType?.id ?? '',
    priorityId: complaint.priority?.id ?? complaint.suggestedPriority?.id ?? '',
    category: complaint.category ?? '',
    supervisorId: complaint.supervisor?.id ?? '',
    equipmentTypeId: complaint.equipmentType?.id ?? '',
    assetId: complaint.asset?.id ?? '',
    notes: complaint.classification?.notes ?? '',
  });
  const form = useForm<ClassIn, unknown, ClassOut>({
    resolver: zodResolver(classificationSchema) as unknown as Resolver<ClassIn, unknown, ClassOut>,
    defaultValues: defaults(),
  });
  useEffect(() => {
    form.reset(defaults());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [complaint.id, complaint.updatedAt]);

  const save = useMutation({
    mutationFn: async (v: ClassOut) => (await api.put<Detail>(`/complaints/${complaint.id}/classification`, v)).data,
    onSuccess: (d) => {
      onChanged(d);
      toast.success(d.dueAt ? `Classified. Due ${formatDateTime(d.dueAt)}` : 'Classified');
    },
    onError: (err) => {
      if (!applyFieldErrors(err, form.setError)) toast.error(errorMessage(err));
    },
  });
  const e = form.formState.errors;
  const assetId = form.watch('assetId');
  const selectedAsset = assets.data?.find((a) => a.id === assetId);

  return (
    <Card>
      <CardHeader
        title="Review & classification"
        description={
          complaint.classification
            ? `Classified by ${complaint.classification.classifiedByName ?? '—'} ${timeAgo(complaint.classification.classifiedAt)}`
            : 'Not yet classified. Saving starts the review and sets the SLA due date from the priority.'
        }
      />
      <CardBody>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Request type" required error={e.requestTypeId?.message}>
            {(p) => (
              <Select {...p} {...form.register('requestTypeId')}>
                <option value="">Select…</option>
                {requestTypes.data?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Priority" required error={e.priorityId?.message} help={complaint.suggestedPriority ? `Customer suggested: ${complaint.suggestedPriority.name}` : undefined}>
            {(p) => (
              <Select {...p} {...form.register('priorityId')}>
                <option value="">Select…</option>
                {priorities.data?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Category" error={e.category?.message} help="Optional free-text classification.">
            {(p) => <Input {...p} maxLength={120} {...form.register('category')} />}
          </FormField>
          <FormField label="Supervisor" error={e.supervisorId?.message} help="Defaults to you.">
            {(p) => (
              <Select {...p} {...form.register('supervisorId')}>
                <option value="">Me</option>
                {reviewers.data?.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Asset" error={e.assetId?.message}>
            {(p) => (
              <Select
                {...p}
                {...form.register('assetId', {
                  onChange: (ev) => {
                    const a = assets.data?.find((x) => x.id === ev.target.value);
                    if (a?.equipmentTypeId) form.setValue('equipmentTypeId', a.equipmentTypeId);
                  },
                })}
              >
                <option value="">Not specified</option>
                {assets.data?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label} ({o.code})
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Equipment type" error={e.equipmentTypeId?.message}>
            {(p) => (
              <Select {...p} disabled={Boolean(selectedAsset)} {...form.register('equipmentTypeId')}>
                <option value="">Not specified</option>
                {equipment.data?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Review notes (internal)" error={e.notes?.message} className="sm:col-span-2">
            {(p) => <Textarea {...p} rows={2} maxLength={2000} {...form.register('notes')} />}
          </FormField>
          <div className="flex items-center justify-between gap-2 sm:col-span-2">
            <span className="text-sm text-slate-500">{complaint.dueAt ? `Current due date: ${formatDateTime(complaint.dueAt)}` : 'No due date yet'}</span>
            <Button type="submit" variant="secondary" loading={save.isPending}>
              {complaint.classification ? 'Update classification' : 'Classify & start review'}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

// ---- Edit intake ---------------------------------------------------------------------------------

type UpdIn = z.input<typeof complaintUpdateSchema>;

export function EditIntakeDialog({ complaint, open, onOpenChange, onChanged }: { complaint: Detail; open: boolean; onOpenChange: (o: boolean) => void; onChanged: OnChanged }) {
  const [changeSite, setChangeSite] = useState(false);
  const [loc, setLoc] = useState<LocationValue>({});
  const form = useForm<UpdIn>({
    resolver: zodResolver(complaintUpdateSchema) as unknown as Resolver<UpdIn>,
  });
  useEffect(() => {
    if (open) {
      form.reset({
        customerName: complaint.customerName,
        organizationName: complaint.organizationName ?? '',
        contactPerson: complaint.contactPerson ?? '',
        mobile: complaint.mobile,
        email: complaint.email,
        description: complaint.description,
        reason: '',
      });
      setChangeSite(false);
      setLoc({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = useMutation({
    mutationFn: async (body: Record<string, unknown>) => (await api.patch<Detail>(`/complaints/${complaint.id}`, body)).data,
    onSuccess: (d) => {
      onChanged(d);
      toast.success('Complaint updated');
      onOpenChange(false);
    },
    onError: (err) => {
      if (!applyFieldErrors(err, form.setError)) toast.error(errorMessage(err));
    },
  });
  const [siteError, setSiteError] = useState<string | undefined>();
  const onSubmit = form.handleSubmit(() => {
    const dirty = form.formState.dirtyFields;
    const raw = form.getValues();
    const body: Record<string, unknown> = {};
    for (const k of Object.keys(dirty) as (keyof UpdIn)[]) if (dirty[k]) body[k] = raw[k];
    if (changeSite) {
      if (!loc.siteId) return setSiteError('Select the new site');
      body.siteId = loc.siteId;
      body.assetId = loc.assetId ?? '';
      body.equipmentTypeId = loc.equipmentTypeId ?? '';
    }
    setSiteError(undefined);
    if (!Object.keys(body).filter((k) => k !== 'reason').length) {
      toast.info('No changes to save');
      return;
    }
    save.mutate(body);
  });
  const e = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent
        title={`Edit ${complaint.referenceNo}`}
        description="Intake details can be corrected until the complaint is assigned. Changes are audited."
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button onClick={onSubmit} loading={save.isPending}>
              Save changes
            </Button>
          </>
        }
      >
        <form onSubmit={onSubmit} noValidate className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Customer name" error={e.customerName?.message} className="sm:col-span-2">
            {(p) => <Input {...p} {...form.register('customerName')} />}
          </FormField>
          <FormField label="Organization" error={e.organizationName?.message}>
            {(p) => <Input {...p} {...form.register('organizationName')} />}
          </FormField>
          <FormField label="Contact person" error={e.contactPerson?.message}>
            {(p) => <Input {...p} {...form.register('contactPerson')} />}
          </FormField>
          <FormField label="Mobile number" error={e.mobile?.message}>
            {(p) => <Input {...p} type="tel" {...form.register('mobile')} />}
          </FormField>
          <FormField label="Email" error={e.email?.message}>
            {(p) => <Input {...p} type="email" {...form.register('email')} />}
          </FormField>
          <FormField label="Description" error={e.description?.message} className="sm:col-span-2">
            {(p) => <Textarea {...p} rows={4} maxLength={5000} {...form.register('description')} />}
          </FormField>
          <div className="sm:col-span-2">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <Checkbox checked={changeSite} onCheckedChange={(c) => setChangeSite(c === true)} />
              Change site / asset (currently {complaint.site?.name}
              {complaint.asset ? ` · ${complaint.asset.name}` : ''})
            </label>
            {changeSite && (
              <div className="mt-3">
                <LocationFields source="masters" value={loc} onChange={setLoc} errors={{ siteId: siteError }} />
              </div>
            )}
          </div>
          <FormField label="Reason for change" error={e.reason?.message} className="sm:col-span-2" help="Recorded in the audit trail.">
            {(p) => <Input {...p} maxLength={1000} {...form.register('reason')} />}
          </FormField>
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Attachments -----------------------------------------------------------------------------

export function AttachmentsPanel({ complaint, onChanged, isStaff }: { complaint: Detail; onChanged: OnChanged; isStaff: boolean }) {
  const settings = usePublicSettings();
  const [files, setFiles] = useState<File[]>([]);
  const [internal, setInternal] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const existing = { count: complaint.attachments.length, bytes: complaint.attachments.reduce((a, f) => a + f.size, 0) };
  const upload = useMutation({
    mutationFn: async () =>
      (await api.post<Detail>(`/complaints/${complaint.id}/attachments`, multipartBody({ context: isStaff && internal ? 'internal' : 'intake' }, files))).data,
    onSuccess: (d) => {
      onChanged(d);
      setFiles([]);
      setInternal(false);
      toast.success('Files uploaded');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const download = async (id: string) => {
    setOpening(id);
    try {
      await openAttachment(id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setOpening(null);
    }
  };

  return (
    <Card>
      <CardHeader title={`Attachments (${complaint.attachments.length})`} />
      {complaint.attachments.length === 0 ? (
        <EmptyState icon={<Paperclip className="h-6 w-6" />} title="No attachments" />
      ) : (
        <ul className="divide-y divide-border">
          {complaint.attachments.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 px-5 py-2.5 text-sm">
              <Paperclip className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              <span className="min-w-0 flex-1 truncate" title={a.originalName}>
                {a.originalName}
              </span>
              {a.context === 'internal' && (
                <Badge tone="warning">
                  <Lock className="h-3 w-3" aria-hidden /> Internal
                </Badge>
              )}
              {a.context === 'customerResponse' && <Badge tone="info">Customer reply</Badge>}
              <span className="text-xs text-slate-500">
                {formatBytes(a.size)} · {a.uploadedByName ?? '—'} · {formatDateTime(a.uploadedAt)}
              </span>
              <Button variant="ghost" size="sm" onClick={() => download(a.id)} loading={opening === a.id} aria-label={`Download ${a.originalName}`}>
                <Download className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {complaint.permissions.canAttach && (
        <CardBody className="space-y-3 border-t border-border">
          <FilePicker files={files} onChange={setFiles} policy={settings.data?.attachments} existing={existing} label="Add files" disabled={upload.isPending} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            {isStaff ? (
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <Checkbox checked={internal} onCheckedChange={(c) => setInternal(c === true)} />
                Internal (staff only, hidden from the customer)
              </label>
            ) : (
              <span />
            )}
            <Button size="sm" variant="secondary" disabled={!files.length} loading={upload.isPending} onClick={() => upload.mutate()}>
              Upload {files.length ? `(${files.length})` : ''}
            </Button>
          </div>
        </CardBody>
      )}
    </Card>
  );
}

// ---- Customer messages & response --------------------------------------------------------------

export function CustomerMessagesPanel({ complaint, onChanged }: { complaint: Detail; onChanged: OnChanged }) {
  const settings = usePublicSettings();
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | undefined>();
  const respond = useMutation({
    mutationFn: async () => (await api.post<Detail>(`/complaints/${complaint.id}/customer-response`, multipartBody({ message: message.trim() }, files))).data,
    onSuccess: (d) => {
      onChanged(d);
      setMessage('');
      setFiles([]);
      toast.success('Your response has been sent');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const existing = { count: complaint.attachments.length, bytes: complaint.attachments.reduce((a, f) => a + f.size, 0) };

  if (!complaint.customerMessages.length && !complaint.permissions.canRespond) return null;
  return (
    <Card className={cn(complaint.permissions.canRespond && 'ring-2 ring-amber-300')}>
      <CardHeader title="Messages with the customer" description={complaint.permissions.canRespond ? 'Information has been requested from you.' : undefined} />
      {complaint.customerMessages.length > 0 && (
        <ul className="space-y-3 px-5 py-4">
          {complaint.customerMessages.map((m) => (
            <li key={m.id} className={cn('flex', m.direction === 'FROM_CUSTOMER' ? 'justify-end' : 'justify-start')}>
              <div className={cn('max-w-[85%] rounded-lg px-3 py-2 text-sm', m.direction === 'FROM_CUSTOMER' ? 'bg-teal-50 text-teal-900' : 'bg-slate-100 text-slate-800')}>
                <p className="whitespace-pre-line break-words">{m.text}</p>
                <p className="mt-1 text-xs opacity-70">
                  {m.direction === 'FROM_CUSTOMER' ? 'Customer' : 'Service team'}
                  {m.byName ? ` · ${m.byName}` : ''} · {formatDateTime(m.at)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {complaint.permissions.canRespond && (
        <CardBody className="space-y-3 border-t border-border">
          <FormField label="Your response" required error={error}>
            {(p) => <Textarea {...p} rows={4} maxLength={4000} value={message} onChange={(e) => setMessage(e.target.value)} />}
          </FormField>
          <FilePicker files={files} onChange={setFiles} policy={settings.data?.attachments} existing={existing} label="Supporting files (optional)" disabled={respond.isPending} />
          <div className="flex justify-end">
            <Button
              variant="secondary"
              loading={respond.isPending}
              onClick={() => {
                if (message.trim().length < 2) return setError('Please enter your response');
                setError(undefined);
                respond.mutate();
              }}
            >
              <MessageSquare className="h-4 w-4" /> Send response
            </Button>
          </div>
        </CardBody>
      )}
    </Card>
  );
}

// ---- Internal notes --------------------------------------------------------------------------

export function InternalNotesPanel({ complaint, onChanged }: { complaint: Detail; onChanged: OnChanged }) {
  const [text, setText] = useState('');
  const add = useMutation({
    mutationFn: async () => (await api.post<Detail>(`/complaints/${complaint.id}/notes`, { text: text.trim() })).data,
    onSuccess: (d) => {
      onChanged(d);
      setText('');
      toast.success('Note added');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (!complaint.internalNotes) return null;
  return (
    <Card data-testid="internal-notes">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <StickyNote className="h-4 w-4 text-amber-600" aria-hidden /> Internal notes
          </span>
        }
        description="Visible to staff only — never shown to customers."
      />
      {complaint.internalNotes.length === 0 ? (
        <p className="px-5 py-4 text-sm text-slate-500">No notes yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {[...complaint.internalNotes].reverse().map((n) => (
            <li key={n.id} className="px-5 py-3 text-sm">
              <p className="whitespace-pre-line break-words text-slate-800">{n.text}</p>
              <p className="mt-1 text-xs text-slate-500">
                {n.byName} · {formatDateTime(n.at)}
              </p>
            </li>
          ))}
        </ul>
      )}
      {complaint.permissions.canAddNote && (
        <CardBody className="space-y-2 border-t border-border">
          <label htmlFor="new-note" className="field-label">
            Add a note
          </label>
          <Textarea id="new-note" rows={3} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex justify-end">
            <Button size="sm" disabled={!text.trim()} loading={add.isPending} onClick={() => add.mutate()}>
              Add note
            </Button>
          </div>
        </CardBody>
      )}
    </Card>
  );
}

// ---- Status history & activity ------------------------------------------------------------------

export function StatusHistoryPanel({ complaint }: { complaint: Detail }) {
  const items = [...complaint.statusHistory].reverse();
  return (
    <Card>
      <CardHeader title="Status history" />
      <ol className="space-y-4 px-5 py-4">
        {items.map((h, i) => (
          <li key={`${h.at}-${i}`} className="relative pl-6 text-sm">
            <span className={cn('absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full', i === 0 ? 'bg-royal-700' : 'bg-slate-300')} aria-hidden />
            <p className="font-medium text-navy-900">{h.toLabel}</p>
            <p className="text-xs text-slate-500">
              {humanize(h.action)} · {h.byName ?? 'System'} · {formatDateTime(h.at)}
            </p>
            {h.reason && <p className="mt-1 whitespace-pre-line break-words rounded bg-slate-50 px-2 py-1 text-slate-700">{h.reason}</p>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

interface ActivityRow {
  id: string;
  timestamp: string;
  actorName: string;
  action: string;
  reason: string | null;
  before: unknown;
  after: unknown;
}

export function ActivityPanel({ complaintId }: { complaintId: string }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['complaints', complaintId, 'activity', page],
    queryFn: async () => (await api.get<Paged<ActivityRow>>(`/complaints/${complaintId}/activity`, { params: { page, limit: 20 } })).data,
    enabled: open,
  });
  return (
    <Card>
      <button type="button" className="flex w-full items-center justify-between px-5 py-4 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="text-base font-semibold text-navy-900">Audit trail</span>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
      {open &&
        (q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <div className="space-y-2 px-5 pb-4">
            <div className="skeleton h-4" />
            <div className="skeleton h-4" />
          </div>
        ) : !q.data?.data.length ? (
          <p className="px-5 pb-4 text-sm text-slate-500">No audit entries.</p>
        ) : (
          <>
            <ul className="divide-y divide-border border-t border-border">
              {q.data.data.map((r) => (
                <li key={r.id} className="px-5 py-3 text-sm">
                  <p>
                    <span className="font-medium text-navy-900">{r.actorName}</span> <span className="text-slate-600">{humanize(r.action)}</span>
                    <span className="ml-2 text-xs text-slate-500">{formatDateTime(r.timestamp)}</span>
                  </p>
                  {r.reason && <p className="text-xs text-slate-600">Reason: {r.reason}</p>}
                  {(r.before != null || r.after != null) && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-royal-700">Changes</summary>
                      <div className="mt-1 grid grid-cols-1 gap-2 md:grid-cols-2">
                        <JsonView label="Before" value={r.before} />
                        <JsonView label="After" value={r.after} />
                      </div>
                    </details>
                  )}
                </li>
              ))}
            </ul>
            {q.data.meta.pages > 1 && (
              <div className="flex justify-end gap-2 border-t border-border px-5 py-2">
                <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Newer
                </Button>
                <Button size="sm" variant="outline" disabled={page >= q.data.meta.pages} onClick={() => setPage((p) => p + 1)}>
                  Older
                </Button>
              </div>
            )}
          </>
        ))}
    </Card>
  );
}
