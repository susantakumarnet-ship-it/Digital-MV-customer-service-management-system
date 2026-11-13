import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComplaintDetailDto } from '@mv/shared';
import { buildComplaintParams, filtersFromParams, precheckFiles, type AttachmentPolicy } from '@/features/complaints/complaint-lib';
import { makeAuth, makeUser, Wrapper } from './utils';

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/api')>();
  return { ...orig, api: apiMock };
});
vi.mock('@/lib/queries', () => ({
  usePublicSettings: () => ({ data: { applicationName: 'Test', attachments: POLICY } }),
  useMasterOptions: () => ({ data: [] }),
  useRoles: () => ({ data: [] }),
}));

const POLICY: AttachmentPolicy = { allowedExtensions: ['jpg', 'pdf'], maxFileSizeMb: 1, maxFilesPerRecord: 3, maxTotalSizeMbPerRecord: 2 };

const BOOT = {
  formToken: 'token-1234567890',
  privacyNoticeVersion: '1.0',
  privacyNoticeText: 'We use your data to resolve your complaint.',
  attachments: POLICY,
  captchaSiteKey: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.get.mockImplementation(async (url: string) => (url === '/public/complaint-form' ? { data: BOOT } : { data: [] }));
});

describe('public complaint form', () => {
  it('cannot advance past step 1 with an invalid email or mobile', async () => {
    const { PublicComplaintPage } = await import('@/features/complaints/public-complaint-page');
    render(
      <Wrapper auth={makeAuth(null)} route="/report">
        <PublicComplaintPage />
      </Wrapper>,
    );
    await userEvent.type(await screen.findByLabelText(/Customer name/), 'Jane Doe');
    await userEvent.type(screen.getByLabelText(/Mobile number/), '12ab');
    await userEvent.type(screen.getByLabelText(/Email address/), 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(await screen.findByText('Enter a valid mobile number')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    // Still on the contact step.
    expect(screen.getByLabelText(/Customer name/)).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  }, 20_000);

  it('has a honeypot field that is hidden and not focusable', async () => {
    const { PublicComplaintPage } = await import('@/features/complaints/public-complaint-page');
    const { container } = render(
      <Wrapper auth={makeAuth(null)} route="/report">
        <PublicComplaintPage />
      </Wrapper>,
    );
    await screen.findByLabelText(/Customer name/);
    const hp = container.querySelector('input[name="website"]') as HTMLInputElement;
    expect(hp).toBeTruthy();
    expect(hp.tabIndex).toBe(-1);
    expect(hp.getAttribute('autocomplete')).toBe('off');
    expect(hp.closest('[aria-hidden="true"]')).toBeTruthy();
  });

  it('requires consent on the consent step', async () => {
    const { publicFormSchema, STEPS } = await import('@/features/complaints/public-complaint-page');
    expect(STEPS[3].fields).toContain('consentAccepted');
    const base = {
      customerName: 'Jane Doe',
      mobile: '+44 7700 900123',
      email: 'jane@example.com',
      regionId: 'a'.repeat(24),
      cityId: 'b'.repeat(24),
      siteId: 'c'.repeat(24),
      requestTypeId: 'd'.repeat(24),
      description: 'The transformer is making a loud noise.',
    };
    const r = publicFormSchema.safeParse({ ...base, consentAccepted: false });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path[0])).toEqual(['consentAccepted']);
    expect(publicFormSchema.safeParse({ ...base, consentAccepted: true }).success).toBe(true);
  });
});

describe('file pre-check', () => {
  const file = (name: string, size: number) => new File([new Uint8Array(size)], name);

  it('rejects disallowed extensions and oversize files', () => {
    const r = precheckFiles([file('virus.exe', 10), file('big.pdf', 2 * 1024 * 1024), file('ok.jpg', 100)], POLICY);
    expect(r.accepted.map((f) => f.name)).toEqual(['ok.jpg']);
    expect(r.errors[0]).toMatch(/virus\.exe.*not allowed/);
    expect(r.errors[1]).toMatch(/big\.pdf.*larger than 1 MB/);
  });

  it('enforces count and total size including existing files', () => {
    const r = precheckFiles([file('a.jpg', 100), file('b.jpg', 100)], POLICY, { count: 2, bytes: 0 });
    expect(r.accepted).toHaveLength(1);
    expect(r.errors[0]).toMatch(/At most 3 files/);
    const t = precheckFiles([file('c.pdf', 900 * 1024)], POLICY, { count: 0, bytes: 1.5 * 1024 * 1024 });
    expect(t.accepted).toHaveLength(0);
    expect(t.errors[0]).toMatch(/2 MB total/);
  });
});

describe('list filter → query params', () => {
  it('maps quick tabs and filters to API parameters', () => {
    expect(buildComplaintParams({ tab: 'open' })).toEqual({ status: 'OPEN', page: 1, limit: 20 });
    expect(buildComplaintParams({ tab: 'overdue', q: '  MV-2026 ', priorityId: 'p1', unclassified: true, sort: '-dueAt', page: 3 })).toEqual({
      overdue: 'true',
      q: 'MV-2026',
      priorityId: 'p1',
      unclassified: 'true',
      sort: '-dueAt',
      page: 3,
      limit: 20,
    });
    const p = buildComplaintParams({ tab: 'all', receivedFrom: '2026-11-01', receivedTo: '2026-11-30' });
    expect(p.status).toBeUndefined();
    expect(new Date(String(p.receivedFrom)).getTime()).toBeLessThan(new Date(String(p.receivedTo)).getTime());
  });

  it('reads filters back from URL search params with safe defaults', () => {
    const f = filtersFromParams(new URLSearchParams('tab=bogus&page=x&unclassified=true&siteId=s1'));
    expect(f).toMatchObject({ tab: 'open', page: 1, unclassified: true, siteId: 's1', sort: '-receivedAt' });
  });
});

