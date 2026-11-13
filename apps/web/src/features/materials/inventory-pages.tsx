import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, PackagePlus, Plus, ShieldCheck, SlidersHorizontal, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { STOCK_TRANSACTION_TYPES, type StockBalanceDto, type StockTransactionDto, type StockTransactionType } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, SheetContent } from '@/components/ui/dialog';
import { FormField, Input, Select, Textarea } from '@/components/ui/form';
import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { ErrorState } from '@/components/states';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage, parseApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useMasterOptions } from '@/lib/queries';
import { useDebounced } from '@/lib/use-debounced';
import { formatQty, TRANSACTION_LABELS, transactionTone, useBalances, useLedger, type CatalogueItem, type ReconcileResult } from './material-lib';
import { ItemPicker } from './request-form';

function useParamsUpdater() {
  const [sp, setSp] = useSearchParams();
  const update = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setSp(next, { replace: true });
  };
  return [sp, update] as const;
}

function useInvalidateInventory() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ['inventory'] });
}

/** Stock level cell with a "Low stock" badge at or below the reorder level. */
export function StockLevel({ b }: { b: StockBalanceDto }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="tabular-nums">{formatQty(b.available, b.item.unit)}</span>
      {b.lowStock && <Badge tone="danger">Low stock</Badge>}
    </span>
  );
}

// ---- Balances ------------------------------------------------------------------------------------

