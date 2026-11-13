import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import type { InspectionReportDto, ReportItemDto, ReviewQueueItemDto, RevisionComparisonDto } from '@mv/shared';
import { ApproveDialog, ReturnDialog } from '@/features/reviews/review-dialogs';
import { ActionBar } from '@/features/reviews/review-workspace-page';
import { CompareView } from '@/features/reviews/compare-page';
import { ReviewQueuePage } from '@/features/reviews/review-queue-page';
import { approvalStep, feedbackPayload, filterItems, waitingTone } from '@/features/reviews/review-lib';
import { InspectionReportPage } from '@/features/inspections/inspection-report-page';
import { makeAuth, makeUser, Wrapper } from './utils';

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/api')>();
  return { ...orig, api: apiMock };
});

const ID = (n: number) => n.toString(16).padStart(24, '0');
const reviewerAuth = () => makeAuth(makeUser(['inspection.read', 'inspection.approve', 'inspection.return']));

function item(overrides: Partial<ReportItemDto> = {}): ReportItemDto {
  return { key: 'K1', description: 'Check SF6 pressure', required: true, evidence: 'NONE', naReasonRequired: false, evidenceOnFail: false, attachments: [], issues: [], result: 'PASS', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('review helpers', () => {
  it('approvalStep reports the level and whether it is final', () => {
    expect(approvalStep(1, 0)).toEqual({ level: 1, levels: 1, final: true });
    expect(approvalStep(2, 0)).toEqual({ level: 1, levels: 2, final: false });
    expect(approvalStep(2, 1)).toEqual({ level: 2, levels: 2, final: true });
  });
  it('waiting tone: amber after 24 h, red after 48 h', () => {
    expect(waitingTone(3)).toBe('neutral');
    expect(waitingTone(25)).toBe('warning');
    expect(waitingTone(49)).toBe('danger');
    expect(waitingTone(null)).toBe('neutral');
  });
  it('filters items and drops blank feedback', () => {
    const items = [item({ key: 'A', result: 'FAIL' }), item({ key: 'B', result: 'NOT_CHECKED' }), item({ key: 'C' })];
    expect(filterItems(items, 'fail', {}).map((i) => i.key)).toEqual(['A']);
    expect(filterItems(items, 'notChecked', {}).map((i) => i.key)).toEqual(['B']);
    expect(filterItems(items, 'feedback', { C: 'redo', A: '  ' }).map((i) => i.key)).toEqual(['C']);
    expect(feedbackPayload({ A: ' fix photo ', B: '' })).toEqual([{ itemKey: 'A', comment: 'fix photo' }]);
  });
});

describe('ReturnDialog', () => {
  it('requires overall comments and lists the collected item feedback', async () => {
    const onConfirm = vi.fn(async () => undefined);
    const onFeedbackChange = vi.fn();
    render(
      <ReturnDialog
        open
        onOpenChange={vi.fn()}
        items={[item({ key: 'VIS', description: 'Enclosure condition' }), item({ key: 'IR', description: 'Insulation test' })]}
        feedback={{ VIS: 'Photo is blurry', IR: '' }}
        onFeedbackChange={onFeedbackChange}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText(/new revision will be created for the engineers/i)).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Item feedback' });
    expect(list).toHaveTextContent('Enclosure condition');
    expect(list).not.toHaveTextContent('Insulation test');
    expect(screen.getByLabelText('Feedback for VIS')).toHaveValue('Photo is blurry');

    await userEvent.click(screen.getByRole('button', { name: /Return for correction/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('Explain what must be corrected');
    expect(onConfirm).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText(/What must be corrected/), 'Retake the enclosure photo');
    await userEvent.click(screen.getByRole('button', { name: /Return for correction/ }));
    expect(onConfirm).toHaveBeenCalledWith('Retake the enclosure photo');

    await userEvent.click(screen.getByRole('button', { name: 'Remove feedback for VIS' }));
    expect(onFeedbackChange).toHaveBeenCalledWith('VIS', '');
  });
});

describe('ApproveDialog', () => {
  it('explains a non-final level and allows empty comments (D-29)', async () => {
    const onConfirm = vi.fn(async () => undefined);
    const { rerender } = render(<ApproveDialog open onOpenChange={vi.fn()} levels={2} approvalsSoFar={0} onConfirm={onConfirm} />);
    expect(screen.getByTestId('level-message')).toHaveTextContent('level 1 of 2');
    expect(screen.getByTestId('level-message')).toHaveTextContent('another reviewer must approve level 2');
    await userEvent.click(screen.getByRole('button', { name: /Approve level 1/ }));
    expect(onConfirm).toHaveBeenCalledWith('');
    rerender(<ApproveDialog open onOpenChange={vi.fn()} levels={2} approvalsSoFar={1} onConfirm={onConfirm} />);
    expect(screen.queryByTestId('level-message')).not.toBeInTheDocument();
    expect(screen.getByText(/final approval \(level 2 of 2\)/)).toBeInTheDocument();
  });
});

describe('ActionBar', () => {
  it('shows why no action is possible when nothing is permitted', () => {
    render(
      <ActionBar
        ctx={{ permissions: { canStartReview: false, canApprove: false, canReturn: false, reasonIfNot: 'You cannot review a report you authored or worked on (segregation of duties).' } }}
        busy={null}
        feedbackCount={0}
        onStart={vi.fn()}
        onApprove={vi.fn()}
        onReturn={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('segregation of duties');
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Return for correction/ })).not.toBeInTheDocument();
  });

  it('renders only the permitted actions', () => {
    render(
      <ActionBar
        ctx={{ permissions: { canStartReview: true, canApprove: true, canReturn: false } }}
        busy={null}
        feedbackCount={2}
        onStart={vi.fn()}
        onApprove={vi.fn()}
        onReturn={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Start review/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Return for correction/ })).not.toBeInTheDocument();
    expect(screen.getByText('2 item comment(s) ready')).toBeInTheDocument();
  });
});

describe('CompareView', () => {
  const data: RevisionComparisonDto = {
    from: { id: ID(1), revisionNo: 1, status: 'SUPERSEDED' },
    to: { id: ID(2), revisionNo: 2, status: 'SUBMITTED' },
    items: [
      { key: 'VIS', description: 'Enclosure condition', changed: true, from: { result: 'FAIL', remarks: 'rust', evidence: 0 }, to: { result: 'PASS', remarks: 'cleaned', evidence: 1 }, feedback: 'Add a photo' },
      { key: 'LBL', description: 'Labels present', changed: false, from: { result: 'PASS', evidence: 0 }, to: { result: 'PASS', evidence: 0 } },
    ],
    findingsChanged: false,
    recommendationsChanged: false,
  };

  it('hides unchanged items by default and shows from → to for changed ones', async () => {
    render(
      <Wrapper auth={reviewerAuth()}>
        <CompareView data={data} />
      </Wrapper>,
    );
    expect(screen.getByTestId('cmp-VIS')).toBeInTheDocument();
    expect(screen.queryByTestId('cmp-LBL')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Before: Fail')).toBeInTheDocument();
    expect(screen.getByLabelText('After: Pass')).toBeInTheDocument();
    expect(screen.getByLabelText('Before: 0 file(s)')).toBeInTheDocument();
    expect(screen.getByText('Add a photo')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: 'Show unchanged items' }));
    expect(screen.getByTestId('cmp-LBL')).toBeInTheDocument();
  });
});

describe('engineer view of a returned revision', () => {
  const returned = (): InspectionReportDto => ({
    id: ID(9),
    revisionNo: 2,
    status: 'DRAFT',
    statusLabel: 'Draft',
    statusTone: 'neutral',
    locked: false,
    visit: { id: ID(1), visitNo: 'VIS-2026-000001' },
    workOrder: { id: ID(2), workOrderNo: 'WO-2026-000001', title: 'Fix RMU' },
    complaint: { id: ID(3), referenceNo: 'MV-2026-000001' },
    template: { id: ID(5), name: 'RMU checklist', version: 1 },
    items: [item({ feedback: 'Retake the photo with the label visible' }), item({ key: 'K2', description: 'Labels', feedback: undefined })],
    summary: { total: 2, pass: 2, fail: 0, notChecked: 0, notApplicable: 0, unanswered: 0 },
    submissionIssues: [],
    previousRevisionId: ID(8),
    reviewFeedback: { reviewerName: 'Riley Reviewer', comments: 'Evidence is unclear', at: '2026-11-13T10:00:00Z' },
    permissions: { canEdit: true, canSubmit: true, canUpload: true },
    updatedAt: '2026-11-13T10:00:00Z',
  });

  it('shows the returned banner with a compare link and per-item feedback', async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/revisions')) return { data: [] };
      if (url.startsWith('/inspection-reports/')) return { data: returned() };
      return { data: {} };
    });
    render(
      <Wrapper auth={makeAuth(makeUser(['inspection.read', 'inspection.create', 'inspection.submit']))} route={`/inspection-reports/${ID(9)}`}>
        <Routes>
          <Route path="/inspection-reports/:id" element={<InspectionReportPage />} />
        </Routes>
      </Wrapper>,
    );
    const banner = await screen.findByTestId('returned-banner');
    expect(banner).toHaveTextContent('Returned for correction by Riley Reviewer');
    expect(banner).toHaveTextContent('Evidence is unclear');
    expect(screen.getByRole('link', { name: /Compare with previous revision/ })).toHaveAttribute('href', `/inspection-reports/${ID(9)}/compare?with=${ID(8)}`);
    expect(screen.getByTestId('feedback-K1')).toHaveTextContent('Retake the photo with the label visible');
    expect(screen.queryByTestId('feedback-K2')).not.toBeInTheDocument();
  });
});

