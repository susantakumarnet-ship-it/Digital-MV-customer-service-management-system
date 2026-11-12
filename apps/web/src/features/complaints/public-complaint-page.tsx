import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ChevronLeft, ChevronRight, Copy, Info } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { publicComplaintSchema, type PublicSubmissionResult } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/controls';
import { FormField, Input, Select, Textarea } from '@/components/ui/form';
import { ErrorState } from '@/components/states';
import { BrandMark } from '@/features/auth/auth-layout';
import { ErrorBanner } from '@/features/auth/login-page';
import { api, parseApiError } from '@/lib/api';
import { formatDateTime, getDisplayTimezone } from '@/lib/format';
import { usePublicSettings } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { FilePicker, LocationFields } from './complaint-fields';
import { multipartBody, newIdempotencyKey, useLookup, type PublicFormBootstrap } from './complaint-lib';
import { Turnstile } from './turnstile';

/** Form schema = public schema minus server/session fields (token, honeypot, captcha, consent version). */
export const publicFormSchema = publicComplaintSchema.omit({ formToken: true, website: true, captchaToken: true, consentVersion: true });
type FormIn = z.input<typeof publicFormSchema>;
type FormOut = z.output<typeof publicFormSchema>;

export const STEPS: { title: string; fields: (keyof FormIn)[] }[] = [
  { title: 'Your details', fields: ['customerName', 'organizationName', 'contactPerson', 'mobile', 'email'] },
  { title: 'Location & asset', fields: ['regionId', 'cityId', 'siteId', 'assetId', 'equipmentTypeId'] },
  { title: 'Your request', fields: ['requestTypeId', 'description', 'suggestedPriorityId'] },
  { title: 'Attachments & consent', fields: ['consentAccepted'] },
  { title: 'Review & submit', fields: [] },
];

const EMPTY: FormIn = {
  customerName: '',
  organizationName: '',
  contactPerson: '',
  mobile: '',
  email: '',
  regionId: '',
  cityId: '',
  siteId: '',
  assetId: '',
  equipmentTypeId: '',
  requestTypeId: '',
  description: '',
  suggestedPriorityId: '',
  consentAccepted: false as unknown as true,
};

export function PublicLayout({ children }: { children: ReactNode }) {
  const { data: settings } = usePublicSettings();
  return (
    <div className="min-h-full bg-surface">
      <header className="border-b border-border bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark />
            <div className="min-w-0">
              <p className="truncate font-semibold text-navy-900">{settings?.applicationName ?? 'Digital MV Customer Service'}</p>
              {settings?.organizationName && <p className="truncate text-xs text-slate-500">{settings.organizationName}</p>}
            </div>
          </div>
          <Link to="/login" className="shrink-0 text-sm font-medium text-royal-700 hover:underline">
            Staff sign in
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">{children}</main>
    </div>
  );
}

