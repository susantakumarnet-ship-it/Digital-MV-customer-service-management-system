import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_ROLES, type AcceptanceSummaryDto, type ComplaintDetailDto, type NcrDetailDto } from '@mv/shared';
import { visibleNav } from '@/app/navigation';
import { NcrView } from '@/features/ncr/ncr-detail-page';
import { RaiseNcrDialog } from '@/features/ncr/raise-ncr-dialog';
import { validateRaise } from '@/features/ncr/ncr-lib';
import { PublicAcceptancePage } from '@/features/acceptance/public-acceptance-page';
import { ClosureChecklist, ResolutionAcceptancePanel } from '@/features/acceptance/acceptance-panel';
import { validateDecision } from '@/features/acceptance/acceptance-lib';
import { makeAuth, makeUser, Wrapper } from './utils';

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/api')>();
  return { ...orig, api: apiMock };
});

const ID = (n: number) => n.toString(16).padStart(24, '0');
const perms = (key: string) => SYSTEM_ROLES.find((r) => r.key === key)!.permissions;

function apiError(status: number, code: string, message: string) {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError(message, 'ERR', config, null, { status, statusText: '', headers: {}, config, data: { error: { code, message, requestId: 'req-1' } } });
}

const PUBLIC_SETTINGS = { applicationName: 'Digital MV', organizationName: 'Grid Co', timezone: 'UTC', dateFormat: 'dd/MM/yyyy', supportEmail: 'help@example.com', supportPhone: '', attachments: { allowedExtensions: ['png', 'pdf'], maxFileSizeMb: 10, maxFilesPerRecord: 10, maxTotalSizeMbPerRecord: 50 } };

function ncr(overrides: Partial<NcrDetailDto> = {}, p: Partial<NcrDetailDto['permissions']> = {}): NcrDetailDto {
  return {
    id: ID(1),
    ncrNo: 'NCR-2026-000001',
    title: 'Switch mechanism stiff',
    status: 'ACTION_IN_PROGRESS',
    statusLabel: 'Action in Progress',
    statusTone: 'accent',
    category: 'Workmanship',
    severity: 'Major',
    complaint: { id: ID(2), referenceNo: 'MV-2026-000001' },
    workOrder: { id: ID(3), workOrderNo: 'WO-2026-000001' },
    site: { id: ID(4), name: 'North substation' },
    owner: { id: 'u1', name: 'Test User' },
    raisedBy: { id: ID(5), name: 'Eli Engineer' },
    dueAt: '2026-11-30T00:00:00.000Z',
    overdue: false,
    createdAt: '2026-11-13T08:00:00.000Z',
    description: 'Operating handle requires excessive force.',
    asset: null,
    inspection: { reportId: ID(6), itemKey: 'OPS', itemDescription: 'Switch operation' },
    containmentAction: 'Isolated panel',
    rootCause: 'Dry lubrication',
    evidence: [],
    verificationEvidence: [],
    comments: [],
    revisions: [{ at: '2026-11-13T09:00:00.000Z', byName: 'Test User', changes: { containmentAction: { to: 'Isolated panel' } } }],
    statusHistory: [{ to: 'OPEN', toLabel: 'Open', action: 'create', byName: 'Eli Engineer', at: '2026-11-13T08:00:00.000Z' }],
    availableActions: [],
    permissions: { canEditActions: false, canEditDetails: false, canAssign: false, canVerify: false, canComment: true, canUploadEvidence: false, canUploadVerification: false, ...p },
    ...overrides,
  };
}

const summary: AcceptanceSummaryDto = {
  complaint: { referenceNo: 'MV-2026-000001', receivedAt: '2026-11-10T08:00:00.000Z', siteName: 'North substation', customerName: 'Jane Reporter', description: 'RMU tripping', statusLabel: 'Customer Acceptance Pending' },
  workOrders: [{ workOrderNo: 'WO-2026-000001', title: 'Field work', completedAt: null }],
  serviceCompletion: { visits: 1, firstVisitAt: '2026-11-11T08:00:00.000Z', lastVisitAt: '2026-11-11T12:00:00.000Z', onSiteMinutes: 95 },
  approvedReports: [{ workOrderNo: 'WO-2026-000001', template: 'RMU check', approvedAt: '2026-11-12T08:00:00.000Z', summary: { pass: 5, fail: 1, notChecked: 0, notApplicable: 0 }, findings: 'Mechanism stiff', recommendations: 'Lubricate' }],
  documents: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.get.mockImplementation(async (url: string) => {
    if (url === '/settings/public') return { data: PUBLIC_SETTINGS };
    throw new Error(`unexpected GET ${url}`);
  });
});

