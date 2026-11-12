import { z } from 'zod';
import { STATUS_TONES, WORKFLOW_ENTITIES } from '../enums';

export const workflowStateSchema = z.object({
  key: z.string().regex(/^[A-Z_]+$/),
  label: z.string().trim().min(1).max(60),
  tone: z.enum(STATUS_TONES),
  terminal: z.boolean().default(false),
  /** Records in this state are read-only except via transitions. */
  locked: z.boolean().default(false),
});

export const workflowTransitionSchema = z.object({
  action: z.string().regex(/^[a-zA-Z]+$/),
  label: z.string().trim().min(1).max(60),
  from: z.array(z.string()).min(1),
  to: z.string(),
  permission: z.string(),
  requiresReason: z.boolean().default(false),
  /** Named guard functions registered in code. Config may only reference registered guards. */
  guards: z.array(z.string()).default([]),
  /** Optional transitions can be disabled by admins; mandatory ones cannot. */
  optional: z.boolean().default(false),
  enabled: z.boolean().default(true),
  /** Transition is performed only by the system (e.g. on report submission), not via the generic endpoint. */
  systemOnly: z.boolean().default(false),
  confirm: z.boolean().default(false),
});

export type WorkflowState = z.infer<typeof workflowStateSchema>;
export type WorkflowTransition = z.infer<typeof workflowTransitionSchema>;

export interface WorkflowDefinitionDto {
  id: string;
  entity: (typeof WORKFLOW_ENTITIES)[number];
  name: string;
  version: number;
  initialState: string;
  states: WorkflowState[];
  transitions: WorkflowTransition[];
  updatedAt: string;
}

/** Admin-editable parts: state labels/tones and enable/disable of optional transitions. */
export const workflowUpdateSchema = z.object({
  states: z
    .array(z.object({ key: z.string(), label: z.string().trim().min(1).max(60), tone: z.enum(STATUS_TONES) }))
    .optional(),
  transitions: z.array(z.object({ action: z.string(), label: z.string().trim().min(1).max(60), enabled: z.boolean() })).optional(),
  reason: z.string().trim().min(1, 'Reason is required').max(1000),
});
