import { useEffect, useState } from 'react';
import { CheckCircle2, Trash2, Undo2 } from 'lucide-react';
import type { ReportItemDto } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/form';
import { approvalStep } from './review-lib';

/** Approve (D-29: comments optional). With multi-level approval explains which level is recorded. */
export function ApproveDialog({
  open,
  onOpenChange,
  levels,
  approvalsSoFar,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  levels: number;
  approvalsSoFar: number;
  onConfirm: (comments: string) => Promise<unknown>;
}) {
  const [comments, setComments] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setComments('');
  }, [open]);
  const step = approvalStep(levels, approvalsSoFar);
  const submit = async () => {
    setBusy(true);
    try {
      await onConfirm(comments.trim());
      onOpenChange(false);
    } catch {
      // caller toasts the error; keep the dialog open
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Approve this report?"
        description={step.final ? 'The approved revision becomes permanent and cannot be changed.' : undefined}
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="accent" onClick={submit} loading={busy}>
              <CheckCircle2 className="h-4 w-4" /> {step.final ? 'Approve' : `Approve level ${step.level}`}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {levels > 1 && !step.final && (
            <p className="rounded-lg border border-royal-200 bg-royal-50 px-3 py-2 text-sm text-royal-800" data-testid="level-message">
              This records level {step.level} of {step.levels} approval; another reviewer must approve level {step.level + 1}.
            </p>
          )}
          {levels > 1 && step.final && (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              This is the final approval (level {step.level} of {step.levels}).
            </p>
          )}
          <div>
            <label htmlFor="approve-comments" className="field-label">
              Comments (optional)
            </label>
            <Textarea id="approve-comments" rows={3} maxLength={4000} value={comments} onChange={(e) => setComments(e.target.value)} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Return for correction: overall comments are mandatory; item feedback collected in the workspace is listed and editable. */
export function ReturnDialog({
  open,
  onOpenChange,
  items,
  feedback,
  onFeedbackChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  items: Pick<ReportItemDto, 'key' | 'description'>[];
  feedback: Record<string, string>;
  onFeedbackChange: (key: string, comment: string) => void;
  onConfirm: (comments: string) => Promise<unknown>;
}) {
  const [comments, setComments] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setComments('');
      setTouched(false);
    }
  }, [open]);
  const entries = items.filter((i) => feedback[i.key]?.trim());
  const missing = !comments.trim();
  const submit = async () => {
    setTouched(true);
    if (missing) return;
    setBusy(true);
    try {
      await onConfirm(comments.trim());
      onOpenChange(false);
    } catch {
      // caller toasts the error
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Return for correction?"
        description="A new revision will be created for the engineers. This revision stays in the history."
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" onClick={submit} loading={busy}>
              <Undo2 className="h-4 w-4" /> Return for correction
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label htmlFor="return-comments" className="field-label">
              What must be corrected? <span className="text-red-600">*</span>
            </label>
            <Textarea
              id="return-comments"
              rows={4}
              maxLength={4000}
              value={comments}
              aria-invalid={touched && missing ? true : undefined}
              aria-describedby={touched && missing ? 'return-comments-error' : undefined}
              onChange={(e) => setComments(e.target.value)}
            />
            {touched && missing && (
              <p id="return-comments-error" className="mt-1 text-xs text-red-600" role="alert">
                Explain what must be corrected
              </p>
            )}
          </div>
          <div>
            <p className="field-label">Item feedback ({entries.length})</p>
            {entries.length === 0 ? (
              <p className="text-sm text-slate-500">No item feedback added. Use "Add feedback" on checklist items to point engineers at specific lines.</p>
            ) : (
              <ul className="space-y-3" aria-label="Item feedback">
                {entries.map((i) => (
                  <li key={i.key} className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                    <div className="mb-1 flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-navy-900">
                        {i.description} <span className="font-mono text-xs text-slate-500">{i.key}</span>
                      </p>
                      <Button variant="ghost" size="icon" aria-label={`Remove feedback for ${i.key}`} onClick={() => onFeedbackChange(i.key, '')}>
                        <Trash2 className="h-4 w-4 text-red-600" />
                      </Button>
                    </div>
                    <Textarea aria-label={`Feedback for ${i.key}`} rows={2} maxLength={2000} value={feedback[i.key]} onChange={(e) => onFeedbackChange(i.key, e.target.value)} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
