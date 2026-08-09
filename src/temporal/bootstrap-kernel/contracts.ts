import { z } from 'zod';

import {
  PlanningQuestionAnswerSchema,
  PlanningQuestionSchema,
  PlanningStrategyRequestSchema,
  PlanningStrategySchema,
  WorkflowChangeRequestSchema,
} from '../../planning/implementation-plan.js';
import {
  PlanningSnapshotReferenceSchema,
  type PlanningSnapshotReference,
} from '../../planning/run-planning-snapshot.js';
import { EvidenceBundleReferenceSchema } from '../../planning/evidence-bundle.js';
import { ImplementationPlannerReceiptSchema } from '../../providers/contracts.js';
import { CompiledWorkflowSchema, JsonValueSchema } from '../../workflow/index.js';
import { DockerWorkspaceRuntimeReceiptSchema } from '../../workspaces/docker-runtime-contracts.js';
import {
  WorkspaceBootstrapReceiptSchema,
  WorkspaceLocatorSchema,
} from '../../workspaces/contracts.js';
import {
  WorkflowFreezeReceiptSchema,
  type FreezeTaskWorkflowInput,
  type WorkflowFreezeReceipt,
} from '../freeze-contracts.js';

export const BOOTSTRAP_WORKFLOW_SCHEMA_VERSION = 2;

export const TaskRunSettingsSchema = z
  .object({
    planReview: z.enum(['required', 'automatic']),
    planningStrategy: PlanningStrategyRequestSchema,
  })
  .strict()
  .readonly();

export const BootstrapWorkflowInputSchema = z
  .object({
    schemaVersion: z.literal(BOOTSTRAP_WORKFLOW_SCHEMA_VERSION),
    taskReference: z.string().min(1),
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
    graph: CompiledWorkflowSchema,
    settings: TaskRunSettingsSchema,
  })
  .strict()
  .readonly();

const BootstrapPlanningBaseSchema = z.object({
  commandId: z.string().min(1),
  transcriptId: z.string().min(1),
  attempt: z.number().int().positive(),
  artifactId: z.string().min(1),
  evidenceBundle: EvidenceBundleReferenceSchema,
  requestedStrategy: PlanningStrategyRequestSchema,
  selectedStrategy: PlanningStrategySchema,
  receipt: ImplementationPlannerReceiptSchema,
});

export const BootstrapPlanningStateSchema = z.discriminatedUnion('status', [
  BootstrapPlanningBaseSchema.extend({ status: z.literal('ready') }).strict(),
  BootstrapPlanningBaseSchema.extend({
    status: z.literal('needs_clarification'),
    questions: z.array(PlanningQuestionSchema).min(1).max(10),
  }).strict(),
  BootstrapPlanningBaseSchema.extend({
    status: z.literal('workflow_change_required'),
    request: WorkflowChangeRequestSchema,
  }).strict(),
]);

export const BootstrapExecutionContextSchema = z
  .object({
    workspace: WorkspaceLocatorSchema,
    bootstrap: WorkspaceBootstrapReceiptSchema,
    runtime: DockerWorkspaceRuntimeReceiptSchema,
    planningSnapshot: PlanningSnapshotReferenceSchema,
  })
  .strict()
  .readonly();

export const BootstrapStageStatusSchema = z.enum([
  'planned',
  'running',
  'waiting',
  'succeeded',
  'skipped',
  'failed',
]);

export const BootstrapWaitSchema = z
  .object({
    nodeId: z.string().min(1),
    waitKind: z.string().min(1),
    reason: z.string().min(1).optional(),
  })
  .strict()
  .readonly();

const BootstrapWorkflowStateBaseSchema = z
  .object({
    runtime: z.literal('bootstrap'),
    schemaVersion: z.literal(BOOTSTRAP_WORKFLOW_SCHEMA_VERSION),
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    runId: z.string().min(1),
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
    settings: TaskRunSettingsSchema,
    phase: z.enum(['workspace', 'planning', 'plan_review', 'freezing', 'execution']),
    executionContext: BootstrapExecutionContextSchema.nullable(),
    planning: BootstrapPlanningStateSchema.nullable(),
    freezeReceipt: WorkflowFreezeReceiptSchema.nullable(),
    executionWorkflowId: z.string().min(1).nullable(),
    nodeStates: z.record(z.string(), BootstrapStageStatusSchema),
    attempts: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();

export const BootstrapWorkflowPublicStateSchema = z.discriminatedUnion('status', [
  BootstrapWorkflowStateBaseSchema.extend({
    status: z.literal('running'),
    currentNodeId: z.string().min(1).nullable(),
    wait: z.null(),
    outcome: z.null(),
  }).strict(),
  BootstrapWorkflowStateBaseSchema.extend({
    status: z.literal('waiting'),
    currentNodeId: z.string().min(1),
    wait: BootstrapWaitSchema,
    outcome: z.null(),
  }).strict(),
  BootstrapWorkflowStateBaseSchema.extend({
    status: z.literal('completed'),
    phase: z.literal('execution'),
    executionWorkflowId: z.string().min(1),
    currentNodeId: z.null(),
    wait: z.null(),
    outcome: z.string().min(1),
  }).strict(),
]);

export const ResolveBootstrapWaitCommandSchema = z
  .object({
    nodeId: z.string().min(1),
    waitKind: z.string().min(1),
    resolution: JsonValueSchema,
  })
  .strict()
  .readonly();

export const ResolveBootstrapWaitReceiptSchema = z
  .object({
    nodeId: z.string().min(1),
    waitKind: z.string().min(1),
    accepted: z.literal(true),
  })
  .strict()
  .readonly();

export const PlanningActivityCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('initial') }).strict(),
  z
    .object({
      kind: z.literal('clarification'),
      sourceAttempt: z.number().int().positive(),
      answers: z.array(PlanningQuestionAnswerSchema).min(1).max(10),
    })
    .strict(),
  z
    .object({
      kind: z.literal('revision'),
      sourceAttempt: z.number().int().positive(),
      guidance: z.string().trim().min(1).max(10_000),
    })
    .strict(),
]);

