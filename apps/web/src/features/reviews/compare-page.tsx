import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { INSPECTION_RESULT_LABELS, type InspectionResult, type RevisionComparisonDto } from '@mv/shared';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/controls';
import { EmptyState, ErrorState } from '@/components/states';
import { PageHeader } from '@/components/page-header';
import { useBreadcrumb } from '@/app/breadcrumbs';
import { cn } from '@/lib/utils';
import { useComparison } from './review-lib';

const label = (r?: string | null) => (r ? INSPECTION_RESULT_LABELS[r as InspectionResult] ?? r : 'Not answered');

export function ComparePage() {
  const { id = '' } = useParams();
  const [sp] = useSearchParams();
  const withId = sp.get('with');
  const q = useComparison(id, withId);
  useBreadcrumb(q.data ? `Compare r${q.data.from.revisionNo} → r${q.data.to.revisionNo}` : 'Compare');
  if (!withId) {
    return (
      <Card>
        <EmptyState title="Choose a revision to compare" description="Open this page from a report's revision list." />
      </Card>
    );
  }
  if (q.isLoading) return <div className="skeleton h-64" />;
  if (q.isError) {
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  }
  return q.data ? <CompareView data={q.data} /> : null;
}

export function CompareView({ data }: { data: RevisionComparisonDto }) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const changed = data.items.filter((i) => i.changed);
  const shown = showUnchanged ? data.items : changed;
  return (
    <div className="space-y-4">
      <PageHeader
        title={`Compare revision ${data.from.revisionNo} → ${data.to.revisionNo}`}
        description={`${changed.length} of ${data.items.length} checklist items changed.`}
        actions={
          <Link to={`/inspection-reports/${data.to.id}`} className="inline-flex items-center gap-1 text-sm font-medium text-royal-700 hover:underline">
            <ArrowLeft className="h-4 w-4" /> Back to revision {data.to.revisionNo}
          </Link>
        }
      />
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <Switch checked={showUnchanged} onCheckedChange={(c) => setShowUnchanged(c === true)} aria-label="Show unchanged items" />
        Show unchanged items
      </label>
      {shown.length === 0 && (
        <Card>
          <EmptyState title="No checklist items changed" description="Toggle 'Show unchanged items' to see every line." />
        </Card>
      )}
      <ul className="space-y-3" aria-label="Compared items">
        {shown.map((i) => (
          <li key={i.key} className={cn('rounded-xl border p-4', i.changed ? 'border-royal-300 bg-white' : 'border-border bg-slate-50')} data-testid={`cmp-${i.key}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="font-medium text-navy-900">
                {i.description} <span className="font-mono text-xs text-slate-400">{i.key}</span>
              </p>
              {i.changed ? <Badge tone="info">Changed</Badge> : <Badge>Unchanged</Badge>}
            </div>
            {i.feedback && (
              <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <span className="font-medium">Reviewer feedback:</span> {i.feedback}
              </p>
            )}
            <dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-[8rem_1fr]">
              <Row name="Result" from={label(i.from.result)} to={label(i.to.result)} />
              <Row name="Remarks" from={i.from.remarks ?? ''} to={i.to.remarks ?? ''} />
              <Row name="Reason" from={i.from.reason ?? ''} to={i.to.reason ?? ''} />
              <Row name="Evidence" from={`${i.from.evidence} file(s)`} to={`${i.to.evidence} file(s)`} />
            </dl>
          </li>
        ))}
      </ul>
      <Card>
        <CardHeader title="Findings and recommendations" />
        <CardBody className="text-sm">
          <dl className="grid grid-cols-1 gap-1 sm:grid-cols-[8rem_1fr]">
            <Row name="Findings" from={data.from_findings ?? ''} to={data.to_findings ?? ''} />
            <Row name="Recommendations" from={data.from_recommendations ?? ''} to={data.to_recommendations ?? ''} />
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}

function Row({ name, from, to }: { name: string; from: string; to: string }) {
  const diff = from !== to;
  return (
    <>
      <dt className="text-slate-500">{name}</dt>
      <dd className="min-w-0">
        {diff ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-red-50 px-1.5 text-red-800 line-through" aria-label={`Before: ${from || 'empty'}`}>
              {from || '—'}
            </span>
            <ArrowRight className="h-3.5 w-3.5 text-slate-400" aria-hidden />
            <span className="rounded bg-emerald-50 px-1.5 text-emerald-800" aria-label={`After: ${to || 'empty'}`}>
              {to || '—'}
            </span>
          </span>
        ) : (
          <span className="text-slate-600">{to || '—'}</span>
        )}
      </dd>
    </>
  );
}
