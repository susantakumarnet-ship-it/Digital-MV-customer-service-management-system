import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '@/lib/utils';

export const Label = forwardRef<HTMLLabelElement, LabelPrimitive.LabelProps>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn('field-label', className)} {...props} />
));
Label.displayName = 'Label';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn('input-base', className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, rows = 3, ...props }, ref) => (
  <textarea ref={ref} rows={rows} className={cn('input-base resize-y', className)} {...props} />
));
Textarea.displayName = 'Textarea';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <select ref={ref} className={cn('input-base pr-8', className)} {...props}>
    {children}
  </select>
));
Select.displayName = 'Select';

interface FormFieldProps {
  label: string;
  error?: string;
  help?: ReactNode;
  required?: boolean;
  className?: string;
  /** Render prop receives the id and aria attributes to spread on the control. */
  children: (props: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => ReactNode;
}

/** Label + control + help/error text with correct aria wiring. */
export function FormField({ label, error, help, required, className, children }: FormFieldProps) {
  const id = useId();
  const descId = `${id}-desc`;
  return (
    <div className={cn('min-w-0', className)}>
      <Label htmlFor={id}>
        {label}
        {required && (
          <span className="ml-0.5 text-red-600" aria-hidden>
            *
          </span>
        )}
      </Label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': error || help ? descId : undefined })}
      {error ? (
        <p id={descId} className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : help ? (
        <p id={descId} className="mt-1 text-xs text-slate-500">
          {help}
        </p>
      ) : null}
    </div>
  );
}
