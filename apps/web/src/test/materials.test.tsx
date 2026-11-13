import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_ROLES, type MaterialLineDto, type MaterialRequestDetailDto, type StockBalanceDto } from '@mv/shared';
import { visibleNav } from '@/app/navigation';
import { LinesEditor } from '@/features/materials/request-form';
import { DecisionPanel } from '@/features/materials/material-request-page';
import { IssueDialog, ReturnDialog } from '@/features/materials/store-dialogs';
import { StockLevel } from '@/features/materials/inventory-pages';
import { clampApproved, describeStoreError, newLine, sortForStore, validateDecision, validateIssue, validateLines, type LineDraft } from '@/features/materials/material-lib';
import { makeAuth, makeUser, Wrapper } from './utils';

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/api')>();
  return { ...orig, api: apiMock };
});

const ID = (n: number) => n.toString(16).padStart(24, '0');
const perms = (key: string) => SYSTEM_ROLES.find((r) => r.key === key)!.permissions;

function apiError(status: number, code: string, message: string, details?: unknown) {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError(message, 'ERR', config, null, { status, statusText: '', headers: {}, config, data: { error: { code, message, requestId: 'req-1', details } } });
}

function line(overrides: Partial<MaterialLineDto> = {}): MaterialLineDto {
  return {
    lineId: 'L1',
    item: { id: ID(50), name: 'SF6 gas cylinder', code: 'SF6-10', unit: 'pcs' },
    quantity: 10,
    approvedQty: 10,
    reservedQty: 0,
    issuedQty: 0,
    returnedQty: 0,
    damagedQty: 0,
    backorderQty: 0,
    outstandingQty: 10,
    reservations: [],
    ...overrides,
  };
}

function request(overrides: Partial<MaterialRequestDetailDto> = {}): MaterialRequestDetailDto {
  return {
    id: ID(1),
    requestNo: 'MR-2026-0001',
    status: 'SUBMITTED',
    statusLabel: 'Submitted',
    statusTone: 'info',
    urgency: 'NORMAL',
    workOrder: { id: ID(2), workOrderNo: 'WO-2026-0001' },
    complaint: { id: ID(3), referenceNo: 'CMP-2026-0001' },
    requester: { id: ID(4), name: 'Eli Engineer' },
    lineCount: 1,
    outstandingLines: 1,
    createdAt: '2026-11-13T08:00:00.000Z',
    reason: 'Top up breaker',
    lines: [line()],
    decisions: [],
    messages: [],
    transactions: [],
    attachments: [],
    statusHistory: [],
    availableActions: [],
    permissions: { canEdit: false, canSubmit: false, canDecide: true, canReviseApproval: false, canIssue: true, canReturn: false, canClose: false },
    ...overrides,
  };
}

function balance(overrides: Partial<StockBalanceDto> = {}): StockBalanceDto {
  return {
    item: { id: ID(50), name: 'SF6 gas cylinder', code: 'SF6-10', unit: 'pcs', reorderLevel: 5 },
    warehouse: { id: ID(60), name: 'Main store' },
    onHand: 20,
    reserved: 0,
    available: 20,
    lowStock: false,
    updatedAt: '2026-11-13T08:00:00.000Z',
    ...overrides,
  };
}

const storeAuth = () => makeAuth(makeUser(perms('STOREKEEPER')));

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.get.mockImplementation(async (url: string) => {
    if (url === '/masters/warehouses/options') return { data: [{ id: ID(60), label: 'Main store', code: 'MAIN', status: 'ACTIVE' }] };
    if (url === '/inventory/balances') return { data: { data: [balance()], meta: { page: 1, pages: 1, total: 1, limit: 100 } } };
    if (url === '/masters/inventoryItems') return { data: { data: [], meta: { page: 1, pages: 1, total: 0, limit: 50 } } };
    throw new Error(`unexpected GET ${url}`);
  });
});

