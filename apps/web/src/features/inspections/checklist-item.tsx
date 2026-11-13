import { useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Camera, FileText, MessageSquareWarning, Paperclip, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { EVIDENCE_REQUIREMENTS, INSPECTION_RESULTS, INSPECTION_RESULT_LABELS, type AttachmentDto, type InspectionReportDto, type InspectionResult, type ReportItemDto } from '@mv/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { multipartBody, openAttachment, precheckFiles, type AttachmentPolicy } from '@/features/complaints/complaint-lib';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { reasonRequired, type ItemValue } from './report-lib';

const RESULT_STYLE: Record<InspectionResult, { on: string; off: string }> = {
  PASS: { on: 'bg-emerald-600 text-white border-emerald-600', off: 'border-slate-300 text-emerald-800 hover:bg-emerald-50' },
  FAIL: { on: 'bg-red-600 text-white border-red-600', off: 'border-slate-300 text-red-700 hover:bg-red-50' },
  NOT_CHECKED: { on: 'bg-amber-500 text-white border-amber-500', off: 'border-slate-300 text-amber-800 hover:bg-amber-50' },
  NOT_APPLICABLE: { on: 'bg-slate-600 text-white border-slate-600', off: 'border-slate-300 text-slate-700 hover:bg-slate-100' },
};

const EVIDENCE_LABEL = Object.fromEntries(EVIDENCE_REQUIREMENTS.map((e) => [e.value, e.label]));

export interface ChecklistItemProps {
  item: ReportItemDto;
  value: ItemValue;
  onChange: (v: ItemValue) => void;
  onBlur?: () => void;
  readOnly: boolean;
  reportId: string;
  policy?: AttachmentPolicy;
  onReportChanged?: (r: InspectionReportDto) => void;
}

/** One checklist line: result, reason (when required), remarks, evidence and inline issues. */
export function ChecklistItem({ item, value, onChange, onBlur, readOnly, reportId, policy, onReportChanged }: ChecklistItemProps) {
  const groupId = useId();
  const needReason = reasonRequired(item, value.result);
  return (
    <div id={`item-${item.key}`} className={cn('scroll-mt-24 rounded-xl border bg-white p-4', (item.issues.length && !readOnly) || item.feedback ? 'border-amber-300' : 'border-border')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-navy-900" id={`${groupId}-label`}>
            {item.description}
          </p>
          <p className="mt-0.5 font-mono text-xs text-slate-400">{item.key}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          {item.required && <Badge tone="primary">Required</Badge>}
          {item.evidence !== 'NONE' && (
            <Badge tone="info">
              <Camera className="h-3 w-3" aria-hidden /> {EVIDENCE_LABEL[item.evidence]}
            </Badge>
          )}
          {item.evidenceOnFail && <Badge tone="warning">Evidence if failed</Badge>}
        </div>
      </div>
      {item.feedback && (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid={`feedback-${item.key}`}>
          <MessageSquareWarning className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <span className="font-medium">Reviewer feedback:</span> {item.feedback}
          </span>
        </p>
      )}
      {item.guidance && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-royal-700">Guidance</summary>
          <p className="mt-1 whitespace-pre-line text-slate-600">{item.guidance}</p>
        </details>
      )}

      <div role="radiogroup" aria-labelledby={`${groupId}-label`} className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {INSPECTION_RESULTS.map((r) => {
          const on = value.result === r;
          return (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={readOnly}
              onClick={() => onChange({ ...value, result: on && !item.required ? null : r })}
              className={cn('min-h-12 rounded-lg border px-2 text-sm font-semibold transition-colors disabled:cursor-default', on ? RESULT_STYLE[r].on : RESULT_STYLE[r].off, readOnly && !on && 'opacity-50')}
            >
              {INSPECTION_RESULT_LABELS[r]}
            </button>
          );
        })}
      </div>

      {needReason && (
        <div className="mt-3">
          <label htmlFor={`${groupId}-reason`} className="field-label">
            Reason {value.result === 'NOT_CHECKED' ? 'not checked' : 'not applicable'}
            <span className="ml-0.5 text-red-600">*</span>
          </label>
          <Textarea id={`${groupId}-reason`} rows={2} maxLength={1000} disabled={readOnly} value={value.reason} onChange={(e) => onChange({ ...value, reason: e.target.value })} onBlur={onBlur} />
        </div>
      )}
      <div className="mt-3">
        <label htmlFor={`${groupId}-remarks`} className="field-label">
          Remarks
        </label>
        <Textarea id={`${groupId}-remarks`} rows={2} maxLength={2000} disabled={readOnly} value={value.remarks} onChange={(e) => onChange({ ...value, remarks: e.target.value })} onBlur={onBlur} />
      </div>

      <Evidence item={item} readOnly={readOnly} reportId={reportId} policy={policy} onReportChanged={onReportChanged} />

      {!readOnly && item.issues.length > 0 && (
        <ul className="mt-3 space-y-1" aria-label="Problems with this item">
          {item.issues.map((i) => (
            <li key={i} className="flex items-start gap-1.5 text-sm text-amber-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {i}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Evidence thumbnail: images preview via a short-lived signed URL; click opens full size / downloads. */
export function Thumb({ a }: { a: AttachmentDto }) {
  const isImage = a.mimeType.startsWith('image/') && a.mimeType !== 'image/heic' && a.mimeType !== 'image/heif';
  const q = useQuery({
    queryKey: ['file-url', a.id],
    queryFn: async () => (await api.get<{ url: string }>(`/files/${a.id}/url`, { params: { inline: 'true' } })).data.url,
    enabled: isImage,
    staleTime: 4 * 60_000, // signed URLs live 5 minutes
  });
  return (
    <button type="button" onClick={() => openAttachment(a.id, true).catch((e) => toast.error(errorMessage(e)))} className="block h-16 w-16 overflow-hidden rounded-md border border-border bg-slate-50" title={a.originalName}>
      {isImage && q.data ? (
        <img src={q.data} alt={a.originalName} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-slate-400">
          <FileText className="h-6 w-6" aria-hidden />
          <span className="sr-only">{a.originalName}</span>
        </span>
      )}
    </button>
  );
}

function Evidence({ item, readOnly, reportId, policy, onReportChanged }: { item: ReportItemDto; readOnly: boolean; reportId: string; policy?: AttachmentPolicy; onReportChanged?: (r: InspectionReportDto) => void }) {
  const photoRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<AttachmentDto | null>(null);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    let files = Array.from(list);
    if (policy) {
      // Count limit is not applied per report item (server enforces size/type); keep the other checks.
      const { accepted, errors } = precheckFiles(files, { ...policy, maxFilesPerRecord: 1000 });
      errors.forEach((e) => toast.error(e));
      files = accepted;
    }
    if (!files.length) return;
    setBusy(true);
    try {
      const res = await api.post<InspectionReportDto>(`/inspection-reports/${reportId}/attachments`, multipartBody({ itemKey: item.key }, files));
      onReportChanged?.(res.data);
      toast.success(files.length === 1 ? 'Evidence uploaded' : `${files.length} files uploaded`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      if (photoRef.current) photoRef.current.value = '';
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (reason: string) => {
    try {
      const res = await api.delete<InspectionReportDto>(`/inspection-reports/${reportId}/attachments/${removing!.id}`, { data: { reason } });
      onReportChanged?.(res.data);
      toast.success('Evidence removed');
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  };

  const accept = policy ? policy.allowedExtensions.map((e) => `.${e}`).join(',') : 'image/*,application/pdf';
  if (readOnly && !item.attachments.length) return null;
  return (
    <div className="mt-3">
      <p className="field-label">Evidence</p>
      <div className="flex flex-wrap items-center gap-2">
        {item.attachments.map((a) => (
          <div key={a.id} className="relative">
            <Thumb a={a} />
            {!readOnly && (
              <button type="button" onClick={() => setRemoving(a)} className="absolute -right-2 -top-2 rounded-full bg-white p-1 text-red-600 shadow ring-1 ring-red-200" aria-label={`Remove ${a.originalName}`}>
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
        {!readOnly && (
          <>
            <input ref={photoRef} type="file" accept="image/*" capture="environment" multiple className="sr-only" aria-label={`Take photo for ${item.key}`} onChange={(e) => upload(e.target.files)} />
            <input ref={fileRef} type="file" accept={accept} multiple className="sr-only" aria-label={`Attach file for ${item.key}`} onChange={(e) => upload(e.target.files)} />
            <Button variant="outline" size="sm" className="h-11" loading={busy} onClick={() => photoRef.current?.click()}>
              <Camera className="h-4 w-4" /> Photo
            </Button>
            <Button variant="outline" size="sm" className="h-11" disabled={busy} onClick={() => fileRef.current?.click()}>
              <Paperclip className="h-4 w-4" /> File
            </Button>
          </>
        )}
      </div>
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.originalName ?? 'file'}?`}
        description="The file is kept on record but no longer counts as evidence."
        confirmLabel="Remove"
        tone="danger"
        reason="required"
        onConfirm={remove}
      />
    </div>
  );
}