function detail(overrides: Partial<ComplaintDetailDto> = {}): ComplaintDetailDto {
  return {
    id: 'c1',
    referenceNo: 'MV-2026-000001',
    status: 'UNDER_REVIEW',
    statusLabel: 'Under Review',
    statusTone: 'primary',
    source: 'PUBLIC_FORM',
    customerName: 'Jane Doe',
    site: { id: 's1', name: 'Substation 1', code: 'SS1' },
    region: { id: 'r1', name: 'North' },
    city: { id: 'ci1', name: 'Northfield' },
    receivedAt: '2026-11-12T10:00:00.000Z',
    dueAt: null,
    overdue: false,
    supervisor: null,
    duplicateOf: null,
    mobile: '••••••• 123',
    email: 'j***@example.com',
    contactMasked: false,
    description: 'Noise from the transformer',
    consent: { accepted: true, version: '1.0' },
    attachments: [],
    customerMessages: [],
    linkedDuplicates: [],
    workOrders: [],
    statusHistory: [{ to: 'NEW', toLabel: 'New', action: 'submit', at: '2026-11-12T10:00:00.000Z' }],
    availableActions: [],
    permissions: { canEdit: false, canClassify: false, canAddNote: false, canAttach: false, canRespond: false, canCreateWorkOrder: false },
    createdAt: '2026-11-12T10:00:00.000Z',
    updatedAt: '2026-11-12T10:00:00.000Z',
    ...overrides,
  };
}

describe('complaint actions bar', () => {
  it('renders exactly the server-provided actions and requires a reason when needed', async () => {
    const { ComplaintActions } = await import('@/features/complaints/complaint-actions');
    const c = detail({
      availableActions: [
        { action: 'requestInfo', label: 'Request information', to: 'AWAITING_CUSTOMER_INFO', requiresReason: true, confirm: false },
        { action: 'reject', label: 'Reject', to: 'REJECTED', requiresReason: true, confirm: true },
      ],
    });
    render(
      <Wrapper auth={makeAuth(makeUser(['complaint.read', 'complaint.reject', 'complaint.requestInfo']))}>
        <ComplaintActions complaint={c} onChanged={vi.fn()} />
      </Wrapper>,
    );
    const bar = screen.getByLabelText('Workflow actions');
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['Request information', 'Reject']);
    expect(screen.queryByRole('button', { name: 'Mark as duplicate' })).not.toBeInTheDocument();

    await userEvent.click(within(bar).getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await within(dialog).findByText('A reason is required')).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();

    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Not our equipment');
    apiMock.post.mockResolvedValueOnce({ data: detail({ status: 'REJECTED', statusLabel: 'Rejected' }) });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(apiMock.post).toHaveBeenCalledWith('/complaints/c1/transitions', { action: 'reject', reason: 'Not our equipment', messageToCustomer: undefined });
  });

  it('renders nothing when no actions are available', async () => {
    const { ComplaintActions } = await import('@/features/complaints/complaint-actions');
    render(
      <Wrapper auth={makeAuth(makeUser(['complaint.read']))}>
        <ComplaintActions complaint={detail()} onChanged={vi.fn()} />
      </Wrapper>,
    );
    expect(screen.queryByLabelText('Workflow actions')).not.toBeInTheDocument();
  });
});

describe('complaint detail view', () => {
  it('hides internal notes when not provided and shows the masked-contact hint', async () => {
    const { ComplaintDetailView } = await import('@/features/complaints/complaint-detail-page');
    render(
      <Wrapper auth={makeAuth(makeUser(['complaint.read', 'dashboard.management']))}>
        <ComplaintDetailView complaint={detail({ contactMasked: true, internalNotes: undefined })} onChanged={vi.fn()} />
      </Wrapper>,
    );
    expect(screen.queryByTestId('internal-notes')).not.toBeInTheDocument();
    expect(screen.getByTestId('masked-hint')).toBeInTheDocument();
    expect(screen.getByText('j***@example.com')).toBeInTheDocument();
  });

  it('shows internal notes to staff who can read them', async () => {
    const { ComplaintDetailView } = await import('@/features/complaints/complaint-detail-page');
    render(
      <Wrapper auth={makeAuth(makeUser(['complaint.read', 'complaint.readInternal', 'complaint.update']))}>
        <ComplaintDetailView
          complaint={detail({
            internalNotes: [{ id: 'n1', text: 'Called the site manager', byName: 'Sam', at: '2026-11-12T11:00:00.000Z' }],
            permissions: { canEdit: false, canClassify: false, canAddNote: true, canAttach: false, canRespond: false, canCreateWorkOrder: false },
          })}
          onChanged={vi.fn()}
        />
      </Wrapper>,
    );
    expect(screen.getByTestId('internal-notes')).toBeInTheDocument();
    expect(screen.getByText('Called the site manager')).toBeInTheDocument();
    expect(screen.queryByTestId('masked-hint')).not.toBeInTheDocument();
  });
});
