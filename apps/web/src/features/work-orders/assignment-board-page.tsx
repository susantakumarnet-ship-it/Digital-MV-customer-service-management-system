import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { addDays, addMonths, addWeeks, endOfDay, format, isSameMonth, isToday } from 'date-fns';
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, List, UserPlus } from 'lucide-react';
import type { CalendarItemDto, Paged, WorkOrderSummaryDto } from '@mv/shared';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge, StatusBadge, toneOf } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/form';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState } from '@/components/states';
import { DueCell, PriorityBadge } from '@/features/complaints/complaints-list-page';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AssignDialog } from './work-order-dialogs';
import { dayKey, monthGrid, placeByDay, placeByEngineer, PRIORITY_CHIP, useWorkload, weekDays, weekStart, type PlacedChip } from './wo-lib';

type View = 'list' | 'week' | 'month';

function useCalendar(from: Date, to: Date, includeUnplanned: boolean) {
  return useQuery({
    queryKey: ['work-orders', 'calendar', from.toISOString(), to.toISOString(), includeUnplanned],
    queryFn: async () =>
      (
        await api.get<{ items: CalendarItemDto[]; unplanned: CalendarItemDto[] }>('/work-orders/calendar', {
          params: { from: from.toISOString(), to: to.toISOString(), includeUnplanned: includeUnplanned ? 'true' : undefined },
        })
      ).data,
  });
}

export function Chip({ chip, compact }: { chip: PlacedChip; compact?: boolean }) {
  const { item } = chip;
  return (
    <Link
      to={`/work-orders/${item.id}`}
      title={`${item.workOrderNo} — ${item.title} (${item.statusLabel})${item.siteName ? ` · ${item.siteName}` : ''}`}
      className={cn(
        'block truncate rounded-md border px-1.5 py-1 text-[11px] leading-tight hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-royal-600',
        PRIORITY_CHIP[item.priorityTone ?? 'neutral'] ?? PRIORITY_CHIP.neutral,
        item.overdue && 'ring-2 ring-red-500',
        chip.continuation && 'rounded-l-none border-dashed opacity-80',
        chip.continues && 'rounded-r-none',
      )}
      data-testid="board-chip"
    >
      <span className="font-mono font-semibold">{chip.continuation ? '↳ ' : ''}{item.workOrderNo}</span>
      {!compact && <span className="block truncate">{item.siteName ?? item.title}</span>}
    </Link>
  );
}

