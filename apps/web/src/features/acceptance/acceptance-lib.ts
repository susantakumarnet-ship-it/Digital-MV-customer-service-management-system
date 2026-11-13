import { useQuery } from '@tanstack/react-query';
import type { AcceptanceRecordDto, AcceptanceSummaryDto, ClosureChecklistDto, StatusTone } from '@mv/shared';
import { api } from '@/lib/api';

/** GET /complaints/:id/acceptance (acceptance.service.ts acceptanceForComplaint). */
export interface AcceptanceView {
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'WAIVED' | null;
  requestedAt: string | null;
  decidedAt: string | null;
  summary: AcceptanceSummaryDto;
  records: AcceptanceRecordDto[];
  pendingLink: { recipientEmail: string; expiresAt: string; viewedAt: string | null; expired: boolean } | null;
  canDecide: boolean;
  canRequest: boolean;
  canResend: boolean;
  canWaive: boolean;
}

/** Public token view: summary + expiry + decided. */
export type TokenView = AcceptanceSummaryDto & { expiresAt?: string; decided?: AcceptanceSummaryDto['decided'] };

export const ACCEPTANCE_STATUS: Record<NonNullable<AcceptanceView['status']>, { label: string; tone: StatusTone }> = {
  PENDING: { label: 'Awaiting customer', tone: 'warning' },
  ACCEPTED: { label: 'Accepted', tone: 'success' },
  REJECTED: { label: 'Further action requested', tone: 'danger' },
  WAIVED: { label: 'Waived', tone: 'neutral' },
};

export const DECISION_LABEL: Record<AcceptanceRecordDto['decision'], string> = { ACCEPT: 'Accepted', REJECT: 'Further action requested', WAIVED: 'Acceptance waived' };
export const METHOD_LABEL: Record<AcceptanceRecordDto['method'], string> = { TOKEN: 'Secure email link', PORTAL: 'Customer portal', WAIVER: 'Supervisor waiver' };

/** Complaint statuses in which the acceptance section is meaningful. */
export const ACCEPTANCE_STAGE = new Set(['APPROVED', 'RESOLVED', 'CUSTOMER_ACCEPTANCE_PENDING', 'CUSTOMER_ACCEPTED', 'CLOSED', 'REOPENED']);

export function useAcceptance(complaintId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['complaints', complaintId, 'acceptance'],
    queryFn: async () => (await api.get<AcceptanceView>(`/complaints/${complaintId}/acceptance`)).data,
    enabled,
  });
}

export function useClosureChecklist(complaintId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['complaints', complaintId, 'closure-checklist'],
    queryFn: async () => (await api.get<ClosureChecklistDto>(`/complaints/${complaintId}/closure-checklist`)).data,
    enabled,
  });
}

export interface DecisionDraft {
  decision: 'ACCEPT' | 'REJECT' | '';
  comments: string;
  rating: number;
  feedback: string;
  signerName: string;
}

/** Mirrors acceptanceDecisionSchema (+ signer name required for the token flow). */
export function validateDecision(d: DecisionDraft, requireName: boolean): Partial<Record<keyof DecisionDraft, string>> {
  const e: Partial<Record<keyof DecisionDraft, string>> = {};
  if (!d.decision) e.decision = 'Choose whether to accept the service';
  if (d.decision === 'REJECT' && !d.comments.trim()) e.comments = 'Tell us what still needs to be done';
  if (requireName && d.signerName.trim().length < 2) e.signerName = 'Enter your name';
  return e;
}

export function decisionPayload(d: DecisionDraft, includeName: boolean) {
  return {
    decision: d.decision,
    comments: d.comments.trim() || undefined,
    rating: d.rating || undefined,
    feedback: d.feedback.trim() || undefined,
    signerName: includeName ? d.signerName.trim() || undefined : undefined,
  };
}

export function formatMinutes(m: number) {
  if (!m) return '0 min';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? `${h} h${r ? ` ${r} min` : ''}` : `${r} min`;
}
