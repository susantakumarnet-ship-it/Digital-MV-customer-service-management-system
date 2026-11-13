import { useQuery } from '@tanstack/react-query';
import {
  MATERIAL_URGENCIES,
  type MaterialRequestDetailDto,
  type MaterialRequestSummaryDto,
  type MaterialUrgency,
  type Paged,
  type StockBalanceDto,
  type StockTransactionDto,
  type StockTransactionType,
} from '@mv/shared';
import type { StatusTone } from '@mv/shared';
import { api, parseApiError } from '@/lib/api';

export { MATERIAL_URGENCIES };

// ---- Types -----------------------------------------------------------------------------------------

export interface MaterialSummary {
  pendingApproval: number;
  clarification: number;
  readyToIssue: number;
  partiallyIssued: number;
  issued: number;
  criticalOpen: number;
  total: number;
}

export interface ReconcileResult {
  checked: number;
  consistent: boolean;
  drift: { itemId: string; warehouseId: string; ledgerOnHand: number; balanceOnHand: number; ledgerReserved: number; balanceReserved: number }[];
}

/** A catalogue item as picked in the line editor (unit comes from the master record). */
export interface CatalogueItem {
  id: string;
  code: string;
  name: string;
  unit: string;
  specification?: string;
}

/** One editable request line. Quantity is kept as text while typing. */
export interface LineDraft {
  key: string;
  item: CatalogueItem | null;
  quantity: string;
  specification: string;
  reason: string;
}

// ---- Display helpers ---------------------------------------------------------------------------

const URGENCY_RANK: Record<MaterialUrgency, number> = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

export function urgencyTone(u: MaterialUrgency): StatusTone {
  return u === 'CRITICAL' ? 'danger' : u === 'HIGH' ? 'warning' : u === 'NORMAL' ? 'info' : 'neutral';
}
export function urgencyLabel(u: MaterialUrgency) {
  return MATERIAL_URGENCIES.find((x) => x.value === u)?.label ?? u;
}

/** Store queue order: most urgent first, then oldest submission. */
export function sortForStore<T extends Pick<MaterialRequestSummaryDto, 'urgency' | 'submittedAt' | 'createdAt'>>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const u = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
    if (u) return u;
    return new Date(a.submittedAt ?? a.createdAt).getTime() - new Date(b.submittedAt ?? b.createdAt).getTime();
  });
}

/** Quantities may be fractional (metres, litres); show up to 3 decimals without trailing zeros. */
export function formatQty(n: number | null | undefined, unit?: string) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const s = Number(n.toFixed(3)).toString();
  return unit ? `${s} ${unit}` : s;
}

export const TRANSACTION_LABELS: Record<StockTransactionType, string> = {
  OPENING: 'Opening balance',
  RECEIPT: 'Receipt',
  RESERVE: 'Reserved',
  UNRESERVE: 'Reservation released',
  ISSUE: 'Issued',
  RETURN: 'Returned to stock',
  DAMAGE: 'Damaged / unusable',
  ADJUST_IN: 'Adjustment +',
  ADJUST_OUT: 'Adjustment −',
};
export function transactionTone(t: StockTransactionType): StatusTone {
  switch (t) {
    case 'OPENING':
    case 'RECEIPT':
    case 'RETURN':
    case 'ADJUST_IN':
      return 'success';
    case 'ISSUE':
      return 'primary';
    case 'RESERVE':
    case 'UNRESERVE':
      return 'info';
    case 'DAMAGE':
    case 'ADJUST_OUT':
      return 'danger';
  }
}

// ---- List tabs --------------------------------------------------------------------------------------

export const MATERIAL_TABS = [
  { key: 'pending', label: 'Pending approval', status: 'SUBMITTED' },
  { key: 'clarification', label: 'Clarification', status: 'CLARIFICATION_REQUIRED' },
  { key: 'approved', label: 'Approved', status: 'APPROVED' },
  { key: 'partial', label: 'Partially issued', status: 'PARTIALLY_ISSUED' },
  { key: 'issued', label: 'Issued', status: 'ISSUED,RETURNED' },
  { key: 'closed', label: 'Closed / rejected', status: 'CLOSED,REJECTED' },
  { key: 'all', label: 'All', status: undefined },
] as const;
export type MaterialTabKey = (typeof MATERIAL_TABS)[number]['key'];

/** Statuses still "open" for the requester (dashboard list). */
export const OPEN_MATERIAL_STATUSES = 'DRAFT,SUBMITTED,CLARIFICATION_REQUIRED,APPROVED,PARTIALLY_ISSUED,ISSUED,RETURNED';