export function InventoryPage() {
  const { hasPermission } = useAuth();
  const canAdjust = hasPermission('inventory.adjust');
  const [sp, update] = useParamsUpdater();
  const [search, setSearch] = useState(sp.get('q') ?? '');
  const q = useDebounced(search, 300);
  const warehouseId = sp.get('warehouseId') ?? '';
  const lowStock = sp.get('lowStock') === 'true';
  const page = Number(sp.get('page') ?? 1) || 1;
  const warehouses = useMasterOptions('warehouses');
  const balances = useBalances({ q: q || undefined, warehouseId: warehouseId || undefined, lowStock: lowStock ? 'true' : undefined, page, limit: 25 });
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [adjust, setAdjust] = useState<{ open: boolean; balance?: StockBalanceDto }>({ open: false });
  const [itemId, setItemId] = useState<string | null>(null);

  const columns: Column<StockBalanceDto>[] = [
    {
      key: 'item',
      header: 'Item',
      cell: (b) => (
        <button type="button" className="min-w-0 text-left" onClick={() => setItemId(b.item.id)}>
          <span className="block font-medium text-royal-700 hover:underline">{b.item.name}</span>
          <span className="font-mono text-xs text-slate-500">{b.item.code}</span>
        </button>
      ),
    },
    { key: 'warehouse', header: 'Warehouse', cell: (b) => b.warehouse.name },
    { key: 'onHand', header: 'On hand', cell: (b) => <span className="tabular-nums">{formatQty(b.onHand, b.item.unit)}</span>, hideOnMobile: true },
    { key: 'reserved', header: 'Reserved', cell: (b) => <span className="tabular-nums">{formatQty(b.reserved)}</span>, hideOnMobile: true },
    { key: 'available', header: 'Available', cell: (b) => <StockLevel b={b} /> },
    { key: 'reorder', header: 'Reorder at', cell: (b) => (b.item.reorderLevel == null ? '—' : formatQty(b.item.reorderLevel)), hideOnMobile: true },
    ...(canAdjust
      ? [
          {
            key: 'actions',
            header: 'Actions',
            cell: (b: StockBalanceDto) => (
              <Button size="sm" variant="ghost" onClick={() => setAdjust({ open: true, balance: b })} aria-label={`Adjust ${b.item.name} at ${b.warehouse.name}`}>
                <SlidersHorizontal className="h-4 w-4" />
              </Button>
            ),
          } as Column<StockBalanceDto>,
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Inventory"
        description="Stock on hand by warehouse. Every movement is recorded in the ledger."
        actions={
          <>
            <Link to="/inventory/ledger" className="inline-flex h-10 items-center rounded-lg border border-border px-3 text-sm font-medium text-slate-700 hover:bg-slate-50">
              Stock ledger
            </Link>
            {canAdjust && (
              <>
                <Button variant="outline" onClick={() => setAdjust({ open: true })}>
                  <SlidersHorizontal className="h-4 w-4" /> Adjust
                </Button>
                <Button onClick={() => setReceiveOpen(true)}>
                  <PackagePlus className="h-4 w-4" /> Receive stock
                </Button>
              </>
            )}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search items"
          placeholder="Search item code or name"
          className="max-w-xs"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            update({ q: e.target.value || undefined, page: undefined });
          }}
        />
        <Select aria-label="Warehouse" className="max-w-56" value={warehouseId} onChange={(e) => update({ warehouseId: e.target.value || undefined, page: undefined })}>
          <option value="">All warehouses</option>
          {warehouses.data?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </Select>
        <label className="inline-flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={lowStock} onChange={(e) => update({ lowStock: e.target.checked ? 'true' : undefined, page: undefined })} />
          Low stock only
        </label>
      </div>
      <Card>
        <DataTable
          columns={columns}
          rows={balances.data?.data}
          rowKey={(b) => `${b.item.id}:${b.warehouse.id}`}
          loading={balances.isLoading}
          error={balances.error}
          onRetry={() => balances.refetch()}
          page={balances.data?.meta.page}
          pages={balances.data?.meta.pages}
          total={balances.data?.meta.total}
          limit={balances.data?.meta.limit}
          onPageChange={(p) => update({ page: String(p) })}
          emptyTitle={lowStock ? 'Nothing is low on stock' : 'No stock recorded'}
          emptyDescription={canAdjust && !lowStock ? 'Receive stock or record opening balances to get started.' : undefined}
          caption="Stock balances"
        />
      </Card>
      {canAdjust && <IntegrityCheck />}
      {canAdjust && <ReceiveDialog open={receiveOpen} onOpenChange={setReceiveOpen} />}
      {canAdjust && <AdjustDialog open={adjust.open} balance={adjust.balance} onOpenChange={(o) => setAdjust((cur) => ({ ...cur, open: o }))} />}
      <ItemDrawer itemId={itemId} onClose={() => setItemId(null)} />
    </div>
  );
}

// ---- Receive / opening balance -------------------------------------------------------------------

interface ReceiptLine {
  key: string;
  item: CatalogueItem | null;
  quantity: string;
  batchNo: string;
}
const newReceiptLine = (): ReceiptLine => ({ key: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`, item: null, quantity: '', batchNo: '' });

export function ReceiveDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const invalidate = useInvalidateInventory();
  const warehouses = useMasterOptions('warehouses', { enabled: open });
  const [warehouseId, setWarehouseId] = useState('');
  const [type, setType] = useState<'RECEIPT' | 'OPENING'>('RECEIPT');
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<ReceiptLine[]>([newReceiptLine()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setWarehouseId('');
      setType('RECEIPT');
      setReference('');
      setLines([newReceiptLine()]);
      setErrors({});
    }
  }, [open]);
  const setLine = (key: string, patch: Partial<ReceiptLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!warehouseId) e.warehouseId = 'Select a warehouse';
    lines.forEach((l, i) => {
      if (!l.item) e[`lines.${i}.item`] = 'Select an item';
      const n = Number(l.quantity);
      if (l.quantity.trim() === '' || !(n > 0)) e[`lines.${i}.quantity`] = 'Enter a quantity greater than zero';
    });
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api.post('/inventory/receipts', {
        warehouseId,
        type,
        reference: reference.trim() || undefined,
        lines: lines.map((l) => ({ itemId: l.item!.id, quantity: Number(l.quantity), batchNo: l.batchNo.trim() || undefined })),
      });
      invalidate();
      toast.success(type === 'OPENING' ? 'Opening balance recorded' : 'Stock received');
      onOpenChange(false);
    } catch (err) {
      const pe = parseApiError(err);
      if (pe.fields) setErrors(pe.fields);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="xl"
        title="Receive stock"
        description="Adds stock to a warehouse and records a ledger entry per line."
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy}>
              Record receipt
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="Warehouse" required error={errors.warehouseId}>
              {(p) => (
                <Select {...p} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  <option value="">Select warehouse</option>
                  {warehouses.data?.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.label}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label="Type">
              {(p) => (
                <Select {...p} value={type} onChange={(e) => setType(e.target.value as 'RECEIPT' | 'OPENING')}>
                  <option value="RECEIPT">Goods receipt</option>
                  <option value="OPENING">Opening balance</option>
                </Select>
              )}
            </FormField>
            <FormField label="Reference" help="Delivery note or PO number">
              {(p) => <Input {...p} maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} />}
            </FormField>
          </div>
          {lines.map((l, i) => (
            <fieldset key={l.key} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[1fr_8rem_10rem_auto]">
              <legend className="px-1 text-xs font-medium text-slate-500">Line {i + 1}</legend>
              <FormField label="Item" required error={errors[`lines.${i}.item`]}>
                {(p) => <ItemPicker id={p.id} value={l.item} onChange={(item) => setLine(l.key, { item })} invalid={Boolean(errors[`lines.${i}.item`])} />}
              </FormField>
              <FormField label={`Quantity${l.item ? ` (${l.item.unit})` : ''}`} required error={errors[`lines.${i}.quantity`]}>
                {(p) => <Input {...p} type="number" inputMode="decimal" min={0} step="any" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} />}
              </FormField>
              <FormField label="Batch">
                {(p) => <Input {...p} maxLength={120} value={l.batchNo} onChange={(e) => setLine(l.key, { batchNo: e.target.value })} />}
              </FormField>
              <div className="flex items-end">
                <Button variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </fieldset>
          ))}
          <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, newReceiptLine()])} disabled={lines.length >= 200}>
            <Plus className="h-4 w-4" /> Add line
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- Adjustment ----------------------------------------------------------------------------------

export function AdjustDialog({ open, onOpenChange, balance }: { open: boolean; onOpenChange: (o: boolean) => void; balance?: StockBalanceDto }) {
  const invalidate = useInvalidateInventory();
  const warehouses = useMasterOptions('warehouses', { enabled: open });
  const [warehouseId, setWarehouseId] = useState('');
  const [item, setItem] = useState<CatalogueItem | null>(null);
  const [direction, setDirection] = useState<'in' | 'out'>('out');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setWarehouseId(balance?.warehouse.id ?? '');
      setItem(balance ? { id: balance.item.id, code: balance.item.code ?? '', name: balance.item.name, unit: balance.item.unit } : null);
      setDirection('out');
      setQty('');
      setReason('');
      setErrors({});
    }
  }, [open, balance]);
  const submit = async () => {
    const e: Record<string, string> = {};
    const n = Number(qty);
    if (!warehouseId) e.warehouseId = 'Select a warehouse';
    if (!item) e.itemId = 'Select an item';
    if (qty.trim() === '' || !(n > 0)) e.delta = 'Enter a quantity greater than zero';
    else if (direction === 'out' && balance && balance.item.id === item?.id && balance.warehouse.id === warehouseId && n > balance.available)
      e.delta = `Only ${formatQty(balance.available, balance.item.unit)} is available (reserved stock cannot be adjusted out)`;
    if (reason.trim().length < 3) e.reason = 'A reason is required';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await api.post('/inventory/adjustments', { warehouseId, itemId: item!.id, delta: direction === 'in' ? n : -n, reason: reason.trim() });
      invalidate();
      toast.success('Stock adjusted');
      onOpenChange(false);
    } catch (err) {
      const pe = parseApiError(err);
      if (pe.fields) setErrors(pe.fields);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        title="Adjust stock"
        description="Corrections after a stock count, damage or loss. Recorded in the ledger with your reason."
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy}>
              Save adjustment
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormField label="Warehouse" required error={errors.warehouseId}>
            {(p) => (
              <Select {...p} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                <option value="">Select warehouse</option>
                {warehouses.data?.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Item" required error={errors.itemId}>
            {(p) => <ItemPicker id={p.id} value={item} onChange={setItem} invalid={Boolean(errors.itemId)} />}
          </FormField>
          <div role="radiogroup" aria-label="Direction" className="flex gap-2">
            {(['out', 'in'] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={direction === d}
                onClick={() => setDirection(d)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${direction === d ? 'border-royal-700 bg-royal-50 text-royal-800' : 'border-border text-slate-700'}`}
              >
                {d === 'out' ? 'Remove stock' : 'Add stock'}
              </button>
            ))}
          </div>
          <FormField label={`Quantity${item ? ` (${item.unit})` : ''}`} required error={errors.delta}>
            {(p) => <Input {...p} type="number" inputMode="decimal" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} />}
          </FormField>
          <FormField label="Reason" required error={errors.reason}>
            {(p) => <Textarea {...p} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- Item drawer ---------------------------------------------------------------------------------

interface ItemStock {
  item: { id: string; name: string; code?: string; unit: string; reorderLevel: number | null };
  balances: StockBalanceDto[];
}

function ItemDrawer({ itemId, onClose }: { itemId: string | null; onClose: () => void }) {
  const stock = useQuery({
    queryKey: ['inventory', 'item', itemId],
    queryFn: async () => (await api.get<ItemStock>(`/inventory/items/${itemId}`)).data,
    enabled: Boolean(itemId),
  });
  const ledger = useLedger({ itemId: itemId ?? undefined, limit: 15, sort: '-transactionAt' }, Boolean(itemId));
  const it = stock.data?.item;
  return (
    <Dialog open={Boolean(itemId)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={it ? `${it.name}` : 'Item'} description={it ? `${it.code ?? ''} · unit ${it.unit}${it.reorderLevel != null ? ` · reorder at ${formatQty(it.reorderLevel)}` : ''}` : undefined}>
        {stock.isError ? (
          <ErrorState error={stock.error} onRetry={() => stock.refetch()} />
        ) : stock.isLoading ? (
          <div className="skeleton h-32" />
        ) : (
          <div className="space-y-5">
            <section>
              <h3 className="mb-2 text-sm font-semibold text-navy-900">By warehouse</h3>
              {stock.data?.balances.length ? (
                <ul className="divide-y divide-border rounded-lg border border-border text-sm">
                  {stock.data.balances.map((b) => (
                    <li key={b.warehouse.id} className="flex items-center justify-between gap-2 px-3 py-2">
                      <span>{b.warehouse.name}</span>
                      <span className="text-right text-xs text-slate-600">
                        <StockLevel b={b} />
                        <span className="block">
                          {formatQty(b.onHand)} on hand · {formatQty(b.reserved)} reserved
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">No stock in any warehouse.</p>
              )}
            </section>
            <section>
              <h3 className="mb-2 text-sm font-semibold text-navy-900">Recent movements</h3>
              {ledger.data?.data.length ? (
                <ul className="space-y-2 text-sm">
                  {ledger.data.data.map((t) => (
                    <li key={t.id} className="flex items-start justify-between gap-2">
                      <span>
                        <Badge tone={transactionTone(t.type)}>{TRANSACTION_LABELS[t.type]}</Badge> <span className="text-slate-600">{t.warehouse.name}</span>
                        <span className="block text-xs text-slate-500">
                          {formatDateTime(t.transactionAt)} · {t.actorName}
                        </span>
                      </span>
                      <span className="tabular-nums">{formatQty(t.quantity)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">No movements yet.</p>
              )}
              {itemId && (
                <Link to={`/inventory/ledger?itemId=${itemId}`} className="mt-2 inline-block text-sm font-medium text-royal-700 hover:underline">
                  Full ledger for this item
                </Link>
              )}
            </section>
          </div>
        )}
      </SheetContent>
    </Dialog>
  );
}

// ---- Integrity check -----------------------------------------------------------------------------

function IntegrityCheck() {
  const [result, setResult] = useState<ReconcileResult | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      setResult((await api.get<ReconcileResult>('/inventory/reconcile')).data);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader
        title="Ledger integrity"
        description="Recomputes every balance from the ledger and reports any difference."
        actions={
          <Button size="sm" variant="outline" onClick={run} loading={busy}>
            <ShieldCheck className="h-4 w-4" /> Run check
          </Button>
        }
      />
      {result && (
        <CardBody>
          {result.consistent ? (
            <p className="flex items-center gap-2 text-sm text-teal-700" role="status">
              <CheckCircle2 className="h-4 w-4" aria-hidden /> All {result.checked} balances match the ledger.
            </p>
          ) : (
            <div role="alert" className="text-sm">
              <p className="font-medium text-red-700">{result.drift.length} balance(s) differ from the ledger.</p>
              <ul className="mt-2 space-y-1 font-mono text-xs text-slate-700">
                {result.drift.map((d) => (
                  <li key={`${d.itemId}:${d.warehouseId}`}>
                    item {d.itemId} @ {d.warehouseId}: on hand {d.balanceOnHand} vs ledger {d.ledgerOnHand}; reserved {d.balanceReserved} vs ledger {d.ledgerReserved}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardBody>
      )}
    </Card>
  );
}

// ---- Ledger --------------------------------------------------------------------------------------

export function LedgerPage() {
  const [sp, update] = useParamsUpdater();
  const warehouses = useMasterOptions('warehouses');
  const page = Number(sp.get('page') ?? 1) || 1;
  const type = sp.get('type') ?? '';
  const warehouseId = sp.get('warehouseId') ?? '';
  const itemId = sp.get('itemId') ?? '';
  const from = sp.get('from') ?? '';
  const to = sp.get('to') ?? '';
  const ledger = useLedger({
    page,
    limit: 50,
    sort: '-transactionAt',
    type: type || undefined,
    warehouseId: warehouseId || undefined,
    itemId: itemId || undefined,
    from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
    to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
  });
  const columns: Column<StockTransactionDto>[] = [
    { key: 'at', header: 'When', cell: (t) => <span className="whitespace-nowrap">{formatDateTime(t.transactionAt)}</span> },
    { key: 'type', header: 'Type', cell: (t) => <Badge tone={transactionTone(t.type)}>{TRANSACTION_LABELS[t.type]}</Badge> },
    {
      key: 'item',
      header: 'Item',
      cell: (t) => (
        <span>
          {t.item.name}
          <span className="block font-mono text-xs text-slate-500">{t.item.code}</span>
        </span>
      ),
    },
    { key: 'qty', header: 'Quantity', cell: (t) => <span className="tabular-nums">{formatQty(t.quantity, t.item.unit)}</span> },
    { key: 'wh', header: 'Warehouse', cell: (t) => t.warehouse.name, hideOnMobile: true },
    {
      key: 'ref',
      header: 'Reference',
      cell: (t) =>
        t.reference?.type === 'materialRequest' ? (
          <Link to={`/materials/${t.reference.id}`} className="font-mono text-royal-700 hover:underline">
            {t.reference.label ?? 'Request'}
          </Link>
        ) : (
          (t.reference?.label ?? t.reason ?? '—')
        ),
      hideOnMobile: true,
    },
    { key: 'by', header: 'By', cell: (t) => t.actorName, hideOnMobile: true },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title="Stock ledger" description="Append-only record of every stock movement." />
      <div className="flex flex-wrap items-end gap-2">
        <Select aria-label="Transaction type" className="max-w-48" value={type} onChange={(e) => update({ type: e.target.value || undefined, page: undefined })}>
          <option value="">All types</option>
          {STOCK_TRANSACTION_TYPES.map((t: StockTransactionType) => (
            <option key={t} value={t}>
              {TRANSACTION_LABELS[t]}
            </option>
          ))}
        </Select>
        <Select aria-label="Warehouse" className="max-w-56" value={warehouseId} onChange={(e) => update({ warehouseId: e.target.value || undefined, page: undefined })}>
          <option value="">All warehouses</option>
          {warehouses.data?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </Select>
        <Input type="date" aria-label="From date" className="max-w-40" value={from} onChange={(e) => update({ from: e.target.value || undefined, page: undefined })} />
        <Input type="date" aria-label="To date" className="max-w-40" value={to} onChange={(e) => update({ to: e.target.value || undefined, page: undefined })} />
        {itemId && (
          <Button variant="ghost" size="sm" onClick={() => update({ itemId: undefined, page: undefined })}>
            Clear item filter
          </Button>
        )}
      </div>
      <Card>
        <DataTable
          columns={columns}
          rows={ledger.data?.data}
          rowKey={(t) => t.id}
          loading={ledger.isLoading}
          error={ledger.error}
          onRetry={() => ledger.refetch()}
          page={ledger.data?.meta.page}
          pages={ledger.data?.meta.pages}
          total={ledger.data?.meta.total}
          limit={ledger.data?.meta.limit}
          onPageChange={(p) => update({ page: String(p) })}
          emptyTitle="No movements"
          emptyDescription="Nothing matches these filters."
          caption="Stock ledger"
        />
      </Card>
    </div>
  );
}
