import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Info, Pencil, Save, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import type { AttachmentDto, NcrDetailDto } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge, StatusBadge, toneOf } from '@/components/ui/badge';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { FormField, Input, Select, Textarea } from '@/components/ui/form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState, ErrorState } from '@/components/states';
import { useBreadcrumb } from '@/app/breadcrumbs';
import { FilePicker } from '@/features/complaints/complaint-fields';
import { multipartBody } from '@/features/complaints/complaint-lib';
import { Thumb } from '@/features/inspections/checklist-item';
import { api, errorMessage, parseApiError } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { usePublicSettings } from '@/lib/queries';
import { cn, humanize } from '@/lib/utils';
import {
  ACTION_FIELD_LABELS,
  NCR_DANGER_ACTIONS,
  NCR_DISPOSITIONS,
  dateInputToIso,
  dispositionLabel,
  isoToDateInput,
  severityTone,
  useNcr,
  useNcrLists,
  useOwnerCandidates,
  type NcrAction,
} from './ncr-lib';

export function NcrDetailPage() {
  const { id = '' } = useParams();
  const q = useNcr(id);
  useBreadcrumb(q.data?.ncrNo);
  if (q.isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-8 w-48" />
        <div className="skeleton h-56" />
      </div>
    );
  }
  if (q.isError) {
    const status = parseApiError(q.error).status;
    return (
      <Card>
        {status === 404 || status === 400 ? (
          <EmptyState
            title="NCR not found"
            description="It may not exist, or it is outside your data access."
            action={
              <Link to="/ncrs" className="text-sm font-medium text-royal-700 hover:underline">
                Back to NCRs
              </Link>
            }
          />
        ) : (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        )}
      </Card>
    );
  }
  return q.data ? <NcrView n={q.data} /> : null;
}

function useApply() {
  const qc = useQueryClient();
  return (n: NcrDetailDto) => {
    qc.setQueryData(['ncrs', 'detail', n.id], n);
    void qc.invalidateQueries({ queryKey: ['ncrs', 'list'] });
    void qc.invalidateQueries({ queryKey: ['ncrs', 'summary'] });
  };
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-slate-800">{children}</dd>
    </div>
  );
}

