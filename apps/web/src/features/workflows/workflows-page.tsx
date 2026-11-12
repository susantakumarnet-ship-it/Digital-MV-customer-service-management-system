import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Cog } from 'lucide-react';
import { toast } from 'sonner';
import { STATUS_TONES, type StatusTone, type WorkflowDefinitionDto } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/controls';
import { Input, Select } from '@/components/ui/form';
import { LoadingScreen } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState } from '@/components/states';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { humanize } from '@/lib/utils';

interface WorkflowsResponse {
  definitions: WorkflowDefinitionDto[];
  guards: string[];
}

export function WorkflowsPage() {
  const q = useQuery({ queryKey: ['workflows'], queryFn: async () => (await api.get<WorkflowsResponse>('/workflows')).data });
  const [params, setParams] = useSearchParams();
  const defs = q.data?.definitions ?? [];
  const tab = defs.some((d) => d.entity === params.get('entity')) ? params.get('entity')! : defs[0]?.entity;

  return (
    <div>
      <PageHeader
        title="Workflows"
        description="Every status change goes through these definitions. You can rename statuses, change badge colours and switch optional steps on or off. Mandatory steps, permissions and business rules cannot be changed here."
      />
      {q.isLoading ? (
        <LoadingScreen />
      ) : q.isError ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : !defs.length ? (
        <Card>
          <EmptyState title="No workflow definitions" description="Run the database seed to install the default workflows." />
        </Card>
      ) : (
        <Tabs value={tab} onValueChange={(v) => setParams({ entity: v }, { replace: true })}>
          <TabsList>
            {defs.map((d) => (
              <TabsTrigger key={d.entity} value={d.entity}>
                {humanize(d.entity)}
              </TabsTrigger>
            ))}
          </TabsList>
          {defs.map((d) => (
            <TabsContent key={d.entity} value={d.entity}>
              <WorkflowEditor def={d} registeredGuards={q.data!.guards} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}

type StateDraft = { key: string; label: string; tone: StatusTone };
type TransitionDraft = { action: string; label: string; enabled: boolean };

function WorkflowEditor({ def, registeredGuards }: { def: WorkflowDefinitionDto; registeredGuards: string[] }) {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('workflow.update');
  const initialStates = useMemo<StateDraft[]>(() => def.states.map((s) => ({ key: s.key, label: s.label, tone: s.tone })), [def]);
  const initialTransitions = useMemo<TransitionDraft[]>(() => def.transitions.map((t) => ({ action: t.action, label: t.label, enabled: t.enabled })), [def]);
  const [states, setStates] = useState(initialStates);
  const [transitions, setTransitions] = useState(initialTransitions);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setStates(initialStates), [initialStates]);
  useEffect(() => setTransitions(initialTransitions), [initialTransitions]);

  const dirty = JSON.stringify(states) !== JSON.stringify(initialStates) || JSON.stringify(transitions) !== JSON.stringify(initialTransitions);
  const labelOf = (key: string) => states.find((s) => s.key === key)?.label ?? key;
  const toneOf = (key: string) => states.find((s) => s.key === key)?.tone ?? 'neutral';
  const guardSet = new Set(registeredGuards);

  const save = useMutation({
    mutationFn: async (reason: string) => api.patch(`/workflows/${def.entity}`, { states, transitions, reason }),
    onSuccess: () => {
      toast.success('Workflow saved');
      qc.invalidateQueries({ queryKey: ['workflows'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={def.name} description={`Version ${def.version} · starts at “${labelOf(def.initialState)}”`} />
        <CardBody>
          <ol className="flex flex-wrap items-center gap-1.5" aria-label="Statuses">
            {states.map((s, i) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <Badge tone={s.tone}>{s.label}</Badge>
                {i < states.length - 1 && <ArrowRight className="h-3 w-3 text-slate-300" aria-hidden />}
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Statuses" description="Labels and badge colours shown throughout the application." />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Key</th>
                <th className="px-4 py-2">Label</th>
                <th className="px-4 py-2">Colour</th>
                <th className="px-4 py-2">Type</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {states.map((s, i) => {
                const orig = def.states[i]!;
                return (
                  <tr key={s.key}>
                    <td className="px-4 py-2">
                      <code className="text-xs">{s.key}</code>
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        aria-label={`Label for ${s.key}`}
                        value={s.label}
                        disabled={!canEdit}
                        maxLength={60}
                        onChange={(e) => setStates(states.map((x) => (x.key === s.key ? { ...x, label: e.target.value } : x)))}
                      />
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <Select
                          aria-label={`Colour for ${s.key}`}
                          value={s.tone}
                          disabled={!canEdit}
                          onChange={(e) => setStates(states.map((x) => (x.key === s.key ? { ...x, tone: e.target.value as StatusTone } : x)))}
                        >
                          {STATUS_TONES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </Select>
                        <Badge tone={s.tone}>{s.label || s.key}</Badge>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500">
                      {orig.terminal ? 'Final' : 'Open'}
                      {orig.locked ? ' · read-only' : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader title="Transitions" description="Who can move a record between statuses, and the rules checked first." />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Action</th>
                <th className="px-4 py-2">From → To</th>
                <th className="px-4 py-2">Permission</th>
                <th className="px-4 py-2">Rules</th>
                <th className="px-4 py-2">Enabled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {def.transitions.map((t) => {
                const d = transitions.find((x) => x.action === t.action)!;
                return (
                  <tr key={t.action} className="align-top">
                    <td className="px-4 py-2">
                      <Input
                        aria-label={`Label for action ${t.action}`}
                        value={d.label}
                        disabled={!canEdit}
                        maxLength={60}
                        onChange={(e) => setTransitions(transitions.map((x) => (x.action === t.action ? { ...x, label: e.target.value } : x)))}
                      />
                      <div className="mt-1 flex flex-wrap gap-1">
                        {t.systemOnly && (
                          <Badge tone="neutral">
                            <Cog className="h-3 w-3" /> Automatic
                          </Badge>
                        )}
                        {t.requiresReason && <Badge tone="warning">Reason required</Badge>}
                        {t.confirm && <Badge tone="info">Confirmation</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap items-center gap-1">
                        {t.from.map((f) => (
                          <Badge key={f} tone={toneOf(f)}>
                            {labelOf(f)}
                          </Badge>
                        ))}
                        <ArrowRight className="h-3 w-3 text-slate-400" aria-label="to" />
                        <Badge tone={toneOf(t.to)}>{labelOf(t.to)}</Badge>
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <code className="text-xs">{t.permission}</code>
                    </td>
                    <td className="px-4 py-2">
                      {t.guards.length ? (
                        <ul className="space-y-0.5 text-xs">
                          {t.guards.map((g) => (
                            <li key={g} className={guardSet.has(g) ? 'text-slate-700' : 'text-amber-700'} title={guardSet.has(g) ? 'Active' : 'Arrives with its module; until then this step is blocked'}>
                              {humanize(g)}
                              {!guardSet.has(g) && ' (pending)'}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {t.optional ? (
                        <Switch
                          aria-label={`Enable ${t.label}`}
                          checked={d.enabled}
                          disabled={!canEdit}
                          onCheckedChange={(v) => setTransitions(transitions.map((x) => (x.action === t.action ? { ...x, enabled: v } : x)))}
                        />
                      ) : (
                        <span className="text-xs text-slate-500">Mandatory</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {canEdit && (
        <div className="flex gap-2">
          <Button disabled={!dirty || states.some((s) => !s.label.trim()) || transitions.some((t) => !t.label.trim())} onClick={() => setConfirm(true)}>
            Save workflow
          </Button>
          {dirty && (
            <Button
              variant="outline"
              onClick={() => {
                setStates(initialStates);
                setTransitions(initialTransitions);
              }}
            >
              Discard
            </Button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Save workflow changes?"
        description="Labels and colours change everywhere immediately. Disabled optional steps are no longer available to users."
        confirmLabel="Save"
        reason="required"
        onConfirm={(reason) => save.mutateAsync(reason)}
      />
    </div>
  );
}
