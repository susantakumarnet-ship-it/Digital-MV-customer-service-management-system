import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineerSequenceDto, InspectionReportDto, ReportItemDto, TimeEventDto, TimeEventType, VisitDetailDto } from '@mv/shared';
import { MyTimeCard, CorrectionDialog } from '@/features/visits/time-tracking';
import { formatDuration, runningMinutes, validateCorrection } from '@/features/visits/visit-lib';
import { ChecklistItem } from '@/features/inspections/checklist-item';
import { buildDraftPayload, issueItemKey, reasonRequired, useReportAutosave } from '@/features/inspections/report-lib';
import { suggestKey, validateTemplate, type TemplateForm } from '@/features/inspections/template-editor';
import { InspectionReportPage } from '@/features/inspections/inspection-report-page';
import { Routes, Route } from 'react-router-dom';
import { makeAuth, makeUser, Wrapper } from './utils';

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/api')>();
  return { ...orig, api: apiMock };
});

const ID = (n: number) => n.toString(16).padStart(24, '0');
const ORDER: TimeEventType[] = ['START_TRAVEL', 'ARRIVE_SITE', 'START_WORK', 'END_WORK', 'START_RETURN', 'ARRIVE_BASE'];

function ev(type: TimeEventType, iso: string): TimeEventDto {
  return { id: `e-${type}`, eventType: type, sequence: ORDER.indexOf(type) + 1, serverTimestamp: iso, effectiveTimestamp: iso, corrected: false };
}

function sequence(events: TimeEventDto[]): EngineerSequenceDto {
  return {
    engineer: { id: 'u1', name: 'Eli Engineer' },
    events,
    nextEvent: events.length >= 6 ? null : ORDER[events.length]!,
    complete: events.length >= 6,
    durations: { travelToSite: null, onSiteWork: null, returnTravel: null, totalElapsed: null, onSiteWaiting: null },
  };
}

function visit(seq: EngineerSequenceDto, overrides: Partial<VisitDetailDto> = {}): VisitDetailDto {
  return {
    id: ID(1),
    visitNo: 'VIS-2026-000001',
    status: 'PLANNED',
    statusLabel: 'Planned',
    statusTone: 'neutral',
    workOrder: { id: ID(2), workOrderNo: 'WO-2026-000001', title: 'Fix RMU' },
    complaint: { id: ID(3), referenceNo: 'MV-2026-000001' },
    site: { id: ID(4), name: 'Hillcrest' },
    purpose: 'Repair',
    engineers: [{ id: 'u1', name: 'Eli Engineer' }],
    sequences: [seq],
    mySequence: seq,
    corrections: [],
    inspectionReports: [],
    permissions: { canRecordTime: true, canRequestCorrection: true, canApproveCorrections: false, canEdit: true, canCancel: true, canInspect: true },
    timezone: 'UTC',
    createdAt: '2026-11-13T08:00:00Z',
    ...overrides,
  };
}

const engineerAuth = () => makeAuth(makeUser(['visit.read', 'visit.recordTime', 'visit.requestCorrection', 'inspection.create', 'inspection.read', 'inspection.submit']));

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
});

describe('duration helpers', () => {
  it('formats minutes as hours and minutes', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(0)).toBe('0 min');
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(60)).toBe('1 h');
    expect(formatDuration(85)).toBe('1 h 25 min');
    expect(formatDuration(1505)).toBe('25 h 5 min'); // visits crossing midnight
  });

  it('estimates the running segment only while it is open', () => {
    const start = '2026-11-13T08:00:00Z';
    const now = new Date('2026-11-13T08:40:00Z').getTime();
    expect(runningMinutes([ev('START_TRAVEL', start)], 'START_TRAVEL', 'ARRIVE_SITE', now)).toBe(40);
    expect(runningMinutes([ev('START_TRAVEL', start), ev('ARRIVE_SITE', '2026-11-13T08:30:00Z')], 'START_TRAVEL', 'ARRIVE_SITE', now)).toBeNull();
    expect(runningMinutes([], 'START_TRAVEL', 'ARRIVE_SITE', now)).toBeNull();
  });
});

