import { z } from 'zod';

import {
  PlanningQuestionSchema,
  PlanningStrategyRequestSchema,
  PlanningStrategySchema,
  WorkflowChangeRequestSchema as PlanningWorkflowChangeRequestSchema,
} from '../planning/implementation-plan.js';
import { ImplementationPlannerReceiptSchema } from '../providers/contracts.js';
import { PlanningSnapshotReferenceSchema } from '../planning/run-planning-snapshot.js';
import { EvidenceBundleReferenceSchema } from '../planning/evidence-bundle.js';
import { WorkflowChangeRequestSchema as ExecutionWorkflowChangeRequestSchema } from '../workflow/execution-result.js';
import { DockerWorkspaceRuntimeReceiptSchema } from '../workspaces/docker-runtime-contracts.js';
import {
  WorkspaceBootstrapReceiptSchema,
  WorkspaceLocatorSchema,
} from '../workspaces/contracts.js';
import { WorkflowFreezeReceiptSchema } from './freeze-contracts.js';

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
  evidenceBundle: EvidenceBundleReferenceSchema,
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
      runtime: DockerWorkspaceRuntimeReceiptSchema,
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

export const TaskWorkflowLifecycleSchema = z.discriminatedUnion('phase', [
  z
    .object({ phase: z.literal('draft') })
    .strict()
    .readonly(),
  z
    .object({ phase: z.literal('frozen'), receipt: WorkflowFreezeReceiptSchema })
    .strict()
    .readonly(),
]);

export const TaskWorkflowWaitSchema = z
  .object({
    nodeId: z.string().min(1),
    waitKind: z.string().min(1),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const TaskWorkflowPublicStateSchema = z.discriminatedUnion('status', [
  TaskWorkflowStateBaseSchema.extend({
    status: z.literal('running'),
    lifecycle: TaskWorkflowLifecycleSchema,
    currentNodeId: z.string().min(1).nullable(),
    wait: z.null(),
    outcome: z.null(),
  }).strict(),
  TaskWorkflowStateBaseSchema.extend({
    status: z.literal('waiting'),
    lifecycle: TaskWorkflowLifecycleSchema,
    currentNodeId: z.string().min(1),
    wait: TaskWorkflowWaitSchema,
    outcome: z.null(),
  }).strict(),
  TaskWorkflowStateBaseSchema.extend({
    status: z.literal('completed'),
    lifecycle: z
      .object({ phase: z.literal('frozen'), receipt: WorkflowFreezeReceiptSchema })
      .strict()
      .readonly(),
    currentNodeId: z.null(),
    wait: z.null(),
    outcome: z.string().min(1),
  }).strict(),
  TaskWorkflowStateBaseSchema.extend({
    status: z.literal('unavailable'),
    lifecycle: z
      .object({ phase: z.literal('unknown') })
      .strict()
      .readonly(),
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
export type TaskWorkflowLifecycle = z.infer<typeof TaskWorkflowLifecycleSchema>;
export type TemporalNodeStatus = z.infer<typeof TemporalNodeStatusSchema>;
export type TaskWorkflowWait = z.infer<typeof TaskWorkflowWaitSchema>;
export type TaskWorkflowChange = TaskWorkflowPublicState['workflowChange'];
export type TaskWorkflowPublicState = z.infer<typeof TaskWorkflowPublicStateSchema>;