export function buildMaterialParams(f: { tab?: string; q?: string; urgency?: string; mine?: boolean; page?: number; sort?: string }) {
  const tab = MATERIAL_TABS.find((t) => t.key === f.tab) ?? MATERIAL_TABS[MATERIAL_TABS.length - 1];
  const p: Record<string, string | number> = { page: f.page ?? 1, limit: 20, sort: f.sort ?? '-createdAt' };
  if (tab.status) p.status = tab.status;
  if (f.q) p.q = f.q;
  if (f.urgency) p.urgency = f.urgency;
  if (f.mine) p.mine = 'true';
  return p;
}

// ---- Validation (mirrors the shared Zod schemas; the server re-validates) ---------------------------

const positive = (s: string) => {
  const n = Number(s);
  return s.trim() !== '' && Number.isFinite(n) && n > 0;
};

/** Line editor validation (MAT-01): a catalogue item and a positive quantity on every line. */
export function validateLines(lines: LineDraft[]): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!lines.length) errors.lines = 'Add at least one item';
  lines.forEach((l, i) => {
    if (!l.item) errors[`lines.${i}.item`] = 'Select a catalogue item';
    if (!positive(l.quantity)) errors[`lines.${i}.quantity`] = 'Enter a quantity greater than zero';
    else if (Number(l.quantity) > 1_000_000) errors[`lines.${i}.quantity`] = 'Quantity is too large';
  });
  return errors;
}

export function linesPayload(lines: LineDraft[]) {
  return lines.map((l) => ({
    itemId: l.item!.id,
    quantity: Number(l.quantity),
    specification: l.specification.trim() || undefined,
    reason: l.reason.trim() || undefined,
  }));
}

