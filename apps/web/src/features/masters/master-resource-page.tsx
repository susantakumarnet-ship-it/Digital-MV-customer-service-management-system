import { useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Power, Search, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { MASTER_KEYS, MASTER_RESOURCES, type MasterKey, type Paged } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { Input, Select } from '@/components/ui/form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { useMasterOptions } from '@/lib/queries';
import type { MasterRecord } from '@/lib/types';
import { useDebounced } from '@/lib/use-debounced';
import { ImportDialog } from './import-dialog';
import { MasterFormDialog } from './master-form-dialog';

export function MasterResourcePage() {
  const { resource = '' } = useParams();
  if (!(MASTER_KEYS as readonly string[]).includes(resource)) return <Navigate to="/admin/masters" replace />;
  return <ResourceView key={resource} resource={resource as MasterKey} />;
}

function ResourceView({ resource }: { resource: MasterKey }) {
  const def = MASTER_RESOURCES[resource];
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page') ?? 1);
  const status = params.get('status') ?? 'ACTIVE';
  const sort = params.get('sort') ?? (resource === 'priorities' ? 'rank' : 'name');
  const parent = params.get('parent') ?? '';
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search, 300);
  const [editing, setEditing] = useState<MasterRecord | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState<MasterRecord | null>(null);

  const update = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const [parentField, parentId] = parent ? parent.split(':') : [undefined, undefined];
  const list = useQuery({
    queryKey: ['masters', resource, 'list', { page, status, sort, q, parent }],
    queryFn: async () =>
      (
        await api.get<Paged<MasterRecord>>(`/masters/${resource}`, {
          params: { page, limit: 20, status, sort, q: q || undefined, parentField, parentId },
        })
      ).data,
    placeholderData: keepPreviousData,
  });

  const canCreate = hasPermission('master.create');
  const canUpdate = hasPermission('master.update');
  const canImport = hasPermission('master.import') && canCreate && canUpdate;

  const columns: Column<MasterRecord>[] = [
    ...def.fields
      .filter((f) => f.column)
      .map<Column<MasterRecord>>((f) => ({
        key: f.name,
        header: f.label,
        sortKey: ['name', 'code', 'rank'].includes(f.name) ? f.name : undefined,
        hideOnMobile: !['name', 'code'].includes(f.name),
        cell: (r) => {
          const v = r[f.name];
          if (f.kind === 'ref') return r._refs?.[f.name] ?? '—';
          if (f.kind === 'select') return f.options?.find((o) => o.value === v)?.label ?? (v as string) ?? '—';
          if (f.name === 'name') return <span className="font-medium text-navy-900">{String(v)}</span>;
          if (f.name === 'code') return <code className="text-xs">{String(v)}</code>;
          return v === undefined || v === null || v === '' ? '—' : String(v);
        },
      })),
    {
      key: 'status',
      header: 'Status',
      sortKey: 'status',
      cell: (r) => (
        <span title={r.deactivationReason}>
          <StatusBadge status={r.status} />
        </span>
      ),
    },
    ...(canUpdate
      ? [
          {
            key: 'actions',
            header: 'Actions',
            className: 'text-right',
            cell: (r: MasterRecord) => (
              <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Edit ${r.name}`}
                  onClick={() => {
                    setEditing(r);
                    setFormOpen(true);
                  }}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={r.status === 'ACTIVE' ? `Deactivate ${r.name}` : `Activate ${r.name}`}
                  className={r.status === 'ACTIVE' ? 'text-red-600' : 'text-teal-700'}
                  onClick={() => setStatusTarget(r)}
                >
                  <Power className="h-4 w-4" />
                </Button>
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <div>
      <PageHeader
        title={def.label}
        description={`Records are deactivated rather than deleted so historical transactions remain intact.`}
        actions={
          <>
            {canImport && (
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <Upload className="h-4 w-4" /> Import
              </Button>
            )}
            {canCreate && (
              <Button
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                <Plus className="h-4 w-4" /> New {def.singular.toLowerCase()}
              </Button>
            )}
          </>
        }
      />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-border p-3">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input
              aria-label={`Search ${def.label}`}
              placeholder="Search name or code"
              className="pl-9"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                update({ q: e.target.value || undefined });
              }}
            />
          </div>
          <Select aria-label="Filter by status" className="w-auto" value={status} onChange={(e) => update({ status: e.target.value })}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
            <option value="ALL">All</option>
          </Select>
          {def.refs.length > 0 && <ParentFilter resource={resource} value={parent} onChange={(v) => update({ parent: v || undefined })} />}
        </div>
        <DataTable
          caption={def.label}
          columns={columns}
          rows={list.data?.data}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => list.refetch()}
          sort={sort}
          onSortChange={(s) => update({ sort: s })}
          page={page}
          pages={list.data?.meta.pages}
          total={list.data?.meta.total}
          limit={list.data?.meta.limit}
          onPageChange={(p) => update({ page: String(p) })}
          emptyTitle={q || parent || status !== 'ACTIVE' ? 'No records match your filters' : `No ${def.label.toLowerCase()} yet`}
          emptyAction={
            canCreate && !q && !parent ? (
              <Button
                size="sm"
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                <Plus className="h-4 w-4" /> Add the first one
              </Button>
            ) : undefined
          }
        />
      </Card>

      <MasterFormDialog resource={resource} record={editing} open={formOpen} onOpenChange={setFormOpen} />
      {canImport && <ImportDialog resource={resource} open={importOpen} onOpenChange={setImportOpen} />}
      <ConfirmDialog
        open={Boolean(statusTarget)}
        onOpenChange={(o) => !o && setStatusTarget(null)}
        title={statusTarget?.status === 'ACTIVE' ? `Deactivate ${statusTarget?.name}?` : `Activate ${statusTarget?.name}?`}
        description={
          statusTarget?.status === 'ACTIVE'
            ? 'It will no longer be offered for new records. Existing records that reference it are unaffected.'
            : 'It will be available for selection again.'
        }
        tone={statusTarget?.status === 'ACTIVE' ? 'danger' : 'primary'}
        confirmLabel={statusTarget?.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
        reason={statusTarget?.status === 'ACTIVE' ? 'required' : 'optional'}
        onConfirm={async (reason) => {
          const t = statusTarget!;
          try {
            await api.post(`/masters/${resource}/${t.id}/${t.status === 'ACTIVE' ? 'deactivate' : 'activate'}`, { reason: reason || undefined });
            toast.success(`${def.singular} ${t.status === 'ACTIVE' ? 'deactivated' : 'activated'}`);
            qc.invalidateQueries({ queryKey: ['masters', resource] });
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
        }}
      />
    </div>
  );
}

function ParentFilter({ resource, value, onChange }: { resource: MasterKey; value: string; onChange: (v: string) => void }) {
  const refs = MASTER_RESOURCES[resource].refs;
  return (
    <Select aria-label="Filter by parent" className="w-auto max-w-full" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All {MASTER_RESOURCES[resource].label.toLowerCase()}</option>
      {refs.map((r) => (
        <ParentOptions key={r.field} field={r.field} refKey={r.ref} />
      ))}
    </Select>
  );
}

function ParentOptions({ field, refKey }: { field: string; refKey: MasterKey }) {
  const opts = useMasterOptions(refKey, { includeInactive: true });
  return (
    <optgroup label={`By ${MASTER_RESOURCES[refKey].singular.toLowerCase()}`}>
      {opts.data?.map((o) => (
        <option key={o.id} value={`${field}:${o.id}`}>
          {o.label}
        </option>
      ))}
    </optgroup>
  );
}
