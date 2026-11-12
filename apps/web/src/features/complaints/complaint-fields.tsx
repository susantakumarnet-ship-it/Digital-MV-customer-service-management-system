import { useId, useRef, useState } from 'react';
import { FileText, Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormField, Select } from '@/components/ui/form';
import { formatBytes, precheckFiles, useLookup, type AttachmentPolicy, type OptionSource } from './complaint-lib';

export interface LocationValue {
  regionId?: string;
  cityId?: string;
  siteId?: string;
  assetId?: string;
  equipmentTypeId?: string;
}

/**
 * Cascading Region › City › Site › Asset › Equipment type (PUB-02). Changing a parent clears its
 * children; choosing an asset fills (and locks) the equipment type from the asset master.
 * The server re-validates the whole chain.
 */
export function LocationFields({
  source,
  value,
  onChange,
  errors = {},
  showAsset = true,
  required = true,
}: {
  source: OptionSource;
  value: LocationValue;
  onChange: (next: LocationValue) => void;
  errors?: Partial<Record<keyof LocationValue, string>>;
  showAsset?: boolean;
  required?: boolean;
}) {
  const regions = useLookup(source, 'regions');
  const cities = useLookup(source, 'cities', { parentField: 'regionId', parentId: value.regionId });
  const sites = useLookup(source, 'sites', { parentField: 'cityId', parentId: value.cityId });
  const assets = useLookup(source, 'assets', { parentField: 'siteId', parentId: value.siteId, enabled: showAsset });
  const equipment = useLookup(source, 'equipmentTypes', { enabled: showAsset });

  const selectedAsset = assets.data?.find((a) => a.id === value.assetId);
  const placeholder = (loading: boolean, parentMissing: boolean, label: string) =>
    loading ? 'Loading…' : parentMissing ? `Select ${label} first` : 'Select…';

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <FormField label="Region" required={required} error={errors.regionId}>
        {(p) => (
          <Select {...p} value={value.regionId ?? ''} onChange={(e) => onChange({ regionId: e.target.value || undefined })}>
            <option value="">{placeholder(regions.isLoading, false, '')}</option>
            {regions.data?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label="City" required={required} error={errors.cityId}>
        {(p) => (
          <Select
            {...p}
            value={value.cityId ?? ''}
            disabled={!value.regionId}
            onChange={(e) => onChange({ regionId: value.regionId, cityId: e.target.value || undefined })}
          >
            <option value="">{placeholder(cities.isFetching, !value.regionId, 'a region')}</option>
            {cities.data?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label="Site" required={required} error={errors.siteId} className="sm:col-span-2">
        {(p) => (
          <Select
            {...p}
            value={value.siteId ?? ''}
            disabled={!value.cityId}
            onChange={(e) => onChange({ regionId: value.regionId, cityId: value.cityId, siteId: e.target.value || undefined })}
          >
            <option value="">{placeholder(sites.isFetching, !value.cityId, 'a city')}</option>
            {sites.data?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label} ({o.code})
              </option>
            ))}
          </Select>
        )}
      </FormField>
      {showAsset && (
        <>
          <FormField label="Asset" error={errors.assetId} help="Optional — choose if you know which asset is affected.">
            {(p) => (
              <Select
                {...p}
                value={value.assetId ?? ''}
                disabled={!value.siteId}
                onChange={(e) => {
                  const asset = assets.data?.find((a) => a.id === e.target.value);
                  onChange({ ...value, assetId: e.target.value || undefined, equipmentTypeId: asset?.equipmentTypeId ?? value.equipmentTypeId });
                }}
              >
                <option value="">{!value.siteId ? 'Select a site first' : assets.isFetching ? 'Loading…' : 'Not specified'}</option>
                {assets.data?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label} ({o.code})
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField
            label="Equipment type"
            error={errors.equipmentTypeId}
            help={selectedAsset ? 'Taken from the selected asset.' : 'Optional.'}
          >
            {(p) => (
              <Select
                {...p}
                value={value.equipmentTypeId ?? ''}
                disabled={Boolean(selectedAsset)}
                onChange={(e) => onChange({ ...value, equipmentTypeId: e.target.value || undefined })}
              >
                <option value="">Not specified</option>
                {equipment.data?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </>
      )}
    </div>
  );
}

/** File chooser with client-side policy pre-check and a removable list. */
export function FilePicker({
  files,
  onChange,
  policy,
  existing,
  label = 'Attachments',
  disabled,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  policy?: AttachmentPolicy;
  existing?: { count: number; bytes: number };
  label?: string;
  disabled?: boolean;
}) {
  const inputId = useId();
  const ref = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const add = (list: FileList | null) => {
    if (!list || !policy) return;
    const base = { count: (existing?.count ?? 0) + files.length, bytes: (existing?.bytes ?? 0) + files.reduce((a, f) => a + f.size, 0) };
    const { accepted, errors: errs } = precheckFiles(Array.from(list), policy, base);
    setErrors(errs);
    if (accepted.length) onChange([...files, ...accepted]);
    if (ref.current) ref.current.value = '';
  };

  return (
    <div>
      <label htmlFor={inputId} className="field-label">
        {label}
      </label>
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={() => ref.current?.click()} disabled={disabled || !policy}>
            <Paperclip className="h-4 w-4" /> Choose files
          </Button>
          <input
            id={inputId}
            ref={ref}
            type="file"
            multiple
            className="sr-only"
            accept={policy?.allowedExtensions.map((e) => `.${e}`).join(',')}
            onChange={(e) => add(e.target.files)}
            disabled={disabled || !policy}
          />
          {policy && (
            <span className="text-xs text-slate-500">
              {policy.allowedExtensions.map((e) => e.toUpperCase()).join(', ')} · up to {policy.maxFileSizeMb} MB each · max {policy.maxFilesPerRecord} files,{' '}
              {policy.maxTotalSizeMbPerRecord} MB total
            </span>
          )}
        </div>
        {errors.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs text-red-600" role="alert">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        {files.length > 0 && (
          <ul className="mt-3 divide-y divide-border rounded-md border border-border bg-white">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-2 px-3 py-2">
                <FileText className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="text-xs text-slate-500">{formatBytes(f.size)}</span>
                <button
                  type="button"
                  className="rounded p-1 text-slate-500 hover:bg-slate-100"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => onChange(files.filter((_, j) => j !== i))}
                  disabled={disabled}
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
