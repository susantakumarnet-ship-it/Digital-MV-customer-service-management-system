import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { z } from 'zod';
import { changePasswordSchema, forgotPasswordSchema, resetPasswordSchema } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { FormField, Input } from '@/components/ui/form';
import { api, applyFieldErrors, parseApiError } from '@/lib/api';
import { AuthLayout } from './auth-layout';
import { useAuth } from './auth-context';
import { ErrorBanner } from './login-page';

const PASSWORD_HELP = 'At least 12 characters, with upper-case, lower-case and a number.';

export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof forgotPasswordSchema>>({ resolver: zodResolver(forgotPasswordSchema), defaultValues: { email: '' } });

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await api.post('/auth/forgot-password', v);
      setSent(true);
    } catch (err) {
      const e = parseApiError(err);
      setError(e.code === 'RATE_LIMITED' ? 'Too many requests. Please try again later.' : e.message);
    }
  });

  return (
    <AuthLayout title="Reset your password" subtitle="We will email you a link to set a new password.">
      {sent ? (
        <div className="space-y-4">
          <div className="flex gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800" role="status">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            If an account exists for this email, a reset link has been sent. The link expires after a short time and can be used once.
          </div>
          <Link to="/login" className="block text-center text-sm font-medium text-royal-700 hover:underline">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {error && <ErrorBanner message={error} />}
          <FormField label="Email address" error={form.formState.errors.email?.message} required>
            {(p) => <Input {...p} type="email" autoComplete="email" autoFocus {...form.register('email')} />}
          </FormField>
          <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
            Send reset link
          </Button>
          <Link to="/login" className="block text-center text-sm text-slate-500 hover:text-navy-900">
            Back to sign in
          </Link>
        </form>
      )}
    </AuthLayout>
  );
}

/** Used for both /reset-password and /activate (POST /auth/reset-password). */
export function ResetPasswordPage({ mode }: { mode: 'reset' | 'activate' }) {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  type V = z.infer<typeof resetPasswordSchema>;
  const form = useForm<V>({ resolver: zodResolver(resetPasswordSchema), defaultValues: { token, password: '', confirmPassword: '' } });

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await api.post('/auth/reset-password', v);
      setDone(true);
    } catch (err) {
      if (!applyFieldErrors(err, form.setError, ['password', 'confirmPassword'])) setError(parseApiError(err).message);
    }
  });

  const title = mode === 'activate' ? 'Activate your account' : 'Choose a new password';
  if (!token || token.length < 20) {
    return (
      <AuthLayout title={title}>
        <ErrorBanner message="This link is incomplete or invalid. Please use the link from your email, or request a new one." />
        <Link to="/forgot-password" className="mt-4 block text-center text-sm font-medium text-royal-700 hover:underline">
          Request a new link
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={title} subtitle={mode === 'activate' ? 'Set a password to start using your account.' : undefined}>
      {done ? (
        <div className="space-y-4">
          <div className="flex gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800" role="status">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            Your password has been set. You can now sign in.
          </div>
          <Link to="/login" className="block">
            <Button className="w-full">Go to sign in</Button>
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {error && <ErrorBanner message={error} />}
          <FormField label="New password" error={form.formState.errors.password?.message} help={PASSWORD_HELP} required>
            {(p) => <Input {...p} type="password" autoComplete="new-password" autoFocus {...form.register('password')} />}
          </FormField>
          <FormField label="Confirm password" error={form.formState.errors.confirmPassword?.message} required>
            {(p) => <Input {...p} type="password" autoComplete="new-password" {...form.register('confirmPassword')} />}
          </FormField>
          <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
            {mode === 'activate' ? 'Activate account' : 'Set password'}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

/** Change-password form, used standalone (forced) and inside Profile & Security. */
export function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  type V = z.infer<typeof changePasswordSchema>;
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const form = useForm<V>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    setOk(false);
    try {
      await api.post('/auth/change-password', v);
      form.reset();
      setOk(true);
      onDone?.();
    } catch (err) {
      if (!applyFieldErrors(err, form.setError, ['currentPassword', 'newPassword', 'confirmPassword'])) setError(parseApiError(err).message);
    }
  });
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {error && <ErrorBanner message={error} />}
      {ok && (
        <p className="text-sm text-emerald-700" role="status">
          Password changed. Other devices have been signed out.
        </p>
      )}
      <FormField label="Current password" error={form.formState.errors.currentPassword?.message} required>
        {(p) => <Input {...p} type="password" autoComplete="current-password" {...form.register('currentPassword')} />}
      </FormField>
      <FormField label="New password" error={form.formState.errors.newPassword?.message} help={PASSWORD_HELP} required>
        {(p) => <Input {...p} type="password" autoComplete="new-password" {...form.register('newPassword')} />}
      </FormField>
      <FormField label="Confirm new password" error={form.formState.errors.confirmPassword?.message} required>
        {(p) => <Input {...p} type="password" autoComplete="new-password" {...form.register('confirmPassword')} />}
      </FormField>
      <Button type="submit" loading={form.formState.isSubmitting}>
        Change password
      </Button>
    </form>
  );
}

export function ForcedChangePasswordPage() {
  const { reloadMe, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <AuthLayout title="Change your password" subtitle="You must set a new password before continuing.">
      <ChangePasswordForm
        onDone={async () => {
          await reloadMe();
          navigate('/', { replace: true });
        }}
      />
      <button type="button" onClick={() => logout()} className="mt-6 w-full text-sm text-slate-500 hover:text-navy-900">
        Sign out
      </button>
    </AuthLayout>
  );
}
