import { z } from 'zod';

import { AgentClaimCategorySchema } from '../../steps/contracts.js';
import { PlanningSnapshotReferenceSchema } from '../../planning/run-planning-snapshot.js';
import { WorkspaceLocatorSchema } from '../../workspace/contracts.js';
import { JsonValueSchema, StepActivityDeliverySchema } from '../../graph/schema.js';
import { WorkflowChangeRequestSchema } from '../../graph/execution-result.js';
import { TrackerStatusUpdatesSchema } from '../../shared/task-run-settings.js';

export const agentStepOutcomeSchema = (outputSchema: z.ZodType) =>
  z.discriminatedUnion('status', [
    z
      .object({
        status: z.literal('completed'),
        output: outputSchema,
      })
      .strict()
      .readonly(),
    z
      .object({
        status: z.literal('waiting'),
        waitKind: z.string().min(1),
        reason: z.string().trim().min(1).max(4_000),
        resumeHint: z.string().trim().min(1).max(4_000).optional(),
        category: AgentClaimCategorySchema,
        retryable: z.boolean(),
      })
      .strict()
      .readonly(),
    z
      .object({
        status: z.literal('failed'),
        category: AgentClaimCategorySchema,
        detail: z.string().trim().min(1).max(4_000),
        retryable: z.boolean(),
      })
      .strict()
      .readonly(),
    z
      .object({
        status: z.literal('workflow_change'),
        request: WorkflowChangeRequestSchema,
      })
      .strict()
      .readonly(),
  ]);

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
    trackerStatusUpdates: TrackerStatusUpdatesSchema.default('enabled'),
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
    category: AgentClaimCategorySchema,
    retryable: z.boolean(),
  })
    .strict()
    .readonly(),
  ExecuteTaskStepResultBaseSchema.extend({
    status: z.literal('workflow_change_required'),
    request: WorkflowChangeRequestSchema,
  })
    .strict()
    .readonly(),
  ExecuteTaskStepResultBaseSchema.extend({
    status: z.literal('failed'),
    category: AgentClaimCategorySchema,
    retryable: z.boolean(),
  })
    .strict()
    .readonly(),
]);

export type ExecuteTaskStepInput = z.input<typeof ExecuteTaskStepInputSchema>;
export type ExecuteTaskStepResult = z.infer<typeof ExecuteTaskStepResultSchema>;
export type AgentStepOutcome = z.infer<ReturnType<typeof agentStepOutcomeSchema>>;
