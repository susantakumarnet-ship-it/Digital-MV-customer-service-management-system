import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_ROLES, type CalendarItemDto, type EngineerWorkloadDto } from '@mv/shared';
import { visibleNav } from '@/app/navigation';
import { EngineerPicker } from '@/features/work-orders/engineer-picker';
import {
  buildWorkOrderParams,
  dayKey,
  placeByDay,
  placeByEngineer,
  reassignNeedsReason,
  validateCreateForm,
  weekDays,
  type WorkOrderFormValues,
} from '@/features/work-orders/wo-lib';
import { makeAuth, makeUser, Wrapper } from './utils';

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/api')>();
  return { ...orig, api: apiMock };
});

const ID = (n: number) => n.toString(16).padStart(24, '0');

const ENGINEERS: EngineerWorkloadDto[] = [
  { id: ID(1), name: 'Eli Engineer', email: 'eli@example.com', eligible: true, activeWorkOrders: 2, overdue: 1, plannedInRange: 1, dueNext7Days: 0 },
  { id: ID(2), name: 'Erin Engineer', email: 'erin@example.com', eligible: false, activeWorkOrders: 0, overdue: 0, plannedInRange: 0, dueNext7Days: 0 },
];

function form(overrides: Partial<WorkOrderFormValues> = {}): WorkOrderFormValues {
  return {
    title: 'Replace RMU fuse',
    description: 'Replace blown HV fuse on panel 2',
    workScope: '',
    priorityId: '',
    plannedVisitAt: '',
    plannedEndAt: '',
    dueAt: '',
    shutdownRequired: false,
    shutdownDetails: '',
    materialRequired: false,
    materialNotes: '',
    supervisorId: '',
    assigneeIds: [],
    leadEngineerId: '',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('create work order validation', () => {
  it('requires shutdown details when a shutdown is required', () => {
    const r = validateCreateForm(form({ shutdownRequired: true, shutdownDetails: '' }));
    expect(r.payload).toBeUndefined();
    expect(r.errors.shutdownDetails).toMatch(/Describe the shutdown/);
  });

  it('requires material notes when materials are required', () => {
    const r = validateCreateForm(form({ materialRequired: true }));
    expect(r.errors.materialNotes).toBeTruthy();
  });

  it('rejects a planned end before the planned start', () => {
    const r = validateCreateForm(form({ plannedVisitAt: '2026-11-20T10:00', plannedEndAt: '2026-11-20T08:00' }));
    expect(r.errors.plannedEndAt).toMatch(/after the planned start/);
  });

  it('builds a valid payload with ISO dates and a default lead engineer', () => {
    const r = validateCreateForm(form({ plannedVisitAt: '2026-11-20T08:00', plannedEndAt: '2026-11-20T12:00', assigneeIds: [ID(1), ID(2)] }));
    expect(r.errors).toEqual({});
    expect(r.payload).toMatchObject({ leadEngineerId: ID(1), assigneeIds: [ID(1), ID(2)] });
    expect(String(r.payload!.plannedVisitAt)).toMatch(/Z$/);
  });
});

describe('reassignment reason rule', () => {
  it('needs a reason only for ACCEPTED/SCHEDULED work when engineers change', () => {
    expect(reassignNeedsReason('ACCEPTED', [ID(1)], [ID(2)])).toBe(true);
    expect(reassignNeedsReason('SCHEDULED', [ID(1)], [ID(1), ID(2)])).toBe(true);
    expect(reassignNeedsReason('ACCEPTED', [ID(1), ID(2)], [ID(2), ID(1)])).toBe(false);
    expect(reassignNeedsReason('ASSIGNED', [ID(1)], [ID(2)])).toBe(false);
    expect(reassignNeedsReason('DRAFT', [], [ID(1)])).toBe(false);
  });

  it('assign dialog blocks saving without a reason when accepted work is reassigned', async () => {
    apiMock.get.mockResolvedValue({ data: ENGINEERS });
    const { AssignDialog } = await import('@/features/work-orders/work-order-dialogs');
    const user = userEvent.setup();
    render(
      <Wrapper auth={makeAuth(makeUser(['workOrder.read', 'workOrder.assign']))}>
        <AssignDialog
          open
          onOpenChange={vi.fn()}
          workOrder={{ id: ID(9), workOrderNo: 'WO-2026-000001', status: 'ACCEPTED', site: { id: ID(5), name: 'Site A' }, plannedVisitAt: null, assignees: [{ id: ID(1), lead: true }] }}
        />
      </Wrapper>,
    );
    await user.click(await screen.findByLabelText(/Erin Engineer/));
    await user.click(screen.getByRole('button', { name: 'Save assignment' }));
    expect(await screen.findByText('A reason is required to reassign accepted work')).toBeInTheDocument();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it('assign dialog saves without a reason for work not yet accepted', async () => {
    apiMock.get.mockResolvedValue({ data: ENGINEERS });
    apiMock.patch.mockResolvedValue({ data: { id: ID(9), workOrderNo: 'WO-2026-000001' } });
    const { AssignDialog } = await import('@/features/work-orders/work-order-dialogs');
    const user = userEvent.setup();
    render(
      <Wrapper auth={makeAuth(makeUser(['workOrder.read', 'workOrder.assign']))}>
        <AssignDialog
          open
          onOpenChange={vi.fn()}
          workOrder={{ id: ID(9), workOrderNo: 'WO-2026-000001', status: 'DRAFT', site: { id: ID(5), name: 'Site A' }, plannedVisitAt: null, assignees: [] }}
        />
      </Wrapper>,
    );
    await user.click(await screen.findByLabelText(/Eli Engineer/));
    await user.click(screen.getByRole('button', { name: 'Save assignment' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith(`/work-orders/${ID(9)}/assignment`, expect.objectContaining({ assigneeIds: [ID(1)], leadEngineerId: ID(1) })));
  });
});

describe('engineer picker', () => {
  it('flags engineers outside their usual area and shows workload', () => {
    render(<EngineerPicker engineers={ENGINEERS} value={[]} onChange={vi.fn()} lead="" onLeadChange={vi.fn()} />);
    expect(screen.getByTestId(`outside-${ID(2)}`)).toHaveTextContent('Outside usual area');
    expect(screen.queryByTestId(`outside-${ID(1)}`)).not.toBeInTheDocument();
    expect(screen.getByText(/2 active/)).toBeInTheDocument();
    expect(screen.getByText(/1 overdue/)).toBeInTheDocument();
  });

  it('offers a lead engineer choice only when several engineers are chosen', () => {
    const { rerender } = render(<EngineerPicker engineers={ENGINEERS} value={[ID(1)]} onChange={vi.fn()} lead={ID(1)} onLeadChange={vi.fn()} />);
    expect(screen.queryByLabelText(/Lead engineer/)).not.toBeInTheDocument();
    rerender(<EngineerPicker engineers={ENGINEERS} value={[ID(1), ID(2)]} onChange={vi.fn()} lead={ID(1)} onLeadChange={vi.fn()} />);
    expect(screen.getByLabelText(/Lead engineer/)).toBeInTheDocument();
  });
});

describe('assignment board placement', () => {
  const monday = new Date(2026, 10, 16, 0, 0, 0); // Mon 16 Nov 2026 (local)
  const days = weekDays(monday);
  const at = (d: number, h: number) => new Date(2026, 10, d, h, 0, 0).toISOString();
  const item = (id: string, start: string | null, end: string | null, assignees: string[]): CalendarItemDto => ({
    id,
    workOrderNo: `WO-${id}`,
    title: 't',
    start,
    end,
    status: 'ASSIGNED',
    statusLabel: 'Assigned',
    statusTone: 'primary',
    assignees: assignees.map((a) => ({ id: a, name: a })),
    overdue: false,
  });

  it('places each work order under each assignee on its planned day', () => {
    const grid = placeByEngineer([item('a', at(17, 9), null, ['e1', 'e2'])], ['e1', 'e2', 'e3'], days);
    expect(grid.get('e1')!.get(dayKey(days[1]!))!.map((c) => c.item.id)).toEqual(['a']);
    expect(grid.get('e2')!.get(dayKey(days[1]!))!.map((c) => c.item.id)).toEqual(['a']);
    expect(grid.get('e3')!.get(dayKey(days[1]!))).toEqual([]);
    expect(grid.get('e1')!.get(dayKey(days[0]!))).toEqual([]);
  });

  it('repeats multi-day spans with continuation flags and clips to the visible week', () => {
    const grid = placeByEngineer([item('b', at(20, 8), at(23, 17), ['e1'])], ['e1'], days);
    const row = grid.get('e1')!;
    const fri = row.get(dayKey(days[4]!))![0]!;
    const sat = row.get(dayKey(days[5]!))![0]!;
    const sun = row.get(dayKey(days[6]!))![0]!;
    expect(fri).toMatchObject({ continuation: false, continues: true });
    expect(sat).toMatchObject({ continuation: true, continues: true });
    expect(sun).toMatchObject({ continuation: true, continues: true }); // continues into Monday (next week)
    expect(row.get(dayKey(days[3]!))).toEqual([]);
  });

  it('ignores unplanned items and engineers not on the board; month view groups by day', () => {
    const grid = placeByEngineer([item('c', null, null, ['e1']), item('d', at(18, 9), null, ['zz'])], ['e1'], days);
    expect([...grid.get('e1')!.values()].flat()).toEqual([]);
    const byDay = placeByDay([item('d', at(18, 9), null, ['zz'])], days);
    expect(byDay.get(dayKey(days[2]!))!.map((c) => c.item.id)).toEqual(['d']);
  });
});

describe('work-order list params', () => {
  it('maps tabs and filters', () => {
    expect(buildWorkOrderParams({ tab: 'unassigned' })).toMatchObject({ status: 'DRAFT', page: 1, limit: 20 });
    expect(buildWorkOrderParams({ tab: 'awaiting', mine: true })).toMatchObject({ status: 'ASSIGNED', mine: 'true' });
    expect(buildWorkOrderParams({ tab: 'overdue', assigneeId: ID(1) })).toMatchObject({ overdue: 'true', assigneeId: ID(1) });
    expect(buildWorkOrderParams({ tab: 'all' }).status).toBeUndefined();
  });
});

describe('navigation', () => {
  const perms = (key: string) => SYSTEM_ROLES.find((r) => r.key === key)!.permissions;
  const items = (p: string[]) => {
    const auth = makeAuth(makeUser(p as never));
    return visibleNav(auth.hasAny).flatMap((g) => g.items.map((i) => i.label));
  };

  it('engineers see "My work orders" and no assignment board', () => {
    const labels = items(perms('ENGINEER'));
    expect(labels).toContain('My work orders');
    expect(labels).not.toContain('Work orders');
    expect(labels).not.toContain('Assignment board');
  });

  it('supervisors see "Work orders" and the assignment board', () => {
    const labels = items(perms('SUPERVISOR'));
    expect(labels).toContain('Work orders');
    expect(labels).toContain('Assignment board');
    expect(labels).not.toContain('My work orders');
  });
});