export function AssignmentBoardPage() {
  const [view, setView] = useState<View>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [mobileEngineer, setMobileEngineer] = useState('');
  const [assignTarget, setAssignTarget] = useState<WorkOrderSummaryDto | null>(null);

  const anchorKey = dayKey(anchor);
  const ws = useMemo(() => weekStart(new Date(`${anchorKey}T12:00:00`)), [anchorKey]);
  const days = useMemo(() => weekDays(ws), [ws]);
  const monthDays = useMemo(() => monthGrid(new Date(`${anchorKey}T12:00:00`)), [anchorKey]);
  const range = view === 'month' ? { from: monthDays[0]!, to: endOfDay(monthDays[41]!) } : { from: ws, to: endOfDay(days[6]!) };

  const workload = useWorkload({ from: ws, to: addDays(ws, 7) });
  const cal = useCalendar(range.from, range.to, view !== 'list');
  const unassigned = useQuery({
    queryKey: ['work-orders', 'list', { status: 'DRAFT', board: true }],
    queryFn: async () => (await api.get<Paged<WorkOrderSummaryDto>>('/work-orders', { params: { status: 'DRAFT', sort: 'dueAt', limit: 50 } })).data,
  });

  const engineers = useMemo(() => workload.data ?? [], [workload.data]);
  const grid = useMemo(() => placeByEngineer(cal.data?.items ?? [], engineers.map((e) => e.id), days), [cal.data, engineers, days]);
  const byDay = useMemo(() => placeByDay(cal.data?.items ?? [], monthDays), [cal.data, monthDays]);
  const mobileId = mobileEngineer || engineers[0]?.id || '';

  const step = (dir: -1 | 1) => setAnchor((a) => (view === 'month' ? addMonths(a, dir) : addWeeks(a, dir)));
  const title = view === 'month' ? format(anchor, 'MMMM yyyy') : `${format(days[0]!, 'd MMM')} – ${format(days[6]!, 'd MMM yyyy')}`;

  return (
    <div className="space-y-4">
      <PageHeader title="Assignment board" description="Plan visits, balance engineer workload and assign new work orders." />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-lg border border-border bg-white p-0.5" role="group" aria-label="Board view">
          {(
            [
              ['list', 'List', List],
              ['week', 'Week', CalendarDays],
              ['month', 'Month', CalendarDays],
            ] as const
          ).map(([v, label, Icon]) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium', view === v ? 'bg-navy-900 text-white' : 'text-slate-600 hover:bg-slate-100')}
            >
              <Icon className="h-4 w-4" aria-hidden /> {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" onClick={() => step(-1)} aria-label={view === 'month' ? 'Previous month' : 'Previous week'}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAnchor(new Date())}>
            Today
          </Button>
          <Button variant="outline" size="icon" onClick={() => step(1)} aria-label={view === 'month' ? 'Next month' : 'Next week'}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span className="ml-2 text-sm font-medium text-navy-900" aria-live="polite">
            {title}
          </span>
        </div>
      </div>

      {view === 'list' && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader title="Engineer workload" description="Active work, overdue items, visits planned this week and work due in 7 days." />
            {workload.isError ? (
              <ErrorState error={workload.error} onRetry={() => workload.refetch()} />
            ) : workload.isLoading ? (
              <div className="space-y-2 p-5">
                <div className="skeleton h-6" />
                <div className="skeleton h-6" />
              </div>
            ) : !engineers.length ? (
              <EmptyState title="No field engineers" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Engineer workload</caption>
                  <thead className="border-b border-border bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th scope="col" className="px-4 py-2 text-left">Engineer</th>
                      <th scope="col" className="px-3 py-2 text-right">Active</th>
                      <th scope="col" className="px-3 py-2 text-right">Overdue</th>
                      <th scope="col" className="px-3 py-2 text-right">This week</th>
                      <th scope="col" className="px-3 py-2 text-right">Due ≤7d</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {engineers.map((e) => (
                      <tr key={e.id}>
                        <td className="px-4 py-2">
                          <Link to={`/work-orders?assigneeId=${e.id}`} className="font-medium text-royal-700 hover:underline">
                            {e.name}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{e.activeWorkOrders}</td>
                        <td className={cn('px-3 py-2 text-right tabular-nums', e.overdue > 0 && 'font-semibold text-red-700')}>{e.overdue}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{e.plannedInRange}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{e.dueNext7Days}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card>
            <CardHeader title="Unassigned work orders" description="Draft work orders waiting for engineers — earliest due first." />
            {unassigned.isError ? (
              <ErrorState error={unassigned.error} onRetry={() => unassigned.refetch()} />
            ) : unassigned.isLoading ? (
              <div className="space-y-2 p-5">
                <div className="skeleton h-6" />
              </div>
            ) : !unassigned.data?.data.length ? (
              <EmptyState title="Everything is assigned" />
            ) : (
              <ul className="divide-y divide-border">
                {unassigned.data.data.map((w) => (
                  <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                    <div className="min-w-0">
                      <Link to={`/work-orders/${w.id}`} className="font-mono text-sm font-medium text-royal-700 hover:underline">
                        {w.workOrderNo}
                      </Link>
                      <p className="truncate text-xs text-slate-600">
                        {w.title} · {w.site?.name}
                      </p>
                      <div className="mt-1 flex items-center gap-2">
                        <PriorityBadge priority={w.priority} />
                        <DueCell c={w} />
                      </div>
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => setAssignTarget(w)}>
                      <UserPlus className="h-4 w-4" /> Assign
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {view !== 'list' && (cal.isError || workload.isError) && (
        <Card>
          <ErrorState error={cal.error ?? workload.error} onRetry={() => (cal.refetch(), workload.refetch())} />
        </Card>
      )}

      {view === 'week' && !cal.isError && (
        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[1fr_18rem]">
          <Card className="min-w-0">
            {/* Desktop/tablet: engineers × days grid (scrolls inside its container) */}
            <div className="hidden overflow-x-auto md:block">
              <div className="grid min-w-[56rem]" style={{ gridTemplateColumns: '11rem repeat(7, minmax(0, 1fr))' }} role="grid" aria-label="Week assignment board">
                <div className="border-b border-border bg-slate-50 px-3 py-2 text-xs font-semibold uppercase text-slate-500" role="columnheader">
                  Engineer
                </div>
                {days.map((d) => (
                  <div key={dayKey(d)} role="columnheader" className={cn('border-b border-l border-border bg-slate-50 px-2 py-2 text-xs font-semibold', isToday(d) ? 'text-royal-700' : 'text-slate-600')}>
                    {format(d, 'EEE d')}
                  </div>
                ))}
                {(workload.isLoading || cal.isLoading) && (
                  <div className="col-span-8 space-y-2 p-4">
                    <div className="skeleton h-10" />
                    <div className="skeleton h-10" />
                  </div>
                )}
                {!workload.isLoading &&
                  engineers.map((e) => (
                    <div key={e.id} className="contents" role="row">
                      <div className="border-b border-border px-3 py-2 text-sm" role="rowheader">
                        <p className="font-medium text-navy-900">{e.name}</p>
                        <p className="text-xs text-slate-500">
                          {e.activeWorkOrders} active{e.overdue ? <span className="text-red-700"> · {e.overdue} overdue</span> : null}
                        </p>
                      </div>
                      {days.map((d) => {
                        const chips = grid.get(e.id)?.get(dayKey(d)) ?? [];
                        return (
                          <div key={dayKey(d)} role="gridcell" className={cn('min-h-[3.5rem] space-y-1 border-b border-l border-border p-1', isToday(d) && 'bg-royal-50/40')}>
                            {chips.map((c) => (
                              <Chip key={`${c.item.id}-${dayKey(d)}`} chip={c} />
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  ))}
              </div>
              {!workload.isLoading && !engineers.length && <EmptyState title="No field engineers" />}
            </div>
            {/* Mobile: one engineer, days stacked vertically */}
            <div className="space-y-3 p-3 md:hidden">
              <Select aria-label="Engineer" value={mobileId} onChange={(ev) => setMobileEngineer(ev.target.value)}>
                {engineers.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </Select>
              {days.map((d) => {
                const chips = grid.get(mobileId)?.get(dayKey(d)) ?? [];
                return (
                  <div key={dayKey(d)} className="rounded-lg border border-border p-2">
                    <p className={cn('text-xs font-semibold', isToday(d) ? 'text-royal-700' : 'text-slate-600')}>{format(d, 'EEEE d MMM')}</p>
                    <div className="mt-1 space-y-1">
                      {chips.length ? chips.map((c) => <Chip key={c.item.id} chip={c} />) : <p className="text-xs text-slate-400">No visits</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
          <UnplannedList items={cal.data?.unplanned} loading={cal.isLoading} />
        </div>
      )}

      {view === 'month' && !cal.isError && (
        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[1fr_18rem]">
          <Card className="min-w-0 overflow-x-auto">
            <div className="grid min-w-[42rem] grid-cols-7" role="grid" aria-label="Month calendar">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                <div key={d} role="columnheader" className="border-b border-border bg-slate-50 px-2 py-2 text-xs font-semibold uppercase text-slate-500">
                  {d}
                </div>
              ))}
              {monthDays.map((d) => {
                const chips = byDay.get(dayKey(d)) ?? [];
                const shown = chips.slice(0, 3);
                return (
                  <div
                    key={dayKey(d)}
                    role="gridcell"
                    className={cn('min-h-[6.5rem] space-y-1 border-b border-l border-border p-1', !isSameMonth(d, anchor) && 'bg-slate-50/70 text-slate-400', isToday(d) && 'bg-royal-50/50')}
                  >
                    <p className={cn('text-xs font-medium', isToday(d) && 'text-royal-700')}>{format(d, 'd')}</p>
                    {cal.isLoading ? null : shown.map((c) => <Chip key={c.item.id} chip={c} compact />)}
                    {chips.length > 3 && (
                      <button type="button" className="text-[11px] font-medium text-royal-700 hover:underline" onClick={() => (setAnchor(d), setView('week'))}>
                        +{chips.length - 3} more
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
          <UnplannedList items={cal.data?.unplanned} loading={cal.isLoading} />
        </div>
      )}

      {assignTarget && (
        <AssignDialog
          workOrder={{ ...assignTarget, assignees: assignTarget.assignees }}
          open
          onOpenChange={(o) => !o && setAssignTarget(null)}
        />
      )}
    </div>
  );
}

function UnplannedList({ items, loading }: { items?: CalendarItemDto[]; loading: boolean }) {
  return (
    <Card className="self-start">
      <CardHeader title="Not yet planned" description="Active work orders without a visit date." />
      {loading ? (
        <div className="space-y-2 p-4">
          <div className="skeleton h-6" />
        </div>
      ) : !items?.length ? (
        <EmptyState title="All work is planned" />
      ) : (
        <ul className="max-h-[32rem] divide-y divide-border overflow-y-auto">
          {items.map((i) => (
            <li key={i.id} className="px-4 py-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <Link to={`/work-orders/${i.id}`} className="font-mono font-medium text-royal-700 hover:underline">
                  {i.workOrderNo}
                </Link>
                <StatusBadge status={i.status} label={i.statusLabel} tone={toneOf(i.statusTone)} />
              </div>
              <p className="truncate text-xs text-slate-600">{i.siteName ?? i.title}</p>
              <p className="text-xs text-slate-500">
                {i.assignees.length ? i.assignees.map((a) => a.name).join(', ') : 'Unassigned'}
                {i.dueAt && <> · due {formatDateTime(i.dueAt, false)}</>}
                {i.overdue && (
                  <Badge tone="danger" className="ml-1">
                    <AlertTriangle className="h-3 w-3" aria-hidden /> Overdue
                  </Badge>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
