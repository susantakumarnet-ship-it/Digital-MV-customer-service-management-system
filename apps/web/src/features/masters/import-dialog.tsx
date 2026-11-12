import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, FileUp } from 'lucide-react';
import { toast } from 'sonner';
import { MASTER_RESOURCES, type MasterKey } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { KpiCard } from '@/components/kpi-card';
import { api, errorMessage, getBlob } from '@/lib/api';
import { downloadBlob } from '@/lib/utils';

interface ImportResult {
  committed: boolean;
  dryRun: boolean;
  summary: { totalRows: number; toCreate: number; toUpdate: number; errors: number };
  results: { row: number; code?: string; action: 'create' | 'update' | 'error'; errors?: Record<string, string> }[];
}

/** Bulk import (MD-07): template → validate (dry run) → commit only when there are no errors. */
export function ImportDialog({ resource, open, onOpenChange }: { resource: MasterKey; open: boolean; onOpenChange: (o: boolean) => void }) {
  const def = MASTER_RESOURCES[resource];
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<'validate' | 'commit' | 'xlsx' | 'csv' | null>(null);

  useEffect(() => {
    if (open) {
      setFile(null);
      setResult(null);
    }
  }, [open]);

  const template = async (format: 'xlsx' | 'csv') => {
    setBusy(format);
    try {
      const { blob, filename } = await getBlob(`/masters/${resource}/import-template`, { format });
      downloadBlob(blob, filename);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const send = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(dryRun ? 'validate' : 'commit');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post<ImportResult>(`/masters/${resource}/import`, fd, { params: { dryRun: String(dryRun) } });
      setResult(data);
      if (data.committed) {
        toast.success(`Imported ${data.summary.toCreate} new and ${data.summary.toUpdate} updated ${def.label.toLowerCase()}`);
        qc.invalidateQueries({ queryKey: ['masters', resource] });
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const errorRows = result?.results.filter((r) => r.action === 'error') ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="xl"
        title={`Import ${def.label.toLowerCase()}`}
        description="Existing codes are updated, new codes are created. Nothing is saved unless every row is valid."
        footer={
          result?.committed ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="outline" disabled={!file} loading={busy === 'validate'} onClick={() => send(true)}>
                Validate file
              </Button>
              <Button
                disabled={!file || !result || result.summary.errors > 0 || result.summary.totalRows === 0}
                loading={busy === 'commit'}
                onClick={() => send(false)}
              >
                Commit import
              </Button>
            </>
          )
        }
      >
        <div className="space-y-5">
          <section>
            <h3 className="text-sm font-semibold text-navy-900">1. Download the template</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" loading={busy === 'xlsx'} onClick={() => template('xlsx')}>
                <Download className="h-4 w-4" /> Excel template
              </Button>
              <Button variant="outline" size="sm" loading={busy === 'csv'} onClick={() => template('csv')}>
                <Download className="h-4 w-4" /> CSV template
              </Button>
            </div>
          </section>
          <section>
            <h3 className="text-sm font-semibold text-navy-900">2. Choose your completed file</h3>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.csv"
                className="sr-only"
                id="import-file"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setResult(null);
                }}
              />
              <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={result?.committed}>
                <FileUp className="h-4 w-4" /> Choose file
              </Button>
              <span className="text-sm text-slate-600">{file ? `${file.name} (${Math.ceil(file.size / 1024)} KB)` : 'No file selected (.xlsx or .csv, max 5 MB)'}</span>
            </div>
          </section>
          {result && (
            <section>
              <h3 className="text-sm font-semibold text-navy-900">3. {result.committed ? 'Import complete' : 'Validation results'}</h3>
              <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
                <KpiCard label="Rows" value={result.summary.totalRows} accent="slate" />
                <KpiCard label="New" value={result.summary.toCreate} accent="teal" />
                <KpiCard label="Updates" value={result.summary.toUpdate} accent="royal" />
                <KpiCard label="Errors" value={result.summary.errors} accent={result.summary.errors ? 'red' : 'slate'} />
              </div>
              {result.committed ? (
                <p className="mt-3 flex items-center gap-2 text-sm text-emerald-700" role="status">
                  <CheckCircle2 className="h-4 w-4" /> All rows were saved.
                </p>
              ) : errorRows.length ? (
                <div className="mt-3 max-h-72 overflow-auto rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-3 py-2">Row</th>
                        <th className="px-3 py-2">Code</th>
                        <th className="px-3 py-2">Problems</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {errorRows.map((r) => (
                        <tr key={r.row}>
                          <td className="px-3 py-2 tabular-nums">{r.row}</td>
                          <td className="px-3 py-2">{r.code || '—'}</td>
                          <td className="px-3 py-2">
                            <ul className="space-y-0.5 text-red-700">
                              {Object.entries(r.errors ?? {}).map(([k, v]) => (
                                <li key={k}>
                                  <span className="font-medium">{k}:</span> {v}
                                </li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : result.summary.totalRows === 0 ? (
                <p className="mt-3 text-sm text-amber-700">The file contains no data rows.</p>
              ) : (
                <p className="mt-3 flex items-center gap-2 text-sm text-emerald-700" role="status">
                  <CheckCircle2 className="h-4 w-4" /> The file is valid. Select “Commit import” to save it.
                </p>
              )}
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
