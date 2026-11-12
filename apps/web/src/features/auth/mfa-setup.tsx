import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, Download, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/controls';
import { FormField, Input } from '@/components/ui/form';
import { api, parseApiError } from '@/lib/api';
import { downloadBlob } from '@/lib/utils';
import { AuthLayout } from './auth-layout';
import { useAuth } from './auth-context';
import { ErrorBanner } from './login-page';

type Step = 'start' | 'scan' | 'codes';

/** TOTP enrolment wizard: setup → verify → show one-time recovery codes. */
export function MfaSetupWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>('start');
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const begin = async () => {
    setError(null);
    setBusy(true);
    try {
      const { data } = await api.post<{ secret: string; otpauthUrl: string }>('/auth/mfa/setup');
      setSetup(data);
      setStep('scan');
    } catch (err) {
      setError(parseApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setError(null);
    if (!/^\d{6}$/.test(code.trim())) {
      setError('Enter the 6-digit code shown in your authenticator app.');
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post<{ recoveryCodes: string[] }>('/auth/mfa/enable', { code: code.trim() });
      setCodes(data.recoveryCodes);
      setStep('codes');
    } catch (err) {
      const e = parseApiError(err);
      setError(e.fields?.code ?? e.message);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'start') {
    return (
      <div className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <p className="text-sm text-slate-600">
          You will need an authenticator app (for example Microsoft Authenticator, Google Authenticator or 1Password) on your phone.
        </p>
        <Button onClick={begin} loading={busy}>
          <ShieldCheck className="h-4 w-4" /> Start setup
        </Button>
      </div>
    );
  }

  if (step === 'scan' && setup) {
    return (
      <div className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
          <li>Scan this QR code with your authenticator app.</li>
          <li>Enter the 6-digit code the app shows.</li>
        </ol>
        <div className="flex justify-center rounded-lg border border-border bg-white p-4">
          <QRCodeSVG value={setup.otpauthUrl} size={176} aria-label="Authenticator QR code" />
        </div>
        <div>
          <p className="text-xs text-slate-500">Can't scan? Enter this key manually:</p>
          <code className="mt-1 block break-all rounded bg-slate-100 px-2 py-1.5 text-sm tracking-wider">{setup.secret}</code>
        </div>
        <FormField label="6-digit code" required>
          {(p) => (
            <Input
              {...p}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          )}
        </FormField>
        <Button onClick={verify} loading={busy}>
          Verify and enable
        </Button>
      </div>
    );
  }

  const text = codes.join('\n');
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Save these recovery codes somewhere safe. Each can be used once to sign in if you lose your device.{' '}
        <strong>They will not be shown again.</strong>
      </p>
      <ul className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3 font-mono text-sm" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              toast.success('Recovery codes copied');
            } catch {
              toast.error('Copy failed — please download instead');
            }
          }}
        >
          <Copy className="h-4 w-4" /> Copy
        </Button>
        <Button variant="outline" size="sm" onClick={() => downloadBlob(new Blob([text + '\n'], { type: 'text/plain' }), 'mv-csms-recovery-codes.txt')}>
          <Download className="h-4 w-4" /> Download
        </Button>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={saved} onCheckedChange={(v) => setSaved(v === true)} />I have saved my recovery codes
      </label>
      <Button disabled={!saved} onClick={onComplete}>
        Finish
      </Button>
    </div>
  );
}

export function ForcedMfaSetupPage() {
  const { reloadMe, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <AuthLayout title="Set up two-step verification" subtitle="Your role requires multi-factor authentication before you can continue.">
      <MfaSetupWizard
        onComplete={async () => {
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
