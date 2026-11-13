import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState } from '@/components/states';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

export interface TemporaryAssetRow {
  id: string;
  code: string;
  name: string;
  equipmentType?: string;
  site?: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  createdAt: string;
}

export function useTemporaryAssets(enabled = true) {
  return useQuery({
    queryKey: ['temporary-assets'],
    queryFn: async () => (await api.get<TemporaryAssetRow[]>('/inspections/temporary-assets')).data,
    enabled,
  });
}

/** MD-08 / D-25: approve (optionally with a permanent code) or reject assets recorded in the field. */
export function TemporaryAssetsPage() {
  const qc = useQueryClient();
  const q = useTemporaryAssets();
  const [approving, setApproving] = useState<TemporaryAssetRow | null>(null);
  const [rejecting, setRejecting] = useState<TemporaryAssetRow | null>(null);
  const [code, setCode] = useState('');

  const decide = async (a: TemporaryAssetRow, decision: 'APPROVE' | 'REJECT', extra: { code?: string; comment?: string }) => {
    try {
      await api.post(`/inspections/temporary-assets/${a.id}/review`, { decision, ...extra });
      toast.success(decision === 'APPROVE' ? `${a.name} added to the asset register` : `${a.name} rejected`);
      void qc.invalidateQueries({ queryKey: ['temporary-assets'] });
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  };

  return (
    <div>
      <PageHeader title="Temporary assets" description="Equipment recorded on site that is not yet in the asset register. Approve to make it permanent, or reject it." />
      <Card>
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <div className="space-y-2 p-5">
            <div className="skeleton h-10" />
          </div>
        ) : !q.data?.length ? (
          <EmptyState icon={<Boxes className="h-6 w-6" />} title="Nothing to review" />
        ) : (
          <ul className="divide-y divide-border">
            {q.data.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-medium text-navy-900">
                    {a.name} <span className="font-mono text-xs text-slate-500">{a.code}</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    {[a.equipmentType, a.site, a.manufacturer, a.model, a.serialNumber && `S/N ${a.serialNumber}`].filter(Boolean).join(' · ')} · recorded {formatDateTime(a.createdAt)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="accent"
                    onClick={() => {
                      setCode('');
                      setApproving(a);
                    }}
                  >
                    Approve
                  </Button>
                  <Button size="sm" variant="outline" className="text-red-700" onClick={() => setRejecting(a)}>
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ConfirmDialog
        open={Boolean(approving)}
        onOpenChange={(o) => !o && setApproving(null)}
        title={`Approve ${approving?.name}?`}
        description="The asset becomes a permanent part of the register."
        confirmLabel="Approve"
        onConfirm={() => decide(approving!, 'APPROVE', { code: code.trim() || undefined })}
      >
        <label htmlFor="perm-code" className="field-label">
          Permanent asset code (optional)
        </label>
        <Input id="perm-code" maxLength={40} value={code} placeholder={approving?.code} onChange={(e) => setCode(e.target.value)} />
        <p className="mt-1 text-xs text-slate-500">Leave empty to keep {approving?.code}.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={Boolean(rejecting)}
        onOpenChange={(o) => !o && setRejecting(null)}
        title={`Reject ${rejecting?.name}?`}
        description="The temporary asset is deactivated. Reports that reference it keep the reference."
        confirmLabel="Reject"
        tone="danger"
        reason="required"
        reasonLabel="Comment"
        onConfirm={(comment) => decide(rejecting!, 'REJECT', { comment })}
      />
    </div>
  );
}