describe('MyTimeCard', () => {
  it('shows the next permitted event and hides the button when the sequence is complete', () => {
    const { unmount } = render(
      <Wrapper auth={engineerAuth()}>
        <MyTimeCard visit={visit(sequence([ev('START_TRAVEL', '2026-11-13T08:00:00Z')]))} onChanged={vi.fn()} />
      </Wrapper>,
    );
    expect(screen.getByTestId('next-event-button')).toHaveTextContent('Arrive at Site');
    unmount();
    const all = ORDER.map((t, i) => ev(t, `2026-11-13T0${i}:00:00Z`));
    render(
      <Wrapper auth={engineerAuth()}>
        <MyTimeCard visit={visit(sequence(all))} onChanged={vi.fn()} />
      </Wrapper>,
    );
    expect(screen.queryByTestId('next-event-button')).not.toBeInTheDocument();
    expect(screen.getByText(/All six time events are recorded/)).toBeInTheDocument();
  });

  describe('GPS capture', () => {
    const getCurrentPosition = vi.fn();
    beforeEach(() => {
      getCurrentPosition.mockReset();
      getCurrentPosition.mockImplementation((ok: PositionCallback) =>
        ok({ coords: { latitude: 51.5, longitude: -0.12, accuracy: 8 }, timestamp: Date.now() } as unknown as GeolocationPosition),
      );
      Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition }, configurable: true });
    });
    afterEach(() => {
      Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true });
    });

    it('does not read the location when the toggle is off', async () => {
      const v = visit(sequence([]));
      apiMock.post.mockResolvedValue({ data: v });
      render(
        <Wrapper auth={engineerAuth()}>
          <MyTimeCard visit={v} onChanged={vi.fn()} />
        </Wrapper>,
      );
      await userEvent.click(screen.getByTestId('next-event-button'));
      await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
      expect(getCurrentPosition).not.toHaveBeenCalled();
      const [, body, cfg] = apiMock.post.mock.calls[0]!;
      expect(body).toMatchObject({ eventType: 'START_TRAVEL' });
      expect(body.gps).toBeUndefined();
      expect(cfg.headers['Idempotency-Key']).toMatch(/^[A-Za-z0-9_-]{16,100}$/);
    });

    it('reads the location once, only on tap, when the toggle is on', async () => {
      const v = visit(sequence([]));
      apiMock.post.mockResolvedValue({ data: v });
      render(
        <Wrapper auth={engineerAuth()}>
          <MyTimeCard visit={v} onChanged={vi.fn()} />
        </Wrapper>,
      );
      await userEvent.click(screen.getByRole('switch', { name: /Share my location/ }));
      expect(getCurrentPosition).not.toHaveBeenCalled();
      await userEvent.click(screen.getByTestId('next-event-button'));
      await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
      expect(getCurrentPosition).toHaveBeenCalledTimes(1);
      expect(apiMock.post.mock.calls[0]![1].gps).toMatchObject({ latitude: 51.5, longitude: -0.12, accuracy: 8 });
    });
  });
});

