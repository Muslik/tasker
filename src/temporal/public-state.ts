import { z } from 'zod';

import {
  PlanningQuestionSchema,
  PlanningStrategyRequestSchema,
  PlanningStrategySchema,
  WorkflowChangeRequestSchema as PlanningWorkflowChangeRequestSchema,
} from '../planning/implementation-plan.js';
import { ImplementationPlannerReceiptSchema } from '../providers/contracts.js';
import { PlanningSnapshotReferenceSchema } from '../planning/run-planning-snapshot.js';
import { WorkflowChangeRequestSchema as ExecutionWorkflowChangeRequestSchema } from '../workflow/execution-result.js';
import {
  WorkspaceBootstrapReceiptSchema,
  WorkspaceLocatorSchema,
} from '../workspaces/contracts.js';

export const TASK_WORKFLOW_SCHEMA_VERSION = 1;
export const TASKER_TEMPORAL_TASK_QUEUE = 'tasker-local';

export const TaskWorkflowSettingsSchema = z
  .object({
    planApproval: z.enum(['required', 'automatic']),
    planningStrategy: PlanningStrategyRequestSchema,
  })
  .strict()
  .readonly();

const TaskWorkflowPlanningBaseSchema = z.object({
  commandId: z.string().min(1),
  transcriptId: z.string().min(1),
  attempt: z.number().int().positive(),
  artifactId: z.string().min(1),
  requestedStrategy: PlanningStrategyRequestSchema,
  selectedStrategy: PlanningStrategySchema,
  receipt: ImplementationPlannerReceiptSchema,
});

export const TaskWorkflowPlanningStateSchema = z.discriminatedUnion('status', [
  TaskWorkflowPlanningBaseSchema.extend({ status: z.literal('ready') }).strict(),
  TaskWorkflowPlanningBaseSchema.extend({
    status: z.literal('needs_clarification'),
    questions: z.array(PlanningQuestionSchema).min(1).max(10),
  }).strict(),
  TaskWorkflowPlanningBaseSchema.extend({
    status: z.literal('workflow_change_required'),
    request: PlanningWorkflowChangeRequestSchema,
  }).strict(),
]);

export const TaskWorkflowExecutionContextSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('preparing') }).strict(),
  z
    .object({
      status: z.literal('ready'),
      workspace: WorkspaceLocatorSchema,
      bootstrap: WorkspaceBootstrapReceiptSchema,
      planningSnapshot: PlanningSnapshotReferenceSchema,
    })
    .strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
]);

export const TemporalNodeStatusSchema = z.enum([
  'planned',
  'running',
  'waiting',
  'succeeded',
  'skipped',
  'failed',
]);

const TaskWorkflowStateBaseSchema = z
  .object({
    schemaVersion: z.literal(TASK_WORKFLOW_SCHEMA_VERSION),
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    runId: z.string().min(1),
    workflowHash: z.string().min(1),
    settings: TaskWorkflowSettingsSchema,
    executionContext: TaskWorkflowExecutionContextSchema,
    planning: TaskWorkflowPlanningStateSchema.nullable(),
    workflowChange: z
      .object({
        nodeId: z.string().min(1),
        attempt: z.number().int().positive(),
        artifactId: z.string().min(1),
        request: z.union([
          PlanningWorkflowChangeRequestSchema,
          ExecutionWorkflowChangeRequestSchema,
        ]),
      })
      .strict()
      .readonly()
      .nullable(),
    nodeStates: z.record(z.string(), TemporalNodeStatusSchema),
    attempts: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();

export const TaskWorkflowWaitSchema = z
  .object({
    nodeId: z.string().min(1),
    waitKind: z.string().min(1),
  })
  .strict();

export const TaskWorkflowPublicStateSchema = z.discriminatedUnion('status', [
  TaskWorkflowStateBaseSchema.extend({
    status: z.literal('running'),
    currentNodeId: z.string().min(1).nullable(),
    wait: z.null(),
    outcome: z.null(),
  }).strict(),
  TaskWorkflowStateBaseSchema.extend({
    status: z.literal('waiting'),
    currentNodeId: z.string().min(1),
    wait: TaskWorkflowWaitSchema,
    outcome: z.null(),
  }).strict(),
  TaskWorkflowStateBaseSchema.extend({
    status: z.literal('completed'),
    currentNodeId: z.null(),
    wait: z.null(),
    outcome: z.string().min(1),
  }).strict(),
  TaskWorkflowStateBaseSchema.extend({
    status: z.literal('unavailable'),
    currentNodeId: z.null(),
    wait: z.null(),
    outcome: z.null(),
    reason: z.string().min(1),
    temporalStatus: z.string().min(1),
  }).strict(),
]);

export type TaskWorkflowSettings = z.infer<typeof TaskWorkflowSettingsSchema>;
export type TaskWorkflowExecutionContext = z.infer<typeof TaskWorkflowExecutionContextSchema>;
export type TaskWorkflowPlanningState = z.infer<typeof TaskWorkflowPlanningStateSchema>;
export type TemporalNodeStatus = z.infer<typeof TemporalNodeStatusSchema>;
export type TaskWorkflowWait = z.infer<typeof TaskWorkflowWaitSchema>;
export type TaskWorkflowChange = TaskWorkflowPublicState['workflowChange'];
export type TaskWorkflowPublicState = z.infer<typeof TaskWorkflowPublicStateSchema>;
