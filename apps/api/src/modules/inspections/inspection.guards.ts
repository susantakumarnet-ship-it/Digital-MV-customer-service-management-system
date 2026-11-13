import { registerGuard } from '../../core/workflow/workflow.engine';
import { computeSubmissionIssues, missingTimeEvents } from './inspection.service';

/** Inspection-report submission guards (BR-006..008, D-33). */
export function registerInspectionGuards() {
  registerGuard('reportComplete', async ({ record, ctx, session }) => {
    const issues = (await computeSubmissionIssues(record, ctx.auth!.userId, session)).filter((i) => !i.startsWith('Record your time events'));
    if (!issues.length) return null;
    return `The report is incomplete (${issues.length} issue${issues.length === 1 ? '' : 's'}): ${issues.slice(0, 5).join('; ')}${issues.length > 5 ? '; …' : ''}`;
  });

  registerGuard('timeSequenceComplete', async ({ record, ctx, session }) => {
    const missing = await missingTimeEvents(record.visitId, ctx.auth!.userId, session);
    return missing.length ? `Record your time events before submitting: ${missing.join(', ')}.` : null;
  });
}