describe('material helpers', () => {
  it('validateLines requires an item and a positive quantity per line', () => {
    const blank = newLine();
    expect(validateLines([blank])).toEqual({ 'lines.0.item': 'Select a catalogue item', 'lines.0.quantity': 'Enter a quantity greater than zero' });
    expect(validateLines([])).toEqual({ lines: 'Add at least one item' });
    const ok: LineDraft = { ...blank, item: { id: ID(50), code: 'X', name: 'X', unit: 'm' }, quantity: '2.5' };
    expect(validateLines([ok])).toEqual({});
  });
  it('validateDecision: reject needs a reason; approved never exceeds requested', () => {
    expect(validateDecision('REJECT', '  ', []).comment).toMatch(/reason is required/);
    expect(validateDecision('APPROVE', '', [{ lineId: 'L1', requested: 4, approved: '5' }])['line.L1']).toBe('Cannot exceed the requested 4');
    expect(validateDecision('APPROVE', '', [{ lineId: 'L1', requested: 4, approved: '0' }]).lines).toMatch(/Approve at least one/);
    expect(clampApproved('9', 4)).toBe('4');
    expect(clampApproved('-1', 4)).toBe('0');
  });
  it('validateIssue: serial count must match quantity; recipient required; capped at outstanding', () => {
    const base = { warehouseId: 'w', quantity: '2', batchNo: '', serialNumbers: ['A'], recipientName: '', note: '' };
    const e = validateIssue(base, 10);
    expect(e.serialNumbers).toMatch(/one serial number per unit \(2\)/);
    expect(e.recipientName).toBe('Who received the material?');
    expect(validateIssue({ ...base, quantity: '11', serialNumbers: [], recipientName: 'Ann' }, 10).quantity).toMatch(/supervisor must revise/);
  });
  it('describeStoreError maps EXCEEDS_APPROVED and INSUFFICIENT_STOCK to guidance', () => {
    const ex = describeStoreError(apiError(409, 'EXCEEDS_APPROVED', 'Exceeds approved quantity', { outstanding: 3 }));
    expect(ex.hint).toMatch(/supervisor must revise the approved quantity/);
    expect(ex.outstanding).toBe(3);
    expect(describeStoreError(apiError(409, 'INSUFFICIENT_STOCK', 'Not enough stock')).hint).toMatch(/backorder/);
  });
  it('sortForStore puts critical first, then oldest', () => {
    const rows = [
      { id: 'a', urgency: 'NORMAL' as const, submittedAt: '2026-11-01T00:00:00Z', createdAt: '' },
      { id: 'b', urgency: 'CRITICAL' as const, submittedAt: '2026-11-10T00:00:00Z', createdAt: '' },
      { id: 'c', urgency: 'NORMAL' as const, submittedAt: '2026-10-01T00:00:00Z', createdAt: '' },
    ];
    expect(sortForStore(rows).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('LinesEditor', () => {
  function Harness({ errors = {} }: { errors?: Record<string, string> }) {
    const [lines, setLines] = useState<LineDraft[]>([newLine()]);
    return <LinesEditor lines={lines} onChange={setLines} errors={errors} />;
  }
  it('shows line errors and adds/removes lines', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper auth={makeAuth(makeUser(perms('ENGINEER')))}>
        <Harness errors={validateLines([newLine()])} />
      </Wrapper>,
    );
    expect(screen.getByText('Select a catalogue item')).toBeInTheDocument();
    expect(screen.getByText('Enter a quantity greater than zero')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /add item/i }));
    expect(screen.getAllByRole('button', { name: /remove item/i })).toHaveLength(2);
  });
});

describe('DecisionPanel', () => {
  it('requires a reason to reject', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper auth={makeAuth(makeUser(perms('SUPERVISOR')))}>
        <DecisionPanel request={request()} onDone={vi.fn()} />
      </Wrapper>,
    );
    await user.click(screen.getByRole('radio', { name: 'Reject' }));
    await user.click(screen.getByRole('button', { name: 'Reject request' }));
    expect(await screen.findByText('A reason is required to reject')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });
  it('caps approved quantity at the requested amount and posts per-line quantities', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    apiMock.post.mockResolvedValue({ data: request({ status: 'APPROVED' }) });
    render(
      <Wrapper auth={makeAuth(makeUser(perms('SUPERVISOR')))}>
        <DecisionPanel request={request()} onDone={onDone} />
      </Wrapper>,
    );
    const qty = screen.getByLabelText(/SF6 gas cylinder — requested 10/);
    await user.clear(qty);
    await user.type(qty, '15');
    expect(qty).toHaveValue(10);
    await user.clear(qty);
    await user.type(qty, '6');
    await user.click(screen.getByRole('button', { name: 'Approve request' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/material-requests/${ID(1)}/decision`, { decision: 'APPROVE', comment: undefined, lines: [{ lineId: 'L1', approvedQty: 6 }] }));
    expect(onDone).toHaveBeenCalled();
  });
});

describe('IssueDialog', () => {
  const renderIssue = (r = request({ status: 'APPROVED' })) =>
    render(
      <Wrapper auth={storeAuth()}>
        <IssueDialog request={r} line={r.lines[0]} open onOpenChange={vi.fn()} onBackorder={vi.fn()} />
      </Wrapper>,
    );

  it('requires a recipient and one serial per unit', async () => {
    const user = userEvent.setup();
    renderIssue();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: /Main store/ });
    await user.selectOptions(within(dialog).getByLabelText(/Warehouse/), ID(60));
    const qty = within(dialog).getByLabelText(/Quantity/);
    await user.clear(qty);
    await user.type(qty, '2');
    await user.type(within(dialog).getByLabelText(/Serial numbers/), 'SN-1{Enter}');
    await user.clear(within(dialog).getByLabelText(/Received by/));
    await user.click(within(dialog).getByRole('button', { name: 'Issue material' }));
    expect(await within(dialog).findByText(/one serial number per unit \(2\)/)).toBeInTheDocument();
    expect(within(dialog).getByText('Who received the material?')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('explains BR-013 when the server rejects with EXCEEDS_APPROVED', async () => {
    const user = userEvent.setup();
    apiMock.post.mockRejectedValue(apiError(409, 'EXCEEDS_APPROVED', 'Only 2 remain approved for this line.', { outstanding: 2 }));
    renderIssue();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: /Main store/ });
    await user.selectOptions(within(dialog).getByLabelText(/Warehouse/), ID(60));
    await user.click(within(dialog).getByRole('button', { name: 'Issue material' }));
    expect(await within(dialog).findByText('Only 2 remain approved for this line.')).toBeInTheDocument();
    expect(within(dialog).getByText(/a supervisor must revise the approved quantity for this line \(BR-013\)/)).toBeInTheDocument();
    expect(apiMock.post).toHaveBeenCalledWith(`/material-requests/${ID(1)}/issue`, expect.any(FormData));
  });

  it('offers a backorder when stock is insufficient', async () => {
    const user = userEvent.setup();
    apiMock.post.mockRejectedValue(apiError(409, 'INSUFFICIENT_STOCK', 'Not enough stock in Main store.'));
    renderIssue();
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: /Main store/ });
    await user.selectOptions(within(dialog).getByLabelText(/Warehouse/), ID(60));
    await user.click(within(dialog).getByRole('button', { name: 'Issue material' }));
    expect(await within(dialog).findByRole('button', { name: 'Record backorder' })).toBeInTheDocument();
  });
});

describe('ReturnDialog', () => {
  it('requires a quantity and a reason', async () => {
    const user = userEvent.setup();
    const r = request({ status: 'ISSUED', lines: [line({ issuedQty: 4, outstandingQty: 6 })] });
    render(
      <Wrapper auth={storeAuth()}>
        <ReturnDialog request={r} line={r.lines[0]} open onOpenChange={vi.fn()} />
      </Wrapper>,
    );
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: /Main store/ });
    await user.selectOptions(within(dialog).getByLabelText(/Receiving warehouse/), ID(60));
    await user.click(within(dialog).getByRole('button', { name: 'Record return' }));
    expect(await within(dialog).findByText('Enter a quantity to return')).toBeInTheDocument();
    expect(within(dialog).getByText('Explain the return')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });
});

describe('inventory', () => {
  it('flags low stock', () => {
    const { rerender } = render(<StockLevel b={balance({ available: 3, lowStock: true })} />);
    expect(screen.getByText('Low stock')).toBeInTheDocument();
    rerender(<StockLevel b={balance()} />);
    expect(screen.queryByText('Low stock')).not.toBeInTheDocument();
  });
});

describe('materials navigation', () => {
  const labels = (key: string) => {
    const auth = makeAuth(makeUser(perms(key)));
    return visibleNav(auth.hasAny).flatMap((g) => g.items.map((i) => i.label));
  };
  it('engineers see "My material requests"; storekeepers see store and inventory', () => {
    expect(labels('ENGINEER')).toContain('My material requests');
    expect(labels('ENGINEER')).not.toContain('Store queue');
    expect(labels('STOREKEEPER')).toEqual(expect.arrayContaining(['Material requests', 'Store queue', 'Inventory']));
    expect(labels('SUPERVISOR')).toContain('Material requests');
  });
});