describe('review queue', () => {
  const row = (overrides: Partial<ReviewQueueItemDto> = {}): ReviewQueueItemDto => ({
    id: ID(20),
    revisionNo: 1,
    status: 'SUBMITTED',
    statusLabel: 'Submitted',
    statusTone: 'warning',
    workOrder: { id: ID(2), workOrderNo: 'WO-2026-000007', title: 'Restore supply' },
    complaint: { id: ID(3), referenceNo: 'MV-2026-000003' },
    visit: { id: ID(4), visitNo: 'VIS-2026-000002' },
    siteName: 'Southport',
    template: 'RMU v1',
    submittedAt: '2026-11-13T08:00:00Z',
    submittedByName: 'Erin Engineer',
    approvalsSoFar: 0,
    approvalLevels: 1,
    isOwn: false,
    summary: { fail: 1, notChecked: 0 },
    waitingHours: 30,
    ...overrides,
  });

  it('flags the reviewer\'s own report as not reviewable and marks resubmissions', async () => {
    apiMock.get.mockResolvedValue({
      data: { data: [row({ isOwn: true }), row({ id: ID(21), revisionNo: 2, isOwn: false, approvalLevels: 2, approvalsSoFar: 1 })], meta: { page: 1, limit: 20, total: 2, pages: 1 } },
    });
    render(
      <Wrapper auth={reviewerAuth()} route="/reviews">
        <ReviewQueuePage />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getAllByText('WO-2026-000007').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Your report — cannot review')).toHaveLength(1);
    expect(screen.getByText('r2 · resubmitted')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 approvals')).toBeInTheDocument();
    expect(apiMock.get).toHaveBeenCalledWith('/reviews', expect.objectContaining({ params: expect.objectContaining({ status: 'PENDING' }) }));
  });
});