describe('navigation', () => {
  it('shows NCRs to roles holding ncr.read only', () => {
    const labels = (key: string) => visibleNav((ps) => ps.some((p) => (perms(key) as string[]).includes(p))).flatMap((g) => g.items.map((i) => i.label));
    expect(labels('SUPERVISOR')).toContain('NCRs');
    expect(labels('REVIEWER')).toContain('NCRs');
    expect(labels('CUSTOMER')).not.toContain('NCRs');
    expect(labels('STOREKEEPER')).not.toContain('NCRs');
  });
});

describe('NCR detail — permission-driven rendering', () => {
  it('owner with canEditActions gets an editable action form', async () => {
    const auth = makeAuth(makeUser(perms('ENGINEER')));
    render(
      <Wrapper auth={auth}>
        <NcrView n={ncr({}, { canEditActions: true })} />
      </Wrapper>,
    );
    expect(screen.getByTestId('actions-form')).toBeInTheDocument();
    expect(screen.getByLabelText('Root cause')).toHaveValue('Dry lubrication');
    const save = screen.getByRole('button', { name: /save actions/i });
    expect(save).toBeDisabled(); // nothing changed yet
    await userEvent.type(screen.getByLabelText('Corrective action'), 'Lubricated');
    expect(save).toBeEnabled();
    apiMock.put.mockResolvedValueOnce({ data: ncr({ correctiveAction: 'Lubricated' }, { canEditActions: true }) });
    await userEvent.click(save);
    expect(apiMock.put).toHaveBeenCalledWith(`/ncrs/${ID(1)}/actions`, expect.objectContaining({ correctiveAction: 'Lubricated', rootCause: 'Dry lubrication' }));
  });

  it('others see the actions read-only and no assign/edit buttons', () => {
    const auth = makeAuth(makeUser(perms('MANAGEMENT')));
    render(
      <Wrapper auth={auth}>
        <NcrView n={ncr()} />
      </Wrapper>,
    );
    expect(screen.getByTestId('actions-readonly')).toHaveTextContent('Dry lubrication');
    expect(screen.queryByTestId('actions-form')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /assign/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit details/i })).not.toBeInTheDocument();
  });

  it('D-08: hides Verify and explains why when the reviewer owns the NCR', () => {
    const auth = makeAuth(makeUser(perms('REVIEWER')));
    const n = ncr(
      {
        status: 'SUBMITTED_FOR_VERIFICATION',
        statusLabel: 'Submitted for Verification',
        availableActions: [
          { action: 'verify', label: 'Verify', to: 'VERIFIED', requiresReason: false, confirm: true },
          { action: 'return', label: 'Return', to: 'RETURNED', requiresReason: true, confirm: false },
        ],
      },
      { canVerify: false, reasonIfNotVerify: 'You own this NCR, so another reviewer must verify it.' },
    );
    render(
      <Wrapper auth={auth}>
        <NcrView n={n} />
      </Wrapper>,
    );
    expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Return' })).toBeInTheDocument();
    expect(screen.getByTestId('verify-blocked')).toHaveTextContent('another reviewer must verify');
  });

  it('verifier can verify with an optional comment sent as `comment`', async () => {
    const auth = makeAuth(makeUser(perms('REVIEWER')));
    const n = ncr({ status: 'SUBMITTED_FOR_VERIFICATION', availableActions: [{ action: 'verify', label: 'Verify', to: 'VERIFIED', requiresReason: false, confirm: true }] }, { canVerify: true, canUploadVerification: true });
    apiMock.post.mockResolvedValueOnce({ data: ncr({ status: 'VERIFIED', statusLabel: 'Verified' }) });
    render(
      <Wrapper auth={auth}>
        <NcrView n={n} />
      </Wrapper>,
    );
    expect(screen.getByText('Add verification evidence')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await userEvent.type(await screen.findByLabelText('Verification comment'), 'Torque OK');
    await userEvent.click(screen.getAllByRole('button', { name: 'Verify' }).at(-1)!);
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/ncrs/${ID(1)}/transition`, { action: 'verify', comment: 'Torque OK' }));
  });
});

describe('Raise NCR dialog', () => {
  it('validates required fields before calling the API', async () => {
    const auth = makeAuth(makeUser(perms('ENGINEER')));
    render(
      <Wrapper auth={auth}>
        <RaiseNcrDialog open onOpenChange={() => undefined} context={{ complaintId: ID(2), complaintRef: 'MV-2026-000001', workOrderId: ID(3), inspectionReportId: ID(6), itemKey: 'OPS', itemDescription: 'Switch operation' }} navigateOnCreate={false} />
      </Wrapper>,
    );
    // Prefilled from the failed item; engineers (no ncr.assign) get no owner field.
    expect(screen.getByLabelText(/^Title/)).toHaveValue('Failed: Switch operation');
    expect(screen.queryByLabelText(/Owner/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Raise NCR' }));
    expect(await screen.findByText('Select a category')).toBeInTheDocument();
    expect(screen.getByText('Select a severity')).toBeInTheDocument();
    expect(screen.getByText('Describe the non-conformance')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();

    await userEvent.selectOptions(screen.getByLabelText(/^Category/), 'Workmanship');
    await userEvent.selectOptions(screen.getByLabelText(/^Severity/), 'Major');
    await userEvent.type(screen.getByLabelText(/^Description/), 'Handle needs excessive force');
    apiMock.post.mockResolvedValueOnce({ data: ncr() });
    await userEvent.click(screen.getByRole('button', { name: 'Raise NCR' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [url, body] = apiMock.post.mock.calls[0]!;
    expect(url).toBe('/ncrs');
    const data = JSON.parse((body as FormData).get('data') as string);
    expect(data).toMatchObject({ complaintId: ID(2), workOrderId: ID(3), inspectionReportId: ID(6), itemKey: 'OPS', category: 'Workmanship', severity: 'Major' });
    expect(data.ownerId).toBeUndefined();
  });

  it('validateRaise mirrors the server messages', () => {
    expect(validateRaise({ category: 'x', severity: 'y', title: 'ok title', description: 'long enough text', ownerId: '', dueAt: '' })).toEqual({});
    expect(validateRaise({ category: '', severity: '', title: 'a', description: 'short', ownerId: '', dueAt: '' })).toMatchObject({ category: expect.any(String), title: expect.any(String) });
  });
});

function renderPublic(token = 'a'.repeat(43)) {
  return render(
    <Wrapper auth={makeAuth(null)} route={`/acceptance/${token}`}>
      <Routes>
        <Route path="/acceptance/:token" element={<PublicAcceptancePage />} />
      </Routes>
    </Wrapper>,
  );
}

describe('Public acceptance page', () => {
  it('shows an expired-link message', async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url === '/settings/public') return { data: PUBLIC_SETTINGS };
      throw apiError(410, 'LINK_EXPIRED', 'This link has expired.');
    });
    renderPublic();
    expect(await screen.findByText('This link has expired')).toBeInTheDocument();
    expect(await screen.findByText(/help@example.com/)).toBeInTheDocument();
  });

  it('shows superseded and invalid states', async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url === '/settings/public') return { data: PUBLIC_SETTINGS };
      throw apiError(410, 'LINK_SUPERSEDED', 'replaced');
    });
    const { unmount } = renderPublic();
    expect(await screen.findByText('This link has been replaced')).toBeInTheDocument();
    unmount();
    apiMock.get.mockImplementation(async (url: string) => {
      if (url === '/settings/public') return { data: PUBLIC_SETTINGS };
      throw apiError(404, 'LINK_INVALID', 'not valid');
    });
    renderPublic();
    expect(await screen.findByText('This link is not valid')).toBeInTheDocument();
  });

  it('shows the already-decided state without a form', async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url === '/settings/public') return { data: PUBLIC_SETTINGS };
      return { data: { ...summary, decided: { decision: 'ACCEPT', at: '2026-11-13T10:00:00.000Z' } } };
    });
    renderPublic();
    expect(await screen.findByText('Your response has already been recorded')).toBeInTheDocument();
    expect(screen.queryByText('Your decision')).not.toBeInTheDocument();
  });

  it('requires comments to request further action, then confirms', async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url === '/settings/public') return { data: PUBLIC_SETTINGS };
      return { data: { ...summary, decided: null, expiresAt: '2026-11-20T00:00:00.000Z' } };
    });
    const token = 'b'.repeat(43);
    renderPublic(token);
    expect(await screen.findByText('Confirm the service for MV-2026-000001')).toBeInTheDocument();
    expect(screen.getByText('1 h 35 min')).toBeInTheDocument();
    expect(screen.getByText(/Mechanism stiff/)).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText(/Request further action/));
    await userEvent.type(screen.getByLabelText(/Your name/), 'Jane Reporter');
    await userEvent.click(screen.getByRole('button', { name: /send request for further action/i }));
    expect(await screen.findByText('Tell us what still needs to be done')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText(/What still needs to be done/), 'Door still sticks');
    apiMock.post.mockResolvedValueOnce({ data: { ...summary, decided: { decision: 'REJECT', at: '2026-11-13T10:00:00.000Z' } } });
    await userEvent.click(screen.getByRole('button', { name: /send request for further action/i }));
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(`/customer-acceptance/${token}`, { decision: 'REJECT', comments: 'Door still sticks', rating: undefined, feedback: undefined, signerName: 'Jane Reporter' }),
    );
    expect(await screen.findByText('Thank you — we will be in touch')).toBeInTheDocument();
  });

  it('validateDecision mirrors the server rules', () => {
    const base = { decision: 'ACCEPT' as const, comments: '', rating: 0, feedback: '', signerName: '' };
    expect(validateDecision(base, false)).toEqual({});
    expect(validateDecision(base, true)).toHaveProperty('signerName');
    expect(validateDecision({ ...base, decision: 'REJECT' }, false)).toHaveProperty('comments');
  });
});

describe('Complaint closure checklist', () => {
  const checklist = {
    canClose: false,
    conditions: [
      { key: 'workApproved', label: 'All work orders technically approved', met: true },
      { key: 'ncrsComplete', label: 'NCRs verified or closed', met: false, detail: 'Open: NCR-2026-000001' },
      { key: 'acceptanceRecorded', label: 'Customer acceptance recorded (or waived with reason)', met: false, detail: 'Awaiting the customer' },
    ],
  };

  it('renders met and unmet conditions with details', () => {
    render(<ClosureChecklist checklist={checklist} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAttribute('data-met', 'true');
    expect(items[1]).toHaveAttribute('data-met', 'false');
    expect(screen.getByText('Open: NCR-2026-000001')).toBeInTheDocument();
    expect(screen.getAllByText('(not met)', { exact: false })).toHaveLength(2);
  });

  it('disables Close until every condition is met and shows pending-link info', async () => {
    const complaint = {
      id: ID(2),
      referenceNo: 'MV-2026-000001',
      status: 'CUSTOMER_ACCEPTANCE_PENDING',
      email: 'jane@example.com',
      contactMasked: false,
      availableActions: [
        { action: 'waiveAcceptance', label: 'Waive customer acceptance', to: 'CUSTOMER_ACCEPTED', requiresReason: true, confirm: true },
        { action: 'close', label: 'Close', to: 'CLOSED', requiresReason: false, confirm: true },
      ],
    } as unknown as ComplaintDetailDto;
    apiMock.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/closure-checklist')) return { data: checklist };
      if (url.endsWith('/acceptance'))
        return {
          data: {
            status: 'PENDING',
            requestedAt: '2026-11-13T08:00:00.000Z',
            decidedAt: null,
            summary,
            records: [],
            pendingLink: { recipientEmail: 'jane@example.com', expiresAt: '2026-11-12T08:00:00.000Z', viewedAt: null, expired: true },
            canDecide: false,
            canRequest: false,
            canResend: true,
            canWaive: true,
          },
        };
      throw new Error(url);
    });
    render(
      <Wrapper auth={makeAuth(makeUser(perms('SUPERVISOR')))}>
        <ResolutionAcceptancePanel complaint={complaint} onChanged={() => undefined} />
      </Wrapper>,
    );
    expect(await screen.findByText('NCRs verified or closed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /close complaint/i })).toBeDisabled();
    expect(await screen.findByTestId('pending-link')).toHaveTextContent(/expired/);
    expect(screen.getByRole('button', { name: /resend link/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /waive acceptance/i })).toBeInTheDocument();
  });
});