describe('time correction', () => {
  const events = [ev('START_TRAVEL', '2026-11-13T08:00:00Z'), ev('ARRIVE_SITE', '2026-11-13T09:00:00Z'), ev('START_WORK', '2026-11-13T09:30:00Z')];
  const target = events[1]!;
  const now = new Date('2026-11-13T12:00:00Z').getTime();

  it('requires a reason and a time between the previous and next events', () => {
    expect(validateCorrection(events, target, new Date('2026-11-13T08:45:00Z'), 'No signal on site', now)).toEqual({});
    expect(validateCorrection(events, target, new Date('2026-11-13T08:45:00Z'), '', now).reason).toBeTruthy();
    expect(validateCorrection(events, target, new Date('2026-11-13T07:59:00Z'), 'No signal on site', now).proposedTimestamp).toMatch(/after Start Travel/);
    expect(validateCorrection(events, target, new Date('2026-11-13T09:30:00Z'), 'No signal on site', now).proposedTimestamp).toMatch(/before Start Work/);
    expect(validateCorrection(events, target, new Date('2026-11-13T13:00:00Z'), 'No signal on site', now).proposedTimestamp).toBeTruthy();
  });

  it('dialog blocks submission without a reason', async () => {
    render(
      <Wrapper auth={engineerAuth()}>
        <CorrectionDialog visitId={ID(1)} event={target} events={events} open onOpenChange={vi.fn()} onChanged={vi.fn()} />
      </Wrapper>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Request correction' }));
    expect(await screen.findByText(/Explain why the time is wrong/)).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });
});

function item(overrides: Partial<ReportItemDto> = {}): ReportItemDto {
  return { key: 'K1', description: 'Check SF6 pressure', required: true, evidence: 'NONE', naReasonRequired: false, evidenceOnFail: false, attachments: [], issues: [], result: null, ...overrides };
}

describe('checklist item', () => {
  it('rule: Not Checked always needs a reason, N/A only when configured', () => {
    expect(reasonRequired({ naReasonRequired: false }, 'NOT_CHECKED')).toBe(true);
    expect(reasonRequired({ naReasonRequired: false }, 'NOT_APPLICABLE')).toBe(false);
    expect(reasonRequired({ naReasonRequired: true }, 'NOT_APPLICABLE')).toBe(true);
    expect(reasonRequired({ naReasonRequired: true }, 'PASS')).toBe(false);
  });

  const renderItem = (it: ReportItemDto, result: ReportItemDto['result']) =>
    render(
      <Wrapper auth={engineerAuth()}>
        <ChecklistItem item={it} value={{ result: result ?? null, remarks: '', reason: '' }} onChange={vi.fn()} readOnly={false} reportId={ID(9)} />
      </Wrapper>,
    );

  it('shows the reason field for Not Checked', () => {
    renderItem(item(), 'NOT_CHECKED');
    expect(screen.getByLabelText(/Reason not checked/)).toBeInTheDocument();
  });

  it('shows the reason field for Not Applicable only when the template requires it', () => {
    const { unmount } = renderItem(item({ naReasonRequired: false }), 'NOT_APPLICABLE');
    expect(screen.queryByLabelText(/Reason not applicable/)).not.toBeInTheDocument();
    unmount();
    renderItem(item({ naReasonRequired: true }), 'NOT_APPLICABLE');
    expect(screen.getByLabelText(/Reason not applicable/)).toBeInTheDocument();
  });

  it('renders the four results as an accessible radio group', async () => {
    const onChange = vi.fn();
    render(
      <Wrapper auth={engineerAuth()}>
        <ChecklistItem item={item()} value={{ result: null, remarks: '', reason: '' }} onChange={onChange} readOnly={false} reportId={ID(9)} />
      </Wrapper>,
    );
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    await userEvent.click(screen.getByRole('radio', { name: 'Fail' }));
    expect(onChange).toHaveBeenCalledWith({ result: 'FAIL', remarks: '', reason: '' });
  });
});

describe('autosave', () => {
  afterEach(() => vi.useRealTimers());

  it('payload contains only changed items', () => {
    expect(buildDraftPayload({ results: { K2: { result: 'PASS', remarks: '', reason: '' } }, findings: 'ok' })).toEqual({
      results: [{ itemKey: 'K2', result: 'PASS', remarks: undefined, reason: undefined }],
      findings: 'ok',
    });
  });

  it('debounces edits and sends only the changed items', async () => {
    vi.useFakeTimers();
    apiMock.put.mockResolvedValue({ data: {} });
    let api!: ReturnType<typeof useReportAutosave>;
    function Harness() {
      api = useReportAutosave('r1', vi.fn(), 1500);
      return null;
    }
    render(<Harness />);
    act(() => {
      api.queueItem('K1', { result: 'PASS', remarks: '', reason: '' });
      api.queueItem('K3', { result: 'FAIL', remarks: 'leak', reason: '' });
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(apiMock.put).not.toHaveBeenCalled();
    act(() => api.queueItem('K1', { result: 'NOT_CHECKED', remarks: '', reason: 'No access' }));
    await act(async () => {
      vi.advanceTimersByTime(1499);
    });
    expect(apiMock.put).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(2);
    });
    expect(apiMock.put).toHaveBeenCalledTimes(1);
    const [url, body] = apiMock.put.mock.calls[0]!;
    expect(url).toBe('/inspection-reports/r1');
    expect(body.results).toEqual([
      { itemKey: 'K1', result: 'NOT_CHECKED', remarks: undefined, reason: 'No access' },
      { itemKey: 'K3', result: 'FAIL', remarks: 'leak', reason: undefined },
    ]);
    expect(body.findings).toBeUndefined();
  });
});

function report(overrides: Partial<InspectionReportDto> = {}): InspectionReportDto {
  return {
    id: ID(9),
    revisionNo: 1,
    status: 'DRAFT',
    statusLabel: 'Draft',
    statusTone: 'neutral',
    locked: false,
    visit: { id: ID(1), visitNo: 'VIS-2026-000001' },
    workOrder: { id: ID(2), workOrderNo: 'WO-2026-000001', title: 'Fix RMU' },
    complaint: { id: ID(3), referenceNo: 'MV-2026-000001' },
    template: { id: ID(5), name: 'RMU checklist', version: 1 },
    items: [item({ issues: ['A result is required'] })],
    summary: { total: 1, pass: 0, fail: 0, notChecked: 0, notApplicable: 0, unanswered: 1 },
    submissionIssues: ['K1 — Check SF6 pressure: A result is required', 'Record your time events first: END_WORK'],
    permissions: { canEdit: true, canSubmit: false, canUpload: true },
    updatedAt: '2026-11-13T10:00:00Z',
    ...overrides,
  };
}

describe('report submission', () => {
  it('disables "Submit for review" while there are submission issues', async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url.startsWith('/inspection-reports/')) return { data: report() };
      return { data: { attachments: undefined } };
    });
    render(
      <Wrapper auth={engineerAuth()} route={`/inspection-reports/${ID(9)}`}>
        <Routes>
          <Route path="/inspection-reports/:id" element={<InspectionReportPage />} />
        </Routes>
      </Wrapper>,
    );
    await userEvent.click(await screen.findByRole('button', { name: /Preview & submit/ }));
    expect(await screen.findByText(/Fix these before submitting/)).toBeInTheDocument();
    expect(screen.getByTestId('submit-report')).toBeDisabled();
    expect(issueItemKey('K1 — Check SF6 pressure: A result is required')).toBe('K1');
    expect(issueItemKey('Record your time events first: END_WORK')).toBeNull();
  });

  it('enables submission when the report is complete', async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url.startsWith('/inspection-reports/')) return { data: report({ submissionIssues: [], items: [item({ result: 'PASS' })], permissions: { canEdit: true, canSubmit: true, canUpload: true } }) };
      return { data: {} };
    });
    render(
      <Wrapper auth={engineerAuth()} route={`/inspection-reports/${ID(9)}`}>
        <Routes>
          <Route path="/inspection-reports/:id" element={<InspectionReportPage />} />
        </Routes>
      </Wrapper>,
    );
    await userEvent.click(await screen.findByRole('button', { name: /Preview & submit/ }));
    expect(await screen.findByText(/ready to submit/)).toBeInTheDocument();
    expect(screen.getByTestId('submit-report')).toBeEnabled();
  });
});

describe('template editor validation', () => {
  const form = (keys: string[]): TemplateForm => ({
    name: 'RMU checklist',
    equipmentTypeId: ID(7),
    description: '',
    items: keys.map((k) => ({ key: k, section: '', description: `Inspect ${k}`, guidance: '', required: true, evidence: 'NONE', naReasonRequired: false, evidenceOnFail: false })),
  });

  it('rejects duplicate item keys', () => {
    const errs = validateTemplate(form(['GAS', 'GAS']));
    expect(errs['items.1.key']).toMatch(/Duplicate item key/);
    expect(validateTemplate(form(['GAS', 'CABLE']))).toEqual({});
  });

  it('suggests unique keys from descriptions', () => {
    expect(suggestKey('Check SF6 gas pressure')).toBe('CHECK_SF6_GAS');
    expect(suggestKey('Check SF6 gas pressure', ['CHECK_SF6_GAS'])).toBe('CHECK_SF6_GAS_2');
  });
});
