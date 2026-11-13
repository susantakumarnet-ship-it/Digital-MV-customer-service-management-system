import { registerGuard } from '../../core/workflow/workflow.engine';

/** Work-order transition guards (WF-02). Registered at startup; unregistered guards fail closed. */
export function registerWorkOrderGuards() {
  registerGuard('hasAssignees', ({ record }) =>
    Array.isArray(record.assigneeIds) && record.assigneeIds.length ? null : 'Assign at least one engineer first.',
  );

  // Only an assigned engineer may accept the work.
  registerGuard('actorIsAssignee', ({ record, ctx }) => {
    const ids = ((record.assigneeIds as unknown[]) ?? []).map(String);
    return ctx.auth && ids.includes(ctx.auth.userId) ? null : 'Only an engineer assigned to this work order can do this.';
  });

  registerGuard('plannedDateSet', ({ record }) => (record.plannedVisitAt ? null : 'Set the planned visit date first.'));
}