export const PlanTaskImplementationInputSchema = z
  .object({
    taskReference: z.string().min(1),
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
    planningSnapshot: PlanningSnapshotReferenceSchema,
    commandId: z.string().min(1),
    requestedStrategy: PlanningStrategyRequestSchema,
    command: PlanningActivityCommandSchema,
  })
  .strict()
  .readonly();

export const PrepareTaskWorkspaceInputSchema = z
  .object({
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .readonly();

export const PrepareTaskWorkspaceResultSchema = z
  .object({
    workspace: WorkspaceLocatorSchema,
    bootstrap: WorkspaceBootstrapReceiptSchema,
    runtime: DockerWorkspaceRuntimeReceiptSchema,
    planningSnapshot: PlanningSnapshotReferenceSchema,
  })
  .strict()
  .readonly();

export const ReviseTaskWorkflowDraftInputSchema = z
  .object({
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    currentWorkflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
    operationId: z.string().min(1),
    request: WorkflowChangeRequestSchema,
    workspace: WorkspaceLocatorSchema,
  })
  .strict()
  .readonly();

export const ReviseTaskWorkflowDraftResultSchema = z
  .object({
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
    graph: CompiledWorkflowSchema,
    planningSnapshot: PlanningSnapshotReferenceSchema,
  })
  .strict()
  .readonly();

export const BootstrapWorkflowResultSchema = z
  .object({
    taskReference: z.string().min(1),
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
    outcome: z.string().min(1),
  })
  .strict()
  .readonly();

export type TaskRunSettings = z.infer<typeof TaskRunSettingsSchema>;
export type BootstrapWorkflowInput = z.infer<typeof BootstrapWorkflowInputSchema>;
export type BootstrapPlanningState = z.infer<typeof BootstrapPlanningStateSchema>;
export type BootstrapExecutionContext = z.infer<typeof BootstrapExecutionContextSchema>;
export type BootstrapStageStatus = z.infer<typeof BootstrapStageStatusSchema>;
export type BootstrapWorkflowPublicState = z.infer<typeof BootstrapWorkflowPublicStateSchema>;
export type ResolveBootstrapWaitCommand = z.infer<typeof ResolveBootstrapWaitCommandSchema>;
export type ResolveBootstrapWaitReceipt = z.infer<typeof ResolveBootstrapWaitReceiptSchema>;
export type PlanningActivityCommand = z.infer<typeof PlanningActivityCommandSchema>;
export type PlanTaskImplementationInput = z.infer<typeof PlanTaskImplementationInputSchema>;
export type PrepareTaskWorkspaceInput = z.infer<typeof PrepareTaskWorkspaceInputSchema>;
export type PrepareTaskWorkspaceResult = z.infer<typeof PrepareTaskWorkspaceResultSchema>;
export type ReviseTaskWorkflowDraftInput = z.infer<typeof ReviseTaskWorkflowDraftInputSchema>;
export type ReviseTaskWorkflowDraftResult = z.infer<typeof ReviseTaskWorkflowDraftResultSchema>;
export type BootstrapWorkflowResult = z.infer<typeof BootstrapWorkflowResultSchema>;
export type { FreezeTaskWorkflowInput, WorkflowFreezeReceipt, PlanningSnapshotReference };

export interface BootstrapWorkflowActivities {
  prepareTaskWorkspace(input: PrepareTaskWorkspaceInput): Promise<PrepareTaskWorkspaceResult>;
  planTaskImplementation(input: PlanTaskImplementationInput): Promise<BootstrapPlanningState>;
  reviseTaskWorkflowDraft(
    input: ReviseTaskWorkflowDraftInput,
  ): Promise<ReviseTaskWorkflowDraftResult>;
  freezeTaskWorkflow(input: FreezeTaskWorkflowInput): Promise<WorkflowFreezeReceipt>;
}
