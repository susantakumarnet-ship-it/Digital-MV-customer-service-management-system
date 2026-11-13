import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CopyPlus, Eye, ListChecks, Pencil, Plus, Rocket, Archive } from 'lucide-react';
import { toast } from 'sonner';
import { EVIDENCE_REQUIREMENTS, type InspectionTemplateDto, type Paged } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState } from '@/components/states';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { groupBySection } from './report-lib';
import { TemplateEditorDialog } from './template-editor';

const STATUS_TONE = { DRAFT: 'warning', ACTIVE: 'success', RETIRED: 'neutral' } as const;
const EVIDENCE_LABEL = Object.fromEntries(EVIDENCE_REQUIREMENTS.map((e) => [e.value, e.label]));

/** Checklist templates admin (INSP-01): versioned per equipment type. */
export function TemplatesPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['inspection-templates'],
    queryFn: async () => (await api.get<Paged<InspectionTemplateDto>>('/inspections/templates', { params: { limit: 100, status: 'ALL' } })).data,
  });
  const [editor, setEditor] = useState<{ open: boolean; template?: InspectionTemplateDto }>({ open: false });
  const [viewing, setViewing] = useState<InspectionTemplateDto | null>(null);
  const [publishing, setPublishing] = useState<InspectionTemplateDto | null>(null);
  const [retiring, setRetiring] = useState<InspectionTemplateDto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string, { name: string; versions: InspectionTemplateDto[] }>();
    for (const t of q.data?.data ?? []) {
      const g = map.get(t.equipmentType.id) ?? { name: t.equipmentType.name, versions: [] };
      g.versions.push(t);
      map.set(t.equipmentType.id, g);
    }
    return [...map.values()].map((g) => ({ ...g, versions: g.versions.sort((a, b) => b.version - a.version) }));
  }, [q.data]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['inspection-templates'] });
  const act = async (t: InspectionTemplateDto, path: string, body?: unknown, ok?: string) => {
    setBusy(`${t.id}-${path}`);
    try {
      await api.post(`/inspections/templates/${t.id}/${path}`, body);
      toast.success(ok ?? 'Done');
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Checklist templates"
        description="Inspection checklists per equipment type. Each published version is used for new inspections; existing reports keep the version they started with."
        actions={
          <Button onClick={() => setEditor({ open: true })}>
            <Plus className="h-4 w-4" /> New template
          </Button>
        }
      />
      {q.isError ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : q.isLoading ? (
        <Card>
          <div className="space-y-2 p-5">
            <div className="skeleton h-6" />
            <div className="skeleton h-6" />
          </div>
        </Card>
      ) : !groups.length ? (
        <Card>
          <EmptyState icon={<ListChecks className="h-6 w-6" />} title="No checklist templates yet" description="Create a template for each equipment type that engineers inspect." />
        </Card>
      ) : (
        groups.map((g) => {
          const active = g.versions.find((v) => v.status === 'ACTIVE');
          const hasDraft = g.versions.some((v) => v.status === 'DRAFT');
          return (
            <Card key={g.name}>
              <CardHeader
                title={g.name}
                description={active ? `Active: v${active.version} · ${active.items.length} items` : 'No active version — engineers cannot start inspections for this equipment type'}
              />
              <ul className="divide-y divide-border">
                {g.versions.map((t) => (
                  <li key={t.id} className="flex flex-col gap-2 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="font-medium text-navy-900">
                        {t.name} <span className="font-normal text-slate-500">v{t.version}</span>{' '}
                        <Badge tone={STATUS_TONE[t.status]}>{t.status === 'DRAFT' ? 'Draft' : t.status === 'ACTIVE' ? 'Active' : 'Retired'}</Badge>
                      </p>
                      <p className="text-xs text-slate-500">
                        {t.items.length} items
                        {t.publishedAt && ` · published ${formatDateTime(t.publishedAt)}${t.publishedByName ? ` by ${t.publishedByName}` : ''}`}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {t.status === 'DRAFT' ? (
                        <>
                          <Button size="sm" variant="outline" onClick={() => setEditor({ open: true, template: t })}>
                            <Pencil className="h-4 w-4" /> Edit
                          </Button>
                          <Button size="sm" variant="accent" onClick={() => setPublishing(t)}>
                            <Rocket className="h-4 w-4" /> Publish
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => setViewing(t)}>
                          <Eye className="h-4 w-4" /> View
                        </Button>
                      )}
                      {t.status === 'ACTIVE' && !hasDraft && (
                        <Button size="sm" variant="secondary" loading={busy === `${t.id}-new-version`} onClick={() => act(t, 'new-version', undefined, 'New draft version created').catch(() => undefined)}>
                          <CopyPlus className="h-4 w-4" /> New version
                        </Button>
                      )}
                      {t.status === 'ACTIVE' && (
                        <Button size="sm" variant="outline" className="text-red-700" onClick={() => setRetiring(t)}>
                          <Archive className="h-4 w-4" /> Retire
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })
      )}

      <TemplateEditorDialog open={editor.open} template={editor.template} onOpenChange={(o) => setEditor((e) => ({ ...e, open: o }))} onSaved={refresh} />
      <Dialog open={Boolean(viewing)} onOpenChange={(o) => !o && setViewing(null)}>
        {viewing && (
          <DialogContent title={`${viewing.name} v${viewing.version}`} description={`${viewing.equipmentType.name} · read-only`} size="lg">
            <div className="space-y-4">
              {groupBySection(viewing.items).map((g) => (
                <div key={g.section}>
                  <p className="mb-1 text-sm font-semibold text-navy-900">{g.section}</p>
                  <ol className="space-y-1.5">
                    {g.items.map((i) => (
                      <li key={i.key} className="rounded-md border border-border px-3 py-2 text-sm">
                        <p className="text-navy-900">{i.description}</p>
                        <p className="text-xs text-slate-500">
                          <span className="font-mono">{i.key}</span> · {i.required ? 'required' : 'optional'} · {EVIDENCE_LABEL[i.evidence]}
                          {i.naReasonRequired && ' · N/A needs reason'}
                          {i.evidenceOnFail && ' · evidence if failed'}
                        </p>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </DialogContent>
        )}
      </Dialog>
      <ConfirmDialog
        open={Boolean(publishing)}
        onOpenChange={(o) => !o && setPublishing(null)}
        title={`Publish ${publishing?.name} v${publishing?.version}?`}
        description="This replaces the active version for new inspections. Existing reports keep the version they started with."
        confirmLabel="Publish"
        onConfirm={() => act(publishing!, 'publish', undefined, 'Template published')}
      />
      <ConfirmDialog
        open={Boolean(retiring)}
        onOpenChange={(o) => !o && setRetiring(null)}
        title={`Retire ${retiring?.name} v${retiring?.version}?`}
        description="Engineers cannot start new inspections for this equipment type until another version is published."
        confirmLabel="Retire"
        tone="danger"
        reason="required"
        onConfirm={(reason) => act(retiring!, 'retire', { reason }, 'Template retired')}
      />
    </div>
  );
}
