/** Pretty JSON block for audit payloads (already redacted server-side). */
export function JsonView({ value, label }: { value: unknown; label: string }) {
  const empty = value === null || value === undefined || (typeof value === 'object' && Object.keys(value as object).length === 0);
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      {empty ? (
        <p className="text-sm text-slate-400">—</p>
      ) : (
        <pre className="max-h-80 overflow-auto rounded-lg bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}
