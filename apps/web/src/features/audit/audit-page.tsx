import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type { Paged } from '@mv/shared';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Dialog, SheetContent } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/form';
import { Spinner } from '@/components/ui/spinner';
import { DataTable } from '@/components/data-table';
import { JsonView } from '@/components/json-view';
import { PageHeader } from '@/components/page-header';
import { ErrorState } from '@/components/states';
import { api } from '@/lib/api';
import { describeUserAgent, formatDateTime, getDisplayTimezone } from '@/lib/format';
import type { AuditRow } from '@/lib/types';
import { humanize } from '@/lib/utils';
import { useDebounced } from '@/lib/use-debounced';

export function AuditPage() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page') ?? 1);
  const entityType = params.get('entityType') ?? '';
  const outcome = params.get('outcome') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [actionText, setActionText] = useState(params.get('action') ?? '');
  const q = useDebounced(search, 300);
  const action = useDebounced(actionText, 300);
  const [openId, setOpenId] = useState<string | null>(null);

  const update = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const types = useQuery({
    queryKey: ['audit', 'entity-types'],
    queryFn: async () => (await api.get<string[]>('/audit-logs/entity-types')).data,
    staleTime: 60_000,
  });

  // Date inputs are calendar days; send inclusive bounds.
  const fromIso = from ? new Date(`${from}T00:00:00`).toISOString() : undefined;
  const toIso = to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined;

  const list = useQuery({
    queryKey: ['audit', 'list', { page, entityType, outcome, fromIso, toIso, q, action }],
    queryFn: async () =>
      (
        await api.get<Paged<AuditRow>>('/audit-logs', {
          params: {
            page,
            limit: 25,
            entityType: entityType || undefined,
            outcome: outcome || undefined,
            from: fromIso,
            to: toIso,
            q: q || undefined,
            action: action || undefined,
          },
        })
      ).data,
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      <PageHeader
        title="Audit log"
        description={`Immutable history of security events, configuration changes and business actions. Times shown in ${getDisplayTimezone()}.`}
      />
      <Card>
        <div className="grid grid-cols-1 gap-2 border-b border-border p-3 sm:grid-cols-2 xl:grid-cols-6">
          <div className="relative xl:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input
              aria-label="Search reference, actor or reason"
              placeholder="Search reference, actor or reason"
              className="pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                update({ q: e.target.value || undefined });
              }}
            />
          </div>
          <Input
            aria-label="Action starts with"
            placeholder="Action (e.g. auth.login)"
            value={actionText}
            onChange={(e) => {
              setActionText(e.target.value);
              update({ action: e.target.value || undefined });
            }}
          />
          <Select aria-label="Entity type" value={entityType} onChange={(e) => update({ entityType: e.target.value || undefined })}>
            <option value="">All entities</option>
            {types.data?.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </Select>
          <Select aria-label="Outcome" value={outcome} onChange={(e) => update({ outcome: e.target.value || undefined })}>
            <option value="">All outcomes</option>
            <option value="SUCCESS">Success</option>
            <option value="FAILURE">Failure</option>
          </Select>
          <div className="flex gap-2">
            <div className="flex-1">
              <Label htmlFor="audit-from" className="sr-only">
                From date
              </Label>
              <Input id="audit-from" type="date" value={from} onChange={(e) => update({ from: e.target.value || undefined })} />
            </div>
            <div className="flex-1">
              <Label htmlFor="audit-to" className="sr-only">
                To date
              </Label>
              <Input id="audit-to" type="date" value={to} onChange={(e) => update({ to: e.target.value || undefined })} />
            </div>
          </div>
        </div>
        <DataTable
          caption="Audit events"
          columns={[
            { key: 'time', header: 'When', cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.timestamp)}</span> },
            {
              key: 'actor',
              header: 'Actor',
              cell: (r) => (
                <div>
                  <p className="font-medium text-navy-900">{r.actorName ?? '—'}</p>
                  <p className="text-xs text-slate-500">{r.actorRoles.join(', ')}</p>
                </div>
              ),
            },
            { key: 'action', header: 'Action', cell: (r) => <code className="text-xs">{r.action}</code> },
            {
              key: 'entity',
              header: 'Record',
              cell: (r) => (
                <div className="min-w-0">
                  <p>{humanize(r.entityType)}</p>
                  {r.entityRef && <p className="truncate text-xs text-slate-500">{r.entityRef}</p>}
                </div>
              ),
            },
            { key: 'outcome', header: 'Result', cell: (r) => <StatusBadge status={r.outcome} /> },
            { key: 'ip', header: 'IP', hideOnMobile: true, cell: (r) => r.ip ?? '—' },
          ]}
          rows={list.data?.data}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => list.refetch()}
          page={page}
          pages={list.data?.meta.pages}
          total={list.data?.meta.total}
          limit={list.data?.meta.limit}
          onPageChange={(p) => update({ page: String(p) })}
          onRowClick={(r) => setOpenId(r.id)}
          emptyTitle="No audit events match your filters"
        />
      </Card>
      <Dialog open={Boolean(openId)} onOpenChange={(o) => !o && setOpenId(null)}>
        {openId && <AuditDetail id={openId} />}
      </Dialog>
    </div>
  );
}

function AuditDetail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['audit', id], queryFn: async () => (await api.get<AuditRow>(`/audit-logs/${id}`)).data });
  const r = q.data;
  return (
    <SheetContent title="Audit event" description={r ? r.action : undefined}>
      {q.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : q.isError || !r ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="space-y-5">
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[140px_1fr]">
            <dt className="text-slate-500">When</dt>
            <dd>{formatDateTime(r.timestamp)}</dd>
            <dt className="text-slate-500">Actor</dt>
            <dd>
              {r.actorName ?? '—'} {r.actorRoles.length > 0 && <span className="text-slate-500">({r.actorRoles.join(', ')})</span>}
            </dd>
            <dt className="text-slate-500">Action</dt>
            <dd>
              <code className="text-xs">{r.action}</code>
            </dd>
            <dt className="text-slate-500">Record</dt>
            <dd>
              {humanize(r.entityType)}
              {r.entityRef ? ` · ${r.entityRef}` : ''}
            </dd>
            <dt className="text-slate-500">Result</dt>
            <dd>
              <StatusBadge status={r.outcome} />
            </dd>
            {r.reason && (
              <>
                <dt className="text-slate-500">Reason</dt>
                <dd className="whitespace-pre-wrap">{r.reason}</dd>
              </>
            )}
            <dt className="text-slate-500">IP address</dt>
            <dd>{r.ip ?? '—'}</dd>
            <dt className="text-slate-500">Device</dt>
            <dd title={r.userAgent ?? undefined}>{describeUserAgent(r.userAgent)}</dd>
            <dt className="text-slate-500">Request ID</dt>
            <dd className="break-all font-mono text-xs">{r.requestId ?? '—'}</dd>
          </dl>
          <JsonView label="Before" value={r.before} />
          <JsonView label="After" value={r.after} />
          <JsonView label="Additional details" value={r.meta} />
        </div>
      )}
    </SheetContent>
  );
}