export function PublicComplaintPage() {
  const bootstrap = useQuery({
    queryKey: ['public', 'complaint-form'],
    queryFn: async () => (await api.get<PublicFormBootstrap>('/public/complaint-form')).data,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const [result, setResult] = useState<PublicSubmissionResult | null>(null);
  const [formKey, setFormKey] = useState(0);

  const restart = () => {
    setResult(null);
    setFormKey((k) => k + 1);
    void bootstrap.refetch();
  };

  return (
    <PublicLayout>
      {result ? (
        <Confirmation result={result} onAnother={restart} />
      ) : bootstrap.isError ? (
        <Card>
          <ErrorState
            title={parseApiError(bootstrap.error).status === 404 ? 'The online complaint form is currently unavailable' : 'Could not load the form'}
            error={bootstrap.error}
            onRetry={() => bootstrap.refetch()}
          />
        </Card>
      ) : bootstrap.isLoading || !bootstrap.data ? (
        <Card>
          <CardBody className="space-y-3">
            <div className="skeleton h-6 w-1/2" />
            <div className="skeleton h-10" />
            <div className="skeleton h-10" />
          </CardBody>
        </Card>
      ) : (
        <ComplaintWizard key={formKey} boot={bootstrap.data} onRefreshBoot={() => bootstrap.refetch()} onDone={setResult} />
      )}
    </PublicLayout>
  );
}

function ComplaintWizard({
  boot,
  onRefreshBoot,
  onDone,
}: {
  boot: PublicFormBootstrap;
  onRefreshBoot: () => unknown;
  onDone: (r: PublicSubmissionResult) => void;
}) {
  const [step, setStep] = useState(0);
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | undefined>();
  const idempotencyKey = useMemo(() => newIdempotencyKey(), []);
  const honeypot = useRef<HTMLInputElement>(null);

  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(publicFormSchema) as unknown as Resolver<FormIn, unknown, FormOut>,
    defaultValues: EMPTY,
    mode: 'onTouched',
  });
  const v = form.watch();
  const e = form.formState.errors;

  const requestTypes = useLookup('public', 'requestTypes');
  const priorities = useLookup('public', 'priorities');

  const next = async () => {
    const ok = await form.trigger(STEPS[step].fields as never);
    if (ok) setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const back = () => setStep((s) => Math.max(0, s - 1));

  const submit = form.handleSubmit(async (values) => {
    if (submitting) return;
    if (boot.captchaSiteKey && !captchaToken) {
      setFormError('Please complete the human verification check.');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const data = {
        ...values,
        consentVersion: boot.privacyNoticeVersion,
        formToken: boot.formToken,
        website: honeypot.current?.value ?? '',
        captchaToken,
      };
      const res = await api.post<PublicSubmissionResult>('/public/complaints', multipartBody(data, files), {
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      onDone(res.data);
      window.scrollTo?.(0, 0);
    } catch (err) {
      const pe = parseApiError(err);
      if (pe.fields) {
        let firstStep: number | null = null;
        for (const [field, message] of Object.entries(pe.fields)) {
          if (field in EMPTY) form.setError(field as keyof FormIn, { type: 'server', message });
          const idx = STEPS.findIndex((s) => s.fields.includes(field as keyof FormIn));
          if (idx >= 0 && (firstStep === null || idx < firstStep)) firstStep = idx;
        }
        if (firstStep !== null) setStep(firstStep);
        setFormError('Please correct the highlighted fields.');
      } else if (pe.code === 'CONSENT_OUTDATED') {
        form.setValue('consentAccepted', false as unknown as true);
        onRefreshBoot();
        setStep(3);
        setFormError(pe.message);
      } else if (pe.code === 'FORM_TOKEN_INVALID') {
        if (!/too quickly/i.test(pe.message)) onRefreshBoot();
        setFormError(pe.message);
      } else if (pe.status === 429) {
        setFormError('Too many submissions from your network. Please try again later.');
      } else {
        setFormError(pe.message);
      }
    } finally {
      setSubmitting(false);
    }
  });

  const label = (list: { id: string; label: string }[] | undefined, id?: string) => list?.find((o) => o.id === id)?.label ?? '—';

  return (
    <div>
      <h1 className="text-2xl font-semibold text-navy-900">Report a problem</h1>
      <p className="mt-1 text-sm text-slate-500">
        No account needed. Fields marked <span className="text-red-600">*</span> are required. You will receive a reference number when you submit.
      </p>

      <ol className="mt-6 flex gap-1" aria-label="Form progress">
        {STEPS.map((s, i) => (
          <li key={s.title} className="min-w-0 flex-1">
            <div className={cn('h-1.5 rounded-full', i <= step ? 'bg-royal-700' : 'bg-slate-200')} />
            <p className={cn('mt-1 hidden truncate text-xs sm:block', i === step ? 'font-medium text-navy-900' : 'text-slate-500')} aria-current={i === step ? 'step' : undefined}>
              {i + 1}. {s.title}
            </p>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-sm font-medium text-navy-900 sm:hidden">
        Step {step + 1} of {STEPS.length}: {STEPS[step].title}
      </p>

      <Card className="mt-4">
        <form
          noValidate
          onSubmit={(ev) => {
            ev.preventDefault();
            if (step < STEPS.length - 1) void next();
            else void submit();
          }}
        >
          <CardBody className="space-y-4">
            {formError && <ErrorBanner message={formError} />}

            {/* Honeypot (PUB-05): invisible to people and assistive tech; bots tend to fill it. */}
            <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', top: 'auto', width: 1, height: 1, overflow: 'hidden' }}>
              <label htmlFor="hp-website">Website</label>
              <input id="hp-website" ref={honeypot} type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
            </div>

            {step === 0 && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField label="Customer name" required error={e.customerName?.message} className="sm:col-span-2">
                  {(p) => <Input {...p} autoComplete="name" {...form.register('customerName')} />}
                </FormField>
                <FormField label="Organization" error={e.organizationName?.message}>
                  {(p) => <Input {...p} autoComplete="organization" {...form.register('organizationName')} />}
                </FormField>
                <FormField label="Contact person" error={e.contactPerson?.message} help="If different from the customer name.">
                  {(p) => <Input {...p} {...form.register('contactPerson')} />}
                </FormField>
                <FormField label="Mobile number" required error={e.mobile?.message}>
                  {(p) => <Input {...p} type="tel" autoComplete="tel" inputMode="tel" {...form.register('mobile')} />}
                </FormField>
                <FormField label="Email address" required error={e.email?.message}>
                  {(p) => <Input {...p} type="email" autoComplete="email" {...form.register('email')} />}
                </FormField>
              </div>
            )}

            {step === 1 && (
              <LocationFields
                source="public"
                value={{ regionId: v.regionId, cityId: v.cityId, siteId: v.siteId, assetId: v.assetId || undefined, equipmentTypeId: v.equipmentTypeId || undefined }}
                onChange={(loc) => {
                  for (const k of ['regionId', 'cityId', 'siteId', 'assetId', 'equipmentTypeId'] as const) {
                    form.setValue(k, loc[k] ?? '', { shouldDirty: true });
                  }
                  form.clearErrors(['regionId', 'cityId', 'siteId', 'assetId', 'equipmentTypeId']);
                }}
                errors={{
                  regionId: e.regionId?.message,
                  cityId: e.cityId?.message,
                  siteId: e.siteId?.message,
                  assetId: e.assetId?.message,
                  equipmentTypeId: e.equipmentTypeId?.message,
                }}
              />
            )}

            {step === 2 && (
              <div className="grid grid-cols-1 gap-4">
                <FormField label="Request type" required error={e.requestTypeId?.message}>
                  {(p) => (
                    <Select {...p} {...form.register('requestTypeId')}>
                      <option value="">{requestTypes.isLoading ? 'Loading…' : 'Select…'}</option>
                      {requestTypes.data?.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </FormField>
                <FormField
                  label="Describe the problem"
                  required
                  error={e.description?.message}
                  help={`${(v.description ?? '').length} / 5000 characters. Include what happened, when, and anything already tried.`}
                >
                  {(p) => <Textarea {...p} rows={6} maxLength={5000} {...form.register('description')} />}
                </FormField>
                <FormField
                  label="Your suggested priority"
                  error={e.suggestedPriorityId?.message}
                  help="Optional. Our team confirms the final priority when reviewing your complaint."
                >
                  {(p) => (
                    <Select {...p} {...form.register('suggestedPriorityId')}>
                      <option value="">No preference</option>
                      {priorities.data?.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </FormField>
                <div className="flex gap-2 rounded-lg border border-border bg-slate-50 p-3 text-sm text-slate-600">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-royal-700" aria-hidden />
                  <span>
                    <span className="font-medium text-navy-900">Received date/time</span> is recorded by our system when you submit (shown in{' '}
                    {getDisplayTimezone()}).
                  </span>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-5">
                <FilePicker files={files} onChange={setFiles} policy={boot.attachments} label="Photos or documents (optional)" disabled={submitting} />
                <div>
                  <p className="field-label">Privacy notice</p>
                  <div className="max-h-48 overflow-y-auto whitespace-pre-line rounded-lg border border-border bg-slate-50 p-3 text-sm text-slate-700">
                    {boot.privacyNoticeText}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">Version {boot.privacyNoticeVersion}</p>
                  <div className="mt-3 flex items-start gap-2">
                    <Checkbox
                      id="consent"
                      checked={v.consentAccepted === true}
                      onCheckedChange={(c) => form.setValue('consentAccepted', (c === true) as unknown as true, { shouldValidate: true })}
                      aria-invalid={e.consentAccepted ? true : undefined}
                      aria-describedby={e.consentAccepted ? 'consent-error' : undefined}
                    />
                    <label htmlFor="consent" className="text-sm text-slate-700">
                      I have read the privacy notice and agree to my information being used to handle this complaint.
                      <span className="ml-0.5 text-red-600">*</span>
                    </label>
                  </div>
                  {e.consentAccepted && (
                    <p id="consent-error" className="mt-1 text-xs text-red-600" role="alert">
                      {e.consentAccepted.message}
                    </p>
                  )}
                </div>
              </div>
            )}

            {step === 4 && (
              <div className="space-y-4 text-sm">
                <ReviewBlock
                  title="Your details"
                  onEdit={() => setStep(0)}
                  rows={[
                    ['Name', v.customerName],
                    ['Organization', v.organizationName || '—'],
                    ['Contact person', v.contactPerson || '—'],
                    ['Mobile', v.mobile],
                    ['Email', v.email],
                  ]}
                />
                <ReviewLocation v={v} onEdit={() => setStep(1)} />
                <ReviewBlock
                  title="Your request"
                  onEdit={() => setStep(2)}
                  rows={[
                    ['Request type', label(requestTypes.data, v.requestTypeId)],
                    ['Suggested priority', v.suggestedPriorityId ? label(priorities.data, v.suggestedPriorityId) : 'No preference'],
                    ['Description', v.description],
                  ]}
                />
                <ReviewBlock
                  title="Attachments & consent"
                  onEdit={() => setStep(3)}
                  rows={[
                    ['Files', files.length ? files.map((f) => f.name).join(', ') : 'None'],
                    ['Privacy notice', v.consentAccepted ? `Accepted (version ${boot.privacyNoticeVersion})` : 'Not accepted'],
                  ]}
                />
                {boot.captchaSiteKey && <Turnstile siteKey={boot.captchaSiteKey} onToken={setCaptchaToken} />}
              </div>
            )}
          </CardBody>
          <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
            <Button type="button" variant="outline" onClick={back} disabled={step === 0 || submitting}>
              <ChevronLeft className="h-4 w-4" /> Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button type="submit">
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            ) : (
              <Button type="submit" variant="secondary" loading={submitting}>
                Submit complaint
              </Button>
            )}
          </div>
        </form>
      </Card>
    </div>
  );
}

function ReviewBlock({ title, rows, onEdit }: { title: string; rows: [string, ReactNode][]; onEdit: () => void }) {
  return (
    <section className="rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <h2 className="font-medium text-navy-900">{title}</h2>
        <button type="button" className="text-sm font-medium text-royal-700 hover:underline" onClick={onEdit}>
          Edit
        </button>
      </div>
      <dl className="divide-y divide-border">
        {rows.map(([k, val]) => (
          <div key={k} className="grid grid-cols-3 gap-2 px-4 py-2">
            <dt className="text-slate-500">{k}</dt>
            <dd className="col-span-2 whitespace-pre-line break-words text-navy-900">{val}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ReviewLocation({ v, onEdit }: { v: FormIn; onEdit: () => void }) {
  const regions = useLookup('public', 'regions');
  const cities = useLookup('public', 'cities', { parentField: 'regionId', parentId: v.regionId });
  const sites = useLookup('public', 'sites', { parentField: 'cityId', parentId: v.cityId });
  const assets = useLookup('public', 'assets', { parentField: 'siteId', parentId: v.siteId });
  const equipment = useLookup('public', 'equipmentTypes');
  const name = (list: { id: string; label: string }[] | undefined, id?: string) => (id ? (list?.find((o) => o.id === id)?.label ?? '…') : '—');
  return (
    <ReviewBlock
      title="Location & asset"
      onEdit={onEdit}
      rows={[
        ['Region', name(regions.data, v.regionId)],
        ['City', name(cities.data, v.cityId)],
        ['Site', name(sites.data, v.siteId)],
        ['Asset', v.assetId ? name(assets.data, v.assetId) : 'Not specified'],
        ['Equipment type', v.equipmentTypeId ? name(equipment.data, v.equipmentTypeId) : 'Not specified'],
      ]}
    />
  );
}

function Confirmation({ result, onAnother }: { result: PublicSubmissionResult; onAnother: () => void }) {
  const { data: settings } = usePublicSettings();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.referenceNo);
      toast.success('Reference copied');
    } catch {
      toast.error('Could not copy — please note the reference manually');
    }
  };
  return (
    <Card>
      <CardBody className="space-y-5 text-center">
        <CheckCircle2 className="mx-auto h-12 w-12 text-teal-600" aria-hidden />
        <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold text-navy-900 focus:outline-none">
          Complaint submitted
        </h1>
        <div>
          <p className="text-sm text-slate-500">Your reference number</p>
          <div className="mt-1 flex items-center justify-center gap-2">
            <p className="font-mono text-3xl font-semibold tracking-wide text-navy-900" data-testid="reference">
              {result.referenceNo}
            </p>
            <Button variant="ghost" size="icon" onClick={copy} aria-label="Copy reference number">
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <p className="mt-1 text-sm text-slate-500">Received {formatDateTime(result.receivedAt)}</p>
        </div>
        <p className="text-sm text-slate-700">{result.message}</p>
        {result.possibleDuplicateOf && (
          <div className="mx-auto flex max-w-lg gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-left text-sm text-amber-800" role="status">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              You recently reported a problem at the same site (reference <strong>{result.possibleDuplicateOf}</strong>). If this is the same issue, our team
              will link the two — there is no need to submit again.
            </span>
          </div>
        )}
        <div className="mx-auto max-w-lg rounded-lg bg-slate-50 p-3 text-left text-sm text-slate-600">
          <p className="font-medium text-navy-900">What happens next</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>Please keep the reference number and quote it whenever you contact us.</li>
            <li>We will never ask for passwords or payment details by email or phone.</li>
            {(settings?.supportEmail || settings?.supportPhone) && (
              <li>
                Questions? Contact {[settings?.supportEmail, settings?.supportPhone].filter(Boolean).join(' / ')}.
              </li>
            )}
          </ul>
        </div>
        <Button variant="outline" onClick={onAnother}>
          Submit another complaint
        </Button>
      </CardBody>
    </Card>
  );
}