export function NcrView({ n }: { n: NcrDetailDto }) {
  const apply = useApply();
  const p = n.permissions;
  const [assignOpen, setAssignOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [active, setActive] = useState<NcrAction | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Verify is only offered when the server says this user may verify (segregation of duties, D-08).
  const actions = n.availableActions.filter((a) => a.action !== 'verify' || p.canVerify);
  const verifyBlocked = n.availableActions.some((a) => a.action === 'verify') && !p.canVerify && p.reasonIfNotVerify;

  const run = async (action: string, text?: string) => {
    try {
      const body = action === 'verify' ? { action, comment: text || undefined } : { action, reason: text || undefined };
      const { data } = await api.post<NcrDetailDto>(`/ncrs/${n.id}/transition`, body);
      apply(data);
      toast.success(`${data.ncrNo}: ${data.statusLabel}`);
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  };

  const click = async (a: NcrAction) => {
    if (a.requiresReason || a.confirm || a.action === 'verify') {
      setActive(a);
      return;
    }
    setBusy(a.action);
    try {
      await run(a.action);
    } catch {
      /* toast shown */
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <Link to="/ncrs" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-navy-900">
          <ArrowLeft className="h-4 w-4" /> NCRs
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-navy-900">
              <span className="font-mono">{n.ncrNo}</span>
              <StatusBadge status={n.status} label={n.statusLabel} tone={toneOf(n.statusTone)} />
              <Badge tone={severityTone(n.severity)}>{n.severity}</Badge>
              {n.overdue && (
                <Badge tone="danger">
                  <AlertTriangle className="h-3 w-3" aria-hidden /> Overdue
                </Badge>
              )}
            </h1>
            <p className="mt-1 text-base text-navy-900">{n.title}</p>
            <p className="mt-1 text-sm text-slate-600">
              {n.category} · raised by {n.raisedBy.name} {formatDateTime(n.createdAt)}
              {n.dueAt ? ` · due ${formatDate(n.dueAt)}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {p.canEditDetails && (
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                <Pencil className="h-4 w-4" /> Edit details
              </Button>
            )}
            {p.canAssign && (
              <Button variant="secondary" size="sm" onClick={() => setAssignOpen(true)}>
                <UserPlus className="h-4 w-4" /> {n.owner ? 'Reassign' : 'Assign owner'}
              </Button>
            )}
          </div>
        </div>
        {actions.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2" aria-label="Workflow actions">
            {actions.map((a) => (
              <Button key={a.action} size="sm" variant={NCR_DANGER_ACTIONS.has(a.action) ? 'outline' : a.action === 'verify' ? 'accent' : 'secondary'} className={cn(NCR_DANGER_ACTIONS.has(a.action) && 'text-red-700')} loading={busy === a.action} onClick={() => click(a)}>
                {a.label}
              </Button>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          <Card>
            <CardHeader title="Non-conformance" />
            <CardBody className="space-y-4">
              <p className="whitespace-pre-line break-words text-sm text-slate-800">{n.description}</p>
              <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Row label="Complaint">
                  <Link to={`/complaints/${n.complaint.id}`} className="font-mono text-royal-700 hover:underline">
                    {n.complaint.referenceNo}
                  </Link>
                </Row>
                <Row label="Work order">
                  {n.workOrder ? (
                    <Link to={`/work-orders/${n.workOrder.id}`} className="font-mono text-royal-700 hover:underline">
                      {n.workOrder.workOrderNo}
                    </Link>
                  ) : (
                    '—'
                  )}
                </Row>
                <Row label="Site">{n.site?.name ?? '—'}</Row>
                <Row label="Asset">{n.asset ? `${n.asset.name}${n.asset.code ? ` (${n.asset.code})` : ''}` : '—'}</Row>
                {n.inspection && (
                  <Row label="Inspection item">
                    <Link to={`/inspection-reports/${n.inspection.reportId}`} className="text-royal-700 hover:underline">
                      {n.inspection.itemDescription ?? 'Inspection report'}
                      {n.inspection.itemKey ? ` (${n.inspection.itemKey})` : ''}
                    </Link>
                  </Row>
                )}
                <Row label="Owner">{n.owner?.name ?? <span className="text-slate-500">Not assigned</span>}</Row>
              </dl>
            </CardBody>
          </Card>

          <ActionsCard n={n} onSaved={apply} />
          <EvidenceCard n={n} kind="evidence" canUpload={p.canUploadEvidence} onChanged={apply} />
          <VerificationCard n={n} onChanged={apply} verifyBlockedReason={verifyBlocked ? p.reasonIfNotVerify : undefined} />
          <CommentsCard n={n} onChanged={apply} />
        </div>
        <div className="min-w-0 space-y-4">
          <RevisionsCard n={n} />
          <Card>
            <CardHeader title="Status history" />
            <CardBody>
              {n.statusHistory.length === 0 ? (
                <p className="text-sm text-slate-500">No status changes yet.</p>
              ) : (
                <ol className="space-y-3 text-sm">
                  {[...n.statusHistory].reverse().map((h, i) => (
                    <li key={`${h.at}-${i}`} className="border-l-2 border-royal-200 pl-3">
                      <p className="font-medium text-navy-900">{h.toLabel}</p>
                      <p className="text-xs text-slate-500">
                        {humanize(h.action)} · {h.byName ?? 'System'} · {formatDateTime(h.at)}
                      </p>
                      {h.reason && <p className="mt-0.5 whitespace-pre-line text-slate-700">{h.reason}</p>}
                    </li>
                  ))}
                </ol>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(active)}
        onOpenChange={(o) => !o && setActive(null)}
        title={active ? `${active.label}?` : ''}
        description={
          active?.action === 'verify'
            ? 'Verifying confirms the corrective action is effective. Verification evidence must already be attached.'
            : active?.action === 'return'
              ? 'The NCR goes back to its owner with your reason.'
              : `NCR ${n.ncrNo}`
        }
        confirmLabel={active?.label ?? 'Confirm'}
        tone={active && NCR_DANGER_ACTIONS.has(active.action) ? 'danger' : 'primary'}
        reason={active?.requiresReason ? 'required' : active?.action === 'verify' ? 'optional' : undefined}
        reasonLabel={active?.action === 'verify' ? 'Verification comment' : 'Reason'}
        onConfirm={(text) => run(active!.action, text)}
      />
      {p.canAssign && <AssignNcrDialog n={n} open={assignOpen} onOpenChange={setAssignOpen} onDone={apply} />}
      {p.canEditDetails && <EditNcrDialog n={n} open={editOpen} onOpenChange={setEditOpen} onDone={apply} />}
    </div>
  );
}

// ---- Owner's actions (NCR-03/04) ----------------------------------------------------------------

type ActionDraft = { containmentAction: string; rootCause: string; correctiveAction: string; disposition: string };
const toDraft = (n: NcrDetailDto): ActionDraft => ({
  containmentAction: n.containmentAction ?? '',
  rootCause: n.rootCause ?? '',
  correctiveAction: n.correctiveAction ?? '',
  disposition: n.disposition ?? '',
});

export function ActionsCard({ n, onSaved }: { n: NcrDetailDto; onSaved: (n: NcrDetailDto) => void }) {
  const editable = n.permissions.canEditActions;
  const [d, setD] = useState<ActionDraft>(() => toDraft(n));
  const [busy, setBusy] = useState(false);
  useEffect(() => setD(toDraft(n)), [n]);
  const dirty = JSON.stringify(d) !== JSON.stringify(toDraft(n));

  const save = async () => {
    setBusy(true);
    try {
      const { data } = await api.put<NcrDetailDto>(`/ncrs/${n.id}/actions`, {
        containmentAction: d.containmentAction.trim(),
        rootCause: d.rootCause.trim(),
        correctiveAction: d.correctiveAction.trim(),
        disposition: d.disposition || undefined,
      });
      onSaved(data);
      toast.success('Actions saved');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const fields: { key: keyof ActionDraft; label: string; help: string }[] = [
    { key: 'containmentAction', label: 'Containment action', help: 'Immediate action taken to contain the problem.' },
    { key: 'rootCause', label: 'Root cause', help: 'Why the non-conformance happened.' },
    { key: 'correctiveAction', label: 'Corrective action', help: 'What was done to fix it and prevent recurrence.' },
  ];

  return (
    <Card>
      <CardHeader
        title="Owner's actions"
        description={editable ? 'Every saved change is kept in the revision history.' : n.owner ? `Recorded by ${n.owner.name}` : 'Assign an owner to record actions.'}
        actions={
          editable ? (
            <Button size="sm" onClick={save} loading={busy} disabled={!dirty}>
              <Save className="h-4 w-4" /> Save actions
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        {editable ? (
          <div className="grid grid-cols-1 gap-4" data-testid="actions-form">
            {fields.map((f) => (
              <FormField key={f.key} label={f.label} help={f.help}>
                {(p) => <Textarea {...p} rows={3} maxLength={4000} value={d[f.key]} onChange={(e) => setD((x) => ({ ...x, [f.key]: e.target.value }))} />}
              </FormField>
            ))}
            <FormField label="Disposition">
              {(p) => (
                <Select {...p} value={d.disposition} onChange={(e) => setD((x) => ({ ...x, disposition: e.target.value }))} className="max-w-xs">
                  <option value="">Select…</option>
                  {NCR_DISPOSITIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <p className="text-xs text-slate-500">All four fields are needed before you can submit for verification.</p>
          </div>
        ) : (
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="actions-readonly">
            {fields.map((f) => (
              <Row key={f.key} label={f.label}>
                <span className="whitespace-pre-line">{n[f.key] || '—'}</span>
              </Row>
            ))}
            <Row label="Disposition">{dispositionLabel(n.disposition)}</Row>
          </dl>
        )}
      </CardBody>
    </Card>
  );
}

// ---- Evidence ------------------------------------------------------------------------------------

function Gallery({ files, empty }: { files: AttachmentDto[]; empty: string }) {
  if (!files.length) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ul className="flex flex-wrap gap-3">
      {files.map((a) => (
        <li key={a.id} className="w-20 text-center">
          <Thumb a={a} />
          <p className="mt-1 truncate text-xs text-slate-600" title={a.originalName}>
            {a.originalName}
          </p>
        </li>
      ))}
    </ul>
  );
}

function UploadRow({ n, kind, onChanged }: { n: NcrDetailDto; kind: 'evidence' | 'verification'; onChanged: (n: NcrDetailDto) => void }) {
  const settings = usePublicSettings();
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const existing = kind === 'evidence' ? n.evidence : n.verificationEvidence;
  const upload = async () => {
    setBusy(true);
    try {
      const { data } = await api.post<NcrDetailDto>(`/ncrs/${n.id}/attachments`, multipartBody({ context: kind }, files));
      onChanged(data);
      setFiles([]);
      toast.success('Files uploaded');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4">
      <FilePicker
        files={files}
        onChange={setFiles}
        policy={settings.data?.attachments}
        existing={{ count: existing.length, bytes: existing.reduce((a, f) => a + f.size, 0) }}
        label={kind === 'verification' ? 'Add verification evidence' : 'Add evidence'}
        disabled={busy}
      />
      <div className="flex justify-end">
        <Button size="sm" variant="secondary" disabled={!files.length} loading={busy} onClick={upload}>
          Upload {files.length ? `(${files.length})` : ''}
        </Button>
      </div>
    </div>
  );
}

function EvidenceCard({ n, kind, canUpload, onChanged }: { n: NcrDetailDto; kind: 'evidence'; canUpload: boolean; onChanged: (n: NcrDetailDto) => void }) {
  return (
    <Card>
      <CardHeader title={`Evidence (${n.evidence.length})`} />
      <CardBody>
        <Gallery files={n.evidence} empty="No evidence attached." />
        {canUpload && <UploadRow n={n} kind={kind} onChanged={onChanged} />}
      </CardBody>
    </Card>
  );
}

export function VerificationCard({ n, onChanged, verifyBlockedReason }: { n: NcrDetailDto; onChanged: (n: NcrDetailDto) => void; verifyBlockedReason?: string }) {
  const p = n.permissions;
  const relevant = n.verification || n.verificationEvidence.length || p.canUploadVerification || verifyBlockedReason || n.status === 'SUBMITTED_FOR_VERIFICATION';
  if (!relevant) return null;
  return (
    <Card>
      <CardHeader title="Verification" description="A reviewer other than the owner verifies the corrective action with evidence." />
      <CardBody className="space-y-3">
        {n.verification && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            <p className="font-medium">
              Verified by {n.verification.byName} · {formatDateTime(n.verification.at)}
            </p>
            {n.verification.comment && <p className="mt-1 whitespace-pre-line">{n.verification.comment}</p>}
          </div>
        )}
        {verifyBlockedReason && (
          <p className="flex items-start gap-2 rounded-lg border border-border bg-slate-50 p-3 text-sm text-slate-700" role="note" data-testid="verify-blocked">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {verifyBlockedReason}
          </p>
        )}
        <Gallery files={n.verificationEvidence} empty="No verification evidence yet." />
        {p.canUploadVerification && <UploadRow n={n} kind="verification" onChanged={onChanged} />}
      </CardBody>
    </Card>
  );
}

// ---- Comments & history --------------------------------------------------------------------------

function CommentsCard({ n, onChanged }: { n: NcrDetailDto; onChanged: (n: NcrDetailDto) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const { data } = await api.post<NcrDetailDto>(`/ncrs/${n.id}/comments`, { text: text.trim() });
      onChanged(data);
      setText('');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader title={`Comments (${n.comments.length})`} />
      <CardBody className="space-y-3">
        {n.comments.length === 0 ? (
          <p className="text-sm text-slate-500">No comments yet.</p>
        ) : (
          <ul className="space-y-3">
            {n.comments.map((c) => (
              <li key={c.id} className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
                <p className="text-xs text-slate-500">
                  {c.byName} · {formatDateTime(c.at)}
                </p>
                <p className="mt-0.5 whitespace-pre-line break-words text-slate-800">{c.text}</p>
              </li>
            ))}
          </ul>
        )}
        {n.permissions.canComment && (
          <div className="space-y-2">
            <label htmlFor="ncr-comment" className="field-label">
              Add a comment
            </label>
            <Textarea id="ncr-comment" rows={2} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="flex justify-end">
              <Button size="sm" variant="secondary" onClick={add} loading={busy} disabled={!text.trim()}>
                Post comment
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function RevisionsCard({ n }: { n: NcrDetailDto }) {
  return (
    <Card>
      <CardHeader title="Revision history" description="Changes to the owner's actions (NCR-04)." />
      <CardBody>
        {n.revisions.length === 0 ? (
          <p className="text-sm text-slate-500">No actions recorded yet.</p>
        ) : (
          <ol className="space-y-3 text-sm">
            {[...n.revisions].reverse().map((r, i) => (
              <li key={`${r.at}-${i}`} className="border-l-2 border-slate-200 pl-3">
                <p className="text-xs text-slate-500">
                  {r.byName} · {formatDateTime(r.at)}
                </p>
                <ul className="mt-1 space-y-1">
                  {Object.entries(r.changes).map(([k, v]) => (
                    <li key={k}>
                      <span className="font-medium text-navy-900">{ACTION_FIELD_LABELS[k] ?? humanize(k)}:</span>{' '}
                      {k === 'disposition' ? dispositionLabel(v.to) : k === 'dueAt' && v.to ? formatDate(v.to) : <span className="whitespace-pre-line">{v.to ?? '—'}</span>}
                      {v.from && k !== 'submitted' && <span className="block text-xs text-slate-500 line-through">{k === 'disposition' ? dispositionLabel(v.from) : k === 'dueAt' ? formatDate(v.from) : v.from}</span>}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}

// ---- Dialogs -------------------------------------------------------------------------------------

function AssignNcrDialog({ n, open, onOpenChange, onDone }: { n: NcrDetailDto; open: boolean; onOpenChange: (o: boolean) => void; onDone: (n: NcrDetailDto) => void }) {
  const owners = useOwnerCandidates(open, n.complaint.id);
  const [ownerId, setOwnerId] = useState('');
  const [due, setDue] = useState('');
  const [comment, setComment] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setOwnerId(n.owner?.id ?? '');
      setDue(isoToDateInput(n.dueAt));
      setComment('');
      setTouched(false);
    }
  }, [open, n]);
  const submit = async () => {
    setTouched(true);
    if (!ownerId) return;
    setBusy(true);
    try {
      const { data } = await api.post<NcrDetailDto>(`/ncrs/${n.id}/assign`, { ownerId, dueAt: dateInputToIso(due), comment: comment.trim() || undefined });
      onDone(data);
      toast.success(`Assigned to ${data.owner?.name ?? 'owner'}`);
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        title={n.owner ? `Reassign ${n.ncrNo}` : `Assign ${n.ncrNo}`}
        description="The owner records containment, root cause and corrective action."
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy}>
              Assign
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <FormField label="Owner" required error={touched && !ownerId ? 'Select an owner' : undefined}>
            {(p) => (
              <Select {...p} value={ownerId} onChange={(e) => setOwnerId(e.target.value)} disabled={owners.loading}>
                <option value="">Select…</option>
                {owners.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Due date">{(p) => <Input {...p} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</FormField>
          <FormField label="Comment (optional)">{(p) => <Textarea {...p} rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />}</FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EditNcrDialog({ n, open, onOpenChange, onDone }: { n: NcrDetailDto; open: boolean; onOpenChange: (o: boolean) => void; onDone: (n: NcrDetailDto) => void }) {
  const lists = useNcrLists();
  const [d, setD] = useState({ category: n.category, severity: n.severity, title: n.title, description: n.description, dueAt: isoToDateInput(n.dueAt), reason: '' });
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      setD({ category: n.category, severity: n.severity, title: n.title, description: n.description, dueAt: isoToDateInput(n.dueAt), reason: '' });
      setFieldErrors({});
    }
  }, [open, n]);
  const local: Record<string, string> = {};
  if (d.title.trim().length < 3) local.title = 'Enter a short title';
  if (d.description.trim().length < 10) local.description = 'Describe the non-conformance';
  const errors = { ...local, ...fieldErrors };
  const submit = async () => {
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      const { data } = await api.patch<NcrDetailDto>(`/ncrs/${n.id}`, {
        category: d.category,
        severity: d.severity,
        title: d.title.trim(),
        description: d.description.trim(),
        dueAt: dateInputToIso(d.dueAt) ?? null,
        reason: d.reason.trim() || undefined,
      });
      onDone(data);
      toast.success('NCR updated');
      onOpenChange(false);
    } catch (err) {
      const e = parseApiError(err);
      if (e.fields) setFieldErrors(e.fields);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const categories = lists.categories.includes(n.category) ? lists.categories : [n.category, ...lists.categories];
  const severities = lists.severities.includes(n.severity) ? lists.severities : [n.severity, ...lists.severities];
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        title={`Edit ${n.ncrNo}`}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy}>
              Save
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Category" error={errors.category}>
            {(p) => (
              <Select {...p} value={d.category} onChange={(e) => setD((x) => ({ ...x, category: e.target.value }))}>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Severity" error={errors.severity}>
            {(p) => (
              <Select {...p} value={d.severity} onChange={(e) => setD((x) => ({ ...x, severity: e.target.value }))}>
                {severities.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Title" required error={errors.title} className="sm:col-span-2">
            {(p) => <Input {...p} maxLength={150} value={d.title} onChange={(e) => setD((x) => ({ ...x, title: e.target.value }))} />}
          </FormField>
          <FormField label="Description" required error={errors.description} className="sm:col-span-2">
            {(p) => <Textarea {...p} rows={4} maxLength={4000} value={d.description} onChange={(e) => setD((x) => ({ ...x, description: e.target.value }))} />}
          </FormField>
          <FormField label="Due date">{(p) => <Input {...p} type="date" value={d.dueAt} onChange={(e) => setD((x) => ({ ...x, dueAt: e.target.value }))} />}</FormField>
          <FormField label="Reason for change (optional)">{(p) => <Input {...p} maxLength={1000} value={d.reason} onChange={(e) => setD((x) => ({ ...x, reason: e.target.value }))} />}</FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}
