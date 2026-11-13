import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Clock, LinkIcon, MessageSquareWarning } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ErrorState } from '@/components/states';
import { PublicLayout } from '@/features/complaints/public-complaint-page';
import { api, parseApiError } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { usePublicSettings } from '@/lib/queries';
import { DecisionForm, ServiceSummary } from './acceptance-components';
import { decisionPayload, type TokenView } from './acceptance-lib';

type Outcome = { decision: 'ACCEPT' | 'REJECT' | 'WAIVED'; at: string };

function Notice({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardBody className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="rounded-full bg-slate-100 p-3 text-navy-800">{icon}</div>
        <h1 className="text-lg font-semibold text-navy-900" tabIndex={-1}>
          {title}
        </h1>
        <div className="max-w-md text-sm text-slate-600">{children}</div>
      </CardBody>
    </Card>
  );
}

function SupportLine() {
  const s = usePublicSettings().data;
  if (!s?.supportEmail && !s?.supportPhone) return null;
  return (
    <p className="mt-2">
      Contact us{s.supportEmail ? ` at ${s.supportEmail}` : ''}
      {s.supportPhone ? `${s.supportEmail ? ' or' : ''} on ${s.supportPhone}` : ''}.
    </p>
  );
}

/** Secure-link acceptance (BR-015): opening the page never records acceptance — only the submitted decision does. */
export function PublicAcceptancePage() {
  const { token = '' } = useParams();
  const q = useQuery({
    queryKey: ['public', 'acceptance', token],
    queryFn: async () => (await api.get<TokenView>(`/customer-acceptance/${token}`)).data,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  let body: React.ReactNode;
  if (outcome) {
    body = (
      <Notice icon={<CheckCircle2 className="h-6 w-6 text-emerald-700" aria-hidden />} title={outcome.decision === 'ACCEPT' ? 'Thank you — service accepted' : 'Thank you — we will be in touch'}>
        {outcome.decision === 'ACCEPT' ? (
          <p>Your acceptance has been recorded. We will close your complaint and email you a final confirmation.</p>
        ) : (
          <p>Your complaint has been reopened and our team will contact you about the remaining work.</p>
        )}
      </Notice>
    );
  } else if (q.isError) {
    const e = parseApiError(q.error);
    if (e.code === 'LINK_EXPIRED') {
      body = (
        <Notice icon={<Clock className="h-6 w-6" aria-hidden />} title="This link has expired">
          <p>For your security, acceptance links are only valid for a limited time. Please contact us and we will send you a new one.</p>
          <SupportLine />
        </Notice>
      );
    } else if (e.code === 'LINK_SUPERSEDED') {
      body = (
        <Notice icon={<LinkIcon className="h-6 w-6" aria-hidden />} title="This link has been replaced">
          <p>A newer link has been sent to you. Please use the most recent email from us.</p>
          <SupportLine />
        </Notice>
      );
    } else if (e.status === 404 || e.status === 400) {
      body = (
        <Notice icon={<MessageSquareWarning className="h-6 w-6" aria-hidden />} title="This link is not valid">
          <p>Please check that you opened the complete link from our email.</p>
          <SupportLine />
        </Notice>
      );
    } else {
      body = (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      );
    }
  } else if (q.isLoading || !q.data) {
    body = (
      <Card>
        <CardBody className="space-y-3">
          <div className="skeleton h-6 w-1/2" />
          <div className="skeleton h-24" />
        </CardBody>
      </Card>
    );
  } else if (q.data.decided) {
    body = (
      <Notice icon={<CheckCircle2 className="h-6 w-6 text-emerald-700" aria-hidden />} title="Your response has already been recorded">
        <p>
          {q.data.decided.decision === 'ACCEPT' ? 'The service was accepted' : q.data.decided.decision === 'REJECT' ? 'Further action was requested' : 'Acceptance was recorded'} on {formatDateTime(q.data.decided.at)}. This link cannot be used again.
        </p>
      </Notice>
    );
  } else {
    const v = q.data;
    body = (
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-navy-900 sm:text-2xl">Confirm the service for {v.complaint.referenceNo}</h1>
          <p className="mt-1 text-sm text-slate-600">
            Reported {formatDate(v.complaint.receivedAt)}
            {v.complaint.siteName ? ` · ${v.complaint.siteName}` : ''}
            {v.expiresAt ? ` · this link expires ${formatDateTime(v.expiresAt)}` : ''}
          </p>
        </div>
        <Card>
          <CardHeader title="Your request" />
          <CardBody>
            <p className="whitespace-pre-line break-words text-sm text-slate-800">{v.complaint.description}</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Service summary" />
          <CardBody>
            <ServiceSummary summary={v} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Your decision" description="Opening this page does not count as acceptance. Please submit your decision below." />
          <CardBody>
            {submitError && (
              <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                {submitError}
              </p>
            )}
            <DecisionForm
              requireName
              onSubmit={async (d) => {
                setSubmitError(null);
                try {
                  const { data } = await api.post<{ decided?: Outcome | null }>(`/customer-acceptance/${token}`, decisionPayload(d, true));
                  setOutcome(data.decided ?? { decision: d.decision as 'ACCEPT' | 'REJECT', at: new Date().toISOString() });
                } catch (err) {
                  const e = parseApiError(err);
                  setSubmitError(e.code === 'LINK_USED' ? 'A response has already been recorded with this link.' : e.message);
                  throw err;
                }
              }}
            />
          </CardBody>
        </Card>
      </div>
    );
  }

  return <PublicLayout>{body}</PublicLayout>;
}
