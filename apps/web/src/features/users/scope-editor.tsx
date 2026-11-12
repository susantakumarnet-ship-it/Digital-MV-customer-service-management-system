import type { UserScope } from '@mv/shared';
import { MultiSelect } from '@/components/multi-select';
import { Switch } from '@/components/ui/controls';
import { Label } from '@/components/ui/form';
import { useAuth } from '@/features/auth/auth-context';
import { useMasterOptions } from '@/lib/queries';

/**
 * Data-scope editor (RBAC-05). Global access, or any combination of organisations / regions / sites.
 * The server rejects grants outside the administrator's own scope; options are limited accordingly.
 */
export function ScopeEditor({ value, onChange, errors }: { value: UserScope; onChange: (s: UserScope) => void; errors?: Record<string, string | undefined> }) {
  const { user } = useAuth();
  const actorGlobal = Boolean(user?.scope.global);
  const orgs = useMasterOptions('organizations');
  const regions = useMasterOptions('regions');
  const sites = useMasterOptions('sites');

  const limit = (ids: string[] | undefined, opts: { id: string; label: string; code: string }[] | undefined) =>
    (opts ?? []).filter((o) => actorGlobal || ids?.includes(o.id)).map((o) => ({ value: o.id, label: o.label, hint: o.code }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <Label htmlFor="scope-global" className="mb-0">
            Global access
          </Label>
          <p className="text-xs text-slate-500">All organisations, regions and sites — including future ones.</p>
        </div>
        <Switch
          id="scope-global"
          checked={value.global}
          disabled={!actorGlobal}
          onCheckedChange={(g) => onChange({ ...value, global: g })}
        />
      </div>
      {!value.global && (
        <>
          <ScopeField label="Organizations" id="scope-orgs" error={errors?.['scope.organizationIds']}>
            <MultiSelect
              id="scope-orgs"
              loading={orgs.isLoading}
              options={limit(user?.scope.organizationIds, orgs.data)}
              value={value.organizationIds}
              onChange={(v) => onChange({ ...value, organizationIds: v })}
            />
          </ScopeField>
          <ScopeField label="Regions" id="scope-regions" error={errors?.['scope.regionIds']}>
            <MultiSelect
              id="scope-regions"
              loading={regions.isLoading}
              options={limit(user?.scope.regionIds, regions.data)}
              value={value.regionIds}
              onChange={(v) => onChange({ ...value, regionIds: v })}
            />
          </ScopeField>
          <ScopeField label="Sites" id="scope-sites" error={errors?.['scope.siteIds']}>
            <MultiSelect
              id="scope-sites"
              loading={sites.isLoading}
              options={limit(user?.scope.siteIds, sites.data)}
              value={value.siteIds}
              onChange={(v) => onChange({ ...value, siteIds: v })}
            />
          </ScopeField>
          {!value.organizationIds.length && !value.regionIds.length && !value.siteIds.length && (
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
              With no scope selected the user will only see records they are personally assigned to.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function ScopeField({ label, id, error, children }: { label: string; id: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
