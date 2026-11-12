import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, EyeOff, Pencil } from 'lucide-react';
import { COMPLAINT_SOURCES, type ComplaintDetailDto } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge, StatusBadge, toneOf } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/states';
import { useBreadcrumb } from '@/app/breadcrumbs';
import { useAuth } from '@/features/auth/auth-context';
import { api, parseApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { ComplaintActions } from './complaint-actions';
import {
  ActivityPanel,
  AttachmentsPanel,
  ClassificationPanel,
  CustomerMessagesPanel,
  EditIntakeDialog,
  InternalNotesPanel,
  StatusHistoryPanel,
} from './complaint-panels';
import { DueCell, PriorityBadge } from './complaints-list-page';

export function ComplaintDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['complaints', 'detail', id],
    queryFn: async () => (await api.get<ComplaintDetailDto>(`/complaints/${id}`)).data,
  });
  useBreadcrumb(q.data?.referenceNo);

  const onChanged = (c: ComplaintDetailDto) => {
    qc.setQueryData(['complaints', 'detail', id], c);
    void qc.invalidateQueries({ queryKey: ['complaints', 'list'] });
    void qc.invalidateQueries({ queryKey: ['complaints', 'summary'] });
    void qc.invalidateQueries({ queryKey: ['complaints', id, 'activity'] });
  };

  if (q.isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-8 w-64" />
        <div className="skeleton h-40" />
        <div className="skeleton h-40" />
      </div>
    );
  }
  if (q.isError) {
    const status = parseApiError(q.error).status;
    return (
      <Card>
        {status === 404 || status === 400 ? (
          <EmptyState
            title="Complaint not found"
            description="It may not exist, or it is outside your data access."
            action={
              <Link to="/complaints" className="text-sm font-medium text-royal-700 hover:underline">
                Back to complaints
              </Link>
            }
          />
        ) : (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        )}
      </Card>
    );
  }
  return q.data ? <ComplaintDetailView complaint={q.data} onChanged={onChanged} /> : null;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-navy-900">{children ?? '—'}</dd>
    </div>
  );
}

export function ComplaintDetailView({ complaint: c, onChanged }: { complaint: ComplaintDetailDto; onChanged: (c: ComplaintDetailDto) => void }) {
  const { hasPermission } = useAuth();
  const [editOpen, setEditOpen] = useState(false);
  const isStaff = hasPermission('complaint.update');
  const sourceLabel = COMPLAINT_SOURCES.find((s) => s.value === c.source)?.label ?? c.source;

  return (
    <div className="space-y-4">
      <div>
        <Link to="/complaints" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-navy-900">
          <ArrowLeft className="h-4 w-4" /> Complaints
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-mono text-xl font-semibold text-navy-900 sm:text-2xl">{c.referenceNo}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusBadge status={c.status} label={c.statusLabel} tone={toneOf(c.statusTone)} />
              <PriorityBadge priority={c.priority} />
              {c.overdue && (
                <Badge tone="danger">
                  <AlertTriangle className="h-3 w-3" aria-hidden /> Overdue
                </Badge>
              )}
              {c.duplicateOf && (
                <span className="text-sm text-slate-600">
                  Duplicate of{' '}
                  <Link to={`/complaints/${c.duplicateOf.id}`} className="font-mono font-medium text-royal-700 hover:underline">
                    {c.duplicateOf.referenceNo}
                  </Link>
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {c.permissions.canEdit && (
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                <Pencil className="h-4 w-4" /> Edit details
              </Button>
            )}
          </div>
        </div>
        <div className="mt-3">
          <ComplaintActions complaint={c} onChanged={onChanged} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader title="Request" />
            <CardBody>
              <p className="whitespace-pre-line break-words text-sm text-slate-800">{c.description}</p>
              <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Field label="Request type">{c.requestType?.name}</Field>
                <Field label="Customer-suggested priority">{c.suggestedPriority?.name ?? 'None'}</Field>
                <Field label="Category">{c.category || '—'}</Field>
                <Field label="Source">{sourceLabel}</Field>
                <Field label="Received">{formatDateTime(c.receivedAt)}</Field>
                <Field label="Acknowledged">{c.acknowledgedAt ? formatDateTime(c.acknowledgedAt) : 'Not yet'}</Field>
                <Field label="Due">
                  <DueCell c={c} />
                </Field>
                <Field label="Supervisor">{c.supervisor?.name ?? 'Not assigned'}</Field>
                <Field label="Privacy consent">{c.consent.accepted ? `Accepted${c.consent.version ? ` (v${c.consent.version})` : ''}` : 'Not recorded'}</Field>
              </dl>
            </CardBody>
          </Card>

          {c.permissions.canClassify && <ClassificationPanel complaint={c} onChanged={onChanged} />}
          <CustomerMessagesPanel complaint={c} onChanged={onChanged} />
          <AttachmentsPanel complaint={c} onChanged={onChanged} isStaff={isStaff} />
          <InternalNotesPanel complaint={c} onChanged={onChanged} />
          {hasPermission('complaint.readInternal') && <ActivityPanel complaintId={c.id} />}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Customer & contact" />
            <CardBody>
              {c.contactMasked && (
                <p className="mb-3 flex items-center gap-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600" data-testid="masked-hint">
                  <EyeOff className="h-4 w-4 shrink-0" aria-hidden /> Contact details are masked for your role.
                </p>
              )}
              <dl className="grid grid-cols-1 gap-3">
                <Field label="Customer">{c.customerName}</Field>
                <Field label="Organization (as reported)">{c.organizationName || '—'}</Field>
                <Field label="Contact person">{c.contactPerson || '—'}</Field>
                <Field label="Mobile">{c.mobile}</Field>
                <Field label="Email">{c.email}</Field>
              </dl>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Location & asset" />
            <CardBody>
              <dl className="grid grid-cols-1 gap-3">
                <Field label="Customer organization">{c.customerOrganization?.name}</Field>
                <Field label="Site">
                  {c.site?.name}
                  {c.site?.code ? <span className="text-slate-500"> ({c.site.code})</span> : null}
                </Field>
                <Field label="City / region">{[c.city?.name, c.region?.name].filter(Boolean).join(' · ')}</Field>
                <Field label="Asset">{c.asset ? `${c.asset.name} (${c.asset.code})` : 'Not specified'}</Field>
                <Field label="Equipment type">{c.equipmentType?.name ?? 'Not specified'}</Field>
              </dl>
            </CardBody>
          </Card>
          {c.linkedDuplicates.length > 0 && (
            <Card>
              <CardHeader title="Linked duplicates" description="Kept for traceability (BR-003)." />
              <ul className="divide-y divide-border">
                {c.linkedDuplicates.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 px-5 py-2.5 text-sm">
                    <Link to={`/complaints/${d.id}`} className="font-mono font-medium text-royal-700 hover:underline">
                      {d.referenceNo}
                    </Link>
                    <span className="text-xs text-slate-500">{formatDateTime(d.receivedAt)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <StatusHistoryPanel complaint={c} />
        </div>
      </div>

      {c.permissions.canEdit && <EditIntakeDialog complaint={c} open={editOpen} onOpenChange={setEditOpen} onChanged={onChanged} />}
    </div>
  );
}
