import { z } from 'zod';

import { PlanningSnapshotReferenceSchema } from '../../planning/run-planning-snapshot.js';
import { WorkspaceLocatorSchema } from '../../workspaces/contracts.js';
import {
  JsonValueSchema,
  StepActivityDeliverySchema,
  WorkflowChangeRequestSchema,
} from '../../workflow/index.js';

export const ExecuteTaskStepInputSchema = z
  .object({
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
    nodeId: z.string().min(1),
    stepAttempt: z.number().int().positive(),
    uses: z.string().min(1),
    activityDelivery: StepActivityDeliverySchema,
    workspace: WorkspaceLocatorSchema,
    planningSnapshot: PlanningSnapshotReferenceSchema,
    operatorGuidance: z.string().trim().min(1).max(10_000).nullable(),
    waitResolution: JsonValueSchema.nullable(),
    input: JsonValueSchema,
  })
  .strict()
  .readonly();

const ExecuteTaskStepResultBaseSchema = z.object({
  summary: z.string().min(1),
  artifactIds: z.array(z.string().min(1)),
  transcriptId: z.string().min(1).nullable(),
});

export const ExecuteTaskStepResultSchema = z.discriminatedUnion('status', [
  ExecuteTaskStepResultBaseSchema.extend({
    status: z.literal('completed'),
  })
    .strict()
    .readonly(),
  ExecuteTaskStepResultBaseSchema.extend({
    status: z.literal('blocked'),
    waitKind: z.string().min(1),
  })
    .strict()
    .readonly(),
  ExecuteTaskStepResultBaseSchema.extend({
    status: z.literal('workflow_change_required'),
    request: WorkflowChangeRequestSchema,
  })
    .strict()
    .readonly(),
]);

export type ExecuteTaskStepInput = z.infer<typeof ExecuteTaskStepInputSchema>;
export type ExecuteTaskStepResult = z.infer<typeof ExecuteTaskStepResultSchema>;