export function newLine(): LineDraft {
  const key = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`;
  return { key, item: null, quantity: '', specification: '', reason: '' };
}

/** MAT-02: reject/clarify need a comment; approved quantities are 0…requested and not all zero. */
export function validateDecision(
  decision: 'APPROVE' | 'REJECT' | 'CLARIFY',
  comment: string,
  lines: { lineId: string; requested: number; approved: string }[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (decision !== 'APPROVE' && !comment.trim()) errors.comment = decision === 'REJECT' ? 'A reason is required to reject' : 'Explain what needs clarifying';
  if (decision === 'APPROVE') {
    let anyPositive = false;
    for (const l of lines) {
      const n = Number(l.approved);
      if (l.approved.trim() === '' || !Number.isFinite(n) || n < 0) errors[`line.${l.lineId}`] = 'Enter 0 or more';
      else if (n > l.requested) errors[`line.${l.lineId}`] = `Cannot exceed the requested ${l.requested}`;
      else if (n > 0) anyPositive = true;
    }
    if (!anyPositive && !Object.keys(errors).length) errors.lines = 'Approve at least one quantity, or reject the request';
  }
  return errors;
}

/** Caps a typed approved quantity at the requested amount (inputs never exceed the request). */
export function clampApproved(value: string, requested: number): string {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n)) return value;
  if (n > requested) return String(requested);
  if (n < 0) return '0';
  return value;
}

export interface IssueValues {
  warehouseId: string;
  quantity: string;
  batchNo: string;
  serialNumbers: string[];
  recipientName: string;
  note: string;
}

/** MAT-03: recipient required; serial numbers (when used) must match the quantity; within the approved outstanding. */
export function validateIssue(v: IssueValues, outstanding: number): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!v.warehouseId) errors.warehouseId = 'Select the issuing warehouse';
  if (!positive(v.quantity)) errors.quantity = 'Enter a quantity greater than zero';
  else if (Number(v.quantity) > outstanding) errors.quantity = `Only ${formatQty(outstanding)} remain approved for this line. A supervisor must revise the approval to issue more.`;
  if (v.recipientName.trim().length < 2) errors.recipientName = 'Who received the material?';
  if (v.serialNumbers.length && positive(v.quantity) && v.serialNumbers.length !== Number(v.quantity)) {
    errors.serialNumbers = `Enter one serial number per unit (${Number(v.quantity)}), or leave empty.`;
  }
  return errors;
}

export interface ReturnValues {
  warehouseId: string;
  goodQty: string;
  damagedQty: string;
  reason: string;
}

/** MAT-04: something must be returned, with a reason, and not more than is out. */
export function validateReturn(v: ReturnValues, returnable: number): Record<string, string> {
  const errors: Record<string, string> = {};
  const good = v.goodQty.trim() === '' ? 0 : Number(v.goodQty);
  const damaged = v.damagedQty.trim() === '' ? 0 : Number(v.damagedQty);
  if (!v.warehouseId) errors.warehouseId = 'Select the receiving warehouse';
  if (!Number.isFinite(good) || good < 0) errors.goodQty = 'Enter 0 or more';
  if (!Number.isFinite(damaged) || damaged < 0) errors.damagedQty = 'Enter 0 or more';
  if (!errors.goodQty && !errors.damagedQty) {
    if (good + damaged <= 0) errors.goodQty = 'Enter a quantity to return';
    else if (good + damaged > returnable) errors.goodQty = `At most ${formatQty(returnable)} can be returned for this line`;
  }
  if (v.reason.trim().length < 3) errors.reason = 'Explain the return';
  return errors;
}

/** Turns store API errors into actionable guidance (BR-013, stock shortages). */
export function describeStoreError(err: unknown): { message: string; hint?: string; code: string; outstanding?: number } {
  const e = parseApiError(err);
  const details = (axiosDetails(err) ?? {}) as { outstanding?: number };
  if (e.code === 'EXCEEDS_APPROVED') {
    return {
      code: e.code,
      message: e.message,
      outstanding: details.outstanding,
      hint: 'To issue more than approved, a supervisor must revise the approved quantity for this line (BR-013).',
    };
  }
  if (e.code === 'INSUFFICIENT_STOCK') {
    return { code: e.code, message: e.message, hint: 'Record a backorder for the shortfall, or choose another warehouse.' };
  }
  return { code: e.code, message: e.message };
}

function axiosDetails(err: unknown): unknown {
  const r = (err as { response?: { data?: { error?: { details?: unknown } } } })?.response;
  return r?.data?.error?.details;
}

// ---- Queries ---------------------------------------------------------------------------------------

export function useMaterialRequests(params: Record<string, string | number | undefined>, enabled = true) {
  return useQuery({
    queryKey: ['material-requests', 'list', params],
    queryFn: async () => (await api.get<Paged<MaterialRequestSummaryDto>>('/material-requests', { params })).data,
    enabled,
  });
}

export function useMaterialRequest(id: string | undefined) {
  return useQuery({
    queryKey: ['material-requests', 'detail', id],
    queryFn: async () => (await api.get<MaterialRequestDetailDto>(`/material-requests/${id}`)).data,
    enabled: Boolean(id),
  });
}

export function useMaterialSummary(enabled = true) {
  return useQuery({
    queryKey: ['material-requests', 'summary'],
    queryFn: async () => (await api.get<MaterialSummary>('/material-requests/summary')).data,
    enabled,
    refetchInterval: 60_000,
  });
}

export function useBalances(params: Record<string, string | number | undefined>, enabled = true) {
  return useQuery({
    queryKey: ['inventory', 'balances', params],
    queryFn: async () => (await api.get<Paged<StockBalanceDto>>('/inventory/balances', { params })).data,
    enabled,
  });
}

export function useLedger(params: Record<string, string | number | undefined>, enabled = true) {
  return useQuery({
    queryKey: ['inventory', 'ledger', params],
    queryFn: async () => (await api.get<Paged<StockTransactionDto>>('/inventory/ledger', { params })).data,
    enabled,
  });
}

/** Available stock of one item per warehouse (store dialogs, line editor hint). */
export function useItemAvailability(itemId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['inventory', 'balances', { itemId, limit: 100 }],
    queryFn: async () => (await api.get<Paged<StockBalanceDto>>('/inventory/balances', { params: { itemId, limit: 100 } })).data.data,
    enabled: Boolean(itemId) && enabled,
    staleTime: 15_000,
  });
}

export function availableIn(balances: StockBalanceDto[] | undefined, warehouseId: string) {
  return balances?.find((b) => b.warehouse.id === warehouseId)?.available ?? 0;
}

/** Catalogue search for the line editor (master list carries the unit, options do not). */
export function useCatalogueSearch(q: string, enabled = true) {
  return useQuery({
    queryKey: ['masters', 'inventoryItems', 'search', q],
    queryFn: async () =>
      (
        await api.get<Paged<Record<string, unknown>>>('/masters/inventoryItems', { params: { q: q || undefined, status: 'ACTIVE', limit: 50, sort: 'name' } })
      ).data.data.map(
        (r): CatalogueItem => ({
          id: String(r.id),
          code: String(r.code ?? ''),
          name: String(r.name ?? ''),
          unit: String(r.unit ?? ''),
          specification: r.specification ? String(r.specification) : undefined,
        }),
      ),
    enabled,
    staleTime: 60_000,
  });
}

/** Work-order statuses in which assigned engineers may raise material requests. */
export const REQUESTABLE_WO_STATUSES = ['ASSIGNED', 'ACCEPTED', 'SCHEDULED', 'IN_PROGRESS', 'ON_HOLD', 'WORK_COMPLETED', 'SUBMITTED'];
