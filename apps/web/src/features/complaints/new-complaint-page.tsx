import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { COMPLAINT_SOURCES, internalComplaintSchema, type ComplaintDetailDto } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { FormField, Input, Select, Textarea } from '@/components/ui/form';
import { PageHeader } from '@/components/page-header';
import { useAuth } from '@/features/auth/auth-context';
import { ErrorBanner } from '@/features/auth/login-page';
import { api, parseApiError } from '@/lib/api';
import { getDisplayTimezone } from '@/lib/format';
import { usePublicSettings } from '@/lib/queries';
import { FilePicker, LocationFields } from './complaint-fields';
import { multipartBody, newIdempotencyKey, useLookup, type AttachmentPolicy } from './complaint-lib';

const formSchema = internalComplaintSchema.omit({ source: true, receivedAt: true, consentAccepted: true });
type FormIn = z.input<typeof formSchema>;
type FormOut = z.output<typeof formSchema>;

const STAFF_SOURCES = COMPLAINT_SOURCES.filter((s) => s.value !== 'PUBLIC_FORM' && s.value !== 'CUSTOMER_PORTAL');

/** Internal registration by staff (phone/email/walk-in) or by a portal customer (source fixed server-side). */
export function NewComplaintPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { hasPermission, user } = useAuth();
  const isStaff = hasPermission('complaint.update');
  // Registration only offers sites within the user's data scope (customers: their own organisation).
  const lookupSource = 'scoped' as const;
  const settings = usePublicSettings();
  const policy: AttachmentPolicy | undefined = settings.data?.attachments;

  const [files, setFiles] = useState<File[]>([]);
  const [source, setSource] = useState<string>('PHONE');
  const [receivedAt, setReceivedAt] = useState('');
  const [receivedError, setReceivedError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const idempotencyKey = useMemo(() => newIdempotencyKey(), []);

  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(formSchema) as unknown as Resolver<FormIn, unknown, FormOut>,
    defaultValues: {
      customerName: isStaff ? '' : (user?.name ?? ''),
      organizationName: '',
      contactPerson: '',
      mobile: isStaff ? '' : (user?.phone ?? ''),
      email: isStaff ? '' : (user?.email ?? ''),
      regionId: '',
      cityId: '',
      siteId: '',
      assetId: '',
      equipmentTypeId: '',
      requestTypeId: '',
      description: '',
      suggestedPriorityId: '',
    },
  });
  const v = form.watch();
  const e = form.formState.errors;
  const requestTypes = useLookup(lookupSource, 'requestTypes');
  const priorities = useLookup(lookupSource, 'priorities');

  const submit = form.handleSubmit(async (values) => {
    if (submitting) return;
    let received: string | undefined;
    if (isStaff && receivedAt) {
      const d = new Date(receivedAt);
      if (Number.isNaN(d.getTime())) return setReceivedError('Enter a valid date and time');
      if (d.getTime() > Date.now() + 60_000) return setReceivedError('Received time cannot be in the future');
      received = d.toISOString();
    }
    setReceivedError(undefined);
    setSubmitting(true);
    setFormError(null);
    try {
      const data = { ...values, ...(isStaff ? { source, receivedAt: received } : {}), consentAccepted: true };
      const res = await api.post<ComplaintDetailDto>('/complaints', multipartBody(data, files), { headers: { 'Idempotency-Key': idempotencyKey } });
      await qc.invalidateQueries({ queryKey: ['complaints'] });
      toast.success(`Complaint ${res.data.referenceNo} registered`);
      navigate(`/complaints/${res.data.id}`, { replace: true });
    } catch (err) {
      const pe = parseApiError(err);
      if (pe.fields) {
        for (const [field, message] of Object.entries(pe.fields)) {
          if (field === 'receivedAt') setReceivedError(message);
          else form.setError(field as keyof FormIn, { type: 'server', message });
        }
        setFormError('Please correct the highlighted fields.');
      } else setFormError(pe.message);
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <div>
      <PageHeader
        title={isStaff ? 'Register a complaint' : 'Report a new complaint'}
        description={
          isStaff
            ? 'Record a complaint received by phone, email or in person. A reference number is generated when you save.'
            : "Report a problem at one of your organisation's sites. You can follow its progress here."
        }
      />
      <form onSubmit={submit} noValidate className="space-y-4">
        {formError && <ErrorBanner message={formError} />}
        {isStaff && (
          <Card>
            <CardHeader title="Intake" />
            <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Received via" required>
                {(p) => (
                  <Select {...p} value={source} onChange={(ev) => setSource(ev.target.value)}>
                    {STAFF_SOURCES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
              <FormField label={`Received at (${getDisplayTimezone()})`} error={receivedError} help="Leave empty to use the current time.">
                {(p) => <Input {...p} type="datetime-local" value={receivedAt} max={new Date().toISOString().slice(0, 16)} onChange={(ev) => setReceivedAt(ev.target.value)} />}
              </FormField>
            </CardBody>
          </Card>
        )}
        <Card>
          <CardHeader title="Customer & contact" />
          <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Customer name" required error={e.customerName?.message} className="sm:col-span-2">
              {(p) => <Input {...p} {...form.register('customerName')} />}
            </FormField>
            <FormField label="Organization" error={e.organizationName?.message}>
              {(p) => <Input {...p} {...form.register('organizationName')} />}
            </FormField>
            <FormField label="Contact person" error={e.contactPerson?.message}>
              {(p) => <Input {...p} {...form.register('contactPerson')} />}
            </FormField>
            <FormField label="Mobile number" required error={e.mobile?.message}>
              {(p) => <Input {...p} type="tel" {...form.register('mobile')} />}
            </FormField>
            <FormField label="Email address" required error={e.email?.message}>
              {(p) => <Input {...p} type="email" {...form.register('email')} />}
            </FormField>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Location & asset" />
          <CardBody>
            <LocationFields
              source={lookupSource}
              value={{ regionId: v.regionId, cityId: v.cityId, siteId: v.siteId, assetId: v.assetId || undefined, equipmentTypeId: v.equipmentTypeId || undefined }}
              onChange={(loc) => {
                for (const k of ['regionId', 'cityId', 'siteId', 'assetId', 'equipmentTypeId'] as const) form.setValue(k, loc[k] ?? '');
                form.clearErrors(['regionId', 'cityId', 'siteId', 'assetId', 'equipmentTypeId']);
              }}
              errors={{ regionId: e.regionId?.message, cityId: e.cityId?.message, siteId: e.siteId?.message, assetId: e.assetId?.message, equipmentTypeId: e.equipmentTypeId?.message }}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Request" />
          <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
            <FormField label="Customer-suggested priority" error={e.suggestedPriorityId?.message} help="Final priority is set during review.">
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
            <FormField label="Description" required error={e.description?.message} help={`${(v.description ?? '').length} / 5000`} className="sm:col-span-2">
              {(p) => <Textarea {...p} rows={5} maxLength={5000} {...form.register('description')} />}
            </FormField>
            <div className="sm:col-span-2">
              <FilePicker files={files} onChange={setFiles} policy={policy} disabled={submitting} />
            </div>
          </CardBody>
        </Card>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => navigate(-1)} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" variant="secondary" loading={submitting}>
            Register complaint
          </Button>
        </div>
      </form>
    </div>
  );
}
