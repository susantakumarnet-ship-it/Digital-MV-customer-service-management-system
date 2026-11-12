import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, Info } from 'lucide-react';
import { loginSchema, type LoginInput } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { FormField, Input } from '@/components/ui/form';
import { parseApiError } from '@/lib/api';
import { AuthLayout } from './auth-layout';
import { useAuth } from './auth-context';

function safeNext(next: string | null) {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function LoginPage() {
  const { status, login, completeMfa } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [challenge, setChallenge] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const reason = params.get('reason');
  const next = safeNext(params.get('next'));

  const form = useForm<LoginInput>({ resolver: zodResolver(loginSchema), defaultValues: { identifier: '', password: '' } });
  const mfaForm = useForm<{ code: string }>({ defaultValues: { code: '' } });

  if (status === 'authenticated') return <Navigate to={next} replace />;

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      const res = await login(values.identifier, values.password);
      if (res.mfaChallenge) setChallenge(res.mfaChallenge);
      else navigate(next, { replace: true });
    } catch (err) {
      const e = parseApiError(err);
      setFormError(e.code === 'RATE_LIMITED' ? 'Too many sign-in attempts. Please wait a few minutes and try again.' : e.message);
    }
  });

  const onMfa = mfaForm.handleSubmit(async ({ code }) => {
    setFormError(null);
    if (!code.trim() || code.trim().length < 6) {
      mfaForm.setError('code', { message: 'Enter the 6-digit code or a recovery code' });
      return;
    }
    try {
      await completeMfa(challenge!, code.trim());
      navigate(next, { replace: true });
    } catch (err) {
      const e = parseApiError(err);
      if (e.code === 'MFA_CHALLENGE_EXPIRED') {
        setChallenge(null);
        form.reset({ identifier: form.getValues('identifier'), password: '' });
      }
      setFormError(e.message);
    }
  });

  if (challenge) {
    return (
      <AuthLayout title="Two-step verification" subtitle="Enter the 6-digit code from your authenticator app, or one of your recovery codes.">
        <form onSubmit={onMfa} noValidate className="space-y-4">
          {formError && <ErrorBanner message={formError} />}
          <FormField label="Verification code" error={mfaForm.formState.errors.code?.message} required>
            {(p) => (
              <Input
                {...p}
                autoFocus
                inputMode="text"
                autoComplete="one-time-code"
                placeholder="123456"
                {...mfaForm.register('code')}
              />
            )}
          </FormField>
          <Button type="submit" className="w-full" loading={mfaForm.formState.isSubmitting}>
            Verify and sign in
          </Button>
          <button type="button" className="w-full text-sm text-slate-500 hover:text-navy-900" onClick={() => setChallenge(null)}>
            Use a different account
          </button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Sign in" subtitle="Use your work email or username.">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {reason && !formError && (
          <div className="flex gap-2 rounded-lg border border-royal-200 bg-royal-50 p-3 text-sm text-royal-800" role="status">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {reason}
          </div>
        )}
        {formError && <ErrorBanner message={formError} />}
        <FormField label="Email or username" error={form.formState.errors.identifier?.message} required>
          {(p) => <Input {...p} autoFocus autoComplete="username" {...form.register('identifier')} />}
        </FormField>
        <FormField label="Password" error={form.formState.errors.password?.message} required>
          {(p) => <Input {...p} type="password" autoComplete="current-password" {...form.register('password')} />}
        </FormField>
        <div className="flex justify-end">
          <Link to="/forgot-password" className="text-sm font-medium text-royal-700 hover:underline">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
          Sign in
        </Button>
      </form>
      <p className="mt-8 text-center text-xs text-slate-500">
        Need to report a problem without an account?{' '}
        <Link to="/report" className="font-medium text-royal-700 hover:underline">
          Submit a complaint online
        </Link>
      </p>
    </AuthLayout>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </div>
  );
}
