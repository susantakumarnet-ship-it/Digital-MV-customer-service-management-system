import { useEffect, useId, useState, type ReactNode } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Button } from './ui/button';
import { Textarea } from './ui/form';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  tone?: 'primary' | 'danger';
  /** When set, a reason textarea is shown; 'required' blocks confirmation until text is entered. */
  reason?: 'required' | 'optional';
  reasonLabel?: string;
  /** May throw; the dialog stays open and the caller shows the error. */
  onConfirm: (reason: string) => Promise<unknown> | unknown;
  children?: ReactNode;
}

/** Confirmation for high-impact actions (HO §6.1), with optional mandatory reason. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  tone = 'primary',
  reason,
  reasonLabel = 'Reason',
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const id = useId();

  useEffect(() => {
    if (open) {
      setText('');
      setTouched(false);
      setBusy(false);
    }
  }, [open]);

  const missing = reason === 'required' && !text.trim();

  const confirm = async () => {
    setTouched(true);
    if (missing) return;
    setBusy(true);
    try {
      await onConfirm(text.trim());
      onOpenChange(false);
    } catch {
      // Caller reports the error; keep dialog open so the user can retry or cancel.
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-navy-950/50 animate-fade-in" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-2xl animate-fade-in focus:outline-none">
          <AlertDialog.Title className="text-base font-semibold text-navy-900">{title}</AlertDialog.Title>
          {description ? (
            <AlertDialog.Description className="mt-2 text-sm text-slate-600">{description}</AlertDialog.Description>
          ) : (
            <AlertDialog.Description className="sr-only">{title}</AlertDialog.Description>
          )}
          {children && <div className="mt-3">{children}</div>}
          {reason && (
            <div className="mt-4">
              <label htmlFor={id} className="field-label">
                {reasonLabel}
                {reason === 'required' && <span className="ml-0.5 text-red-600">*</span>}
              </label>
              <Textarea
                id={id}
                value={text}
                maxLength={1000}
                onChange={(e) => setText(e.target.value)}
                aria-invalid={touched && missing ? true : undefined}
              />
              {touched && missing && (
                <p className="mt-1 text-xs text-red-600" role="alert">
                  A reason is required
                </p>
              )}
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="outline" disabled={busy}>
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy} onClick={confirm}>
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
