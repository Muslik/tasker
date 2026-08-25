import { z } from 'zod';

import {
  PrePlanInvestigationRequestSchema,
  PlanningQuestionAnswerSchema,
  PlanningQuestionSchema,
  PlanningStrategyRequestSchema,
  PlanningStrategySchema,
} from '../../planning/implementation-plan.js';
import {
  PlanningSnapshotReferenceSchema,
  type PlanningSnapshotReference,
} from '../../planning/run-planning-snapshot.js';
import { EvidenceBundleReferenceSchema } from '../../planning/evidence-bundle.js';
import { ImplementationPlanningFailureSchema } from '../../planning/planning-failure.js';
import { CompiledWorkflowSchema, JsonValueSchema } from '../../workflow/schema.js';
import {
  WorkflowFreezeReceiptSchema,
  type FreezeTaskWorkflowInput,
  type WorkflowFreezeReceipt,
} from '../freeze-contracts.js';

export const BOOTSTRAP_WORKFLOW_SCHEMA_VERSION = 3;

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
    settings: TaskRunSettingsSchema,
  })
  .strict()
  .readonly();

const BootstrapPlanningAttemptSchema = z.object({
  planningEpisodeId: z.string().min(1),
  commandId: z.string().min(1),
  attempt: z.number().int().positive(),
  evidenceBundle: EvidenceBundleReferenceSchema,
  requestedStrategy: PlanningStrategyRequestSchema,
  selectedStrategy: PlanningStrategySchema,
});

const BootstrapPlanningBaseSchema = BootstrapPlanningAttemptSchema.extend({
  transcriptId: z.string().min(1),
  artifactId: z.string().min(1),
});

export const BootstrapPlanningStateSchema = z.discriminatedUnion('status', [
  BootstrapPlanningBaseSchema.extend({
    status: z.literal('ready'),
    workflowOperationId: z.string().min(1),
    draft: z.lazy(() => BootstrapDraftStateSchema),
  }).strict(),
  BootstrapPlanningBaseSchema.extend({
    status: z.literal('needs_clarification'),
    questions: z.array(PlanningQuestionSchema).min(1).max(10),
  }).strict(),
  BootstrapPlanningBaseSchema.extend({
    status: z.literal('investigation_required'),
    request: PrePlanInvestigationRequestSchema,
  }).strict(),
  BootstrapPlanningAttemptSchema.extend({
    status: z.literal('blocked'),
    transcriptId: z.string().min(1).nullable(),
    failure: ImplementationPlanningFailureSchema,
    validationFeedback: z.array(z.string().min(1).max(2_000)).max(50),
    validationRevision: z.number().int().nonnegative().max(3),
  }).strict(),
]);

export const BootstrapWorkspaceHandleSchema = z
  .object({
    workspaceId: z.string().min(1),
    repositoryReference: z.string().min(1),
    revision: z.string().min(1),
    path: z.string().min(1),
  })
  .strict()
  .readonly();

export const BootstrapWorkspaceContextSchema = z
  .object({
    workspace: BootstrapWorkspaceHandleSchema,
  })
  .strict()
  .readonly();

export const BootstrapDraftStateSchema = z
  .object({
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
    semanticHash: z.string().regex(/^[a-f0-9]{64}$/u),
    compilerVersion: z.string().min(1),
    harnessSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    retrospectiveEnabled: z.boolean(),
    graph: CompiledWorkflowSchema,
    planningSnapshot: PlanningSnapshotReferenceSchema,
    evidenceBundle: EvidenceBundleReferenceSchema,
  })
  .strict()
  .readonly();

export const BootstrapContextStateSchema = z
  .object({
    contextHash: z.string().regex(/^[a-f0-9]{64}$/u),
    planningSnapshot: PlanningSnapshotReferenceSchema,
    evidenceBundle: EvidenceBundleReferenceSchema,
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
    workflowHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    settings: TaskRunSettingsSchema,
    phase: z.enum([
      'workspace',
      'context',
      'investigation',
      'planning',
      'plan_review',
      'admission',
      'freezing',
      'execution',
    ]),
    workspaceContext: BootstrapWorkspaceContextSchema.nullable(),
    context: BootstrapContextStateSchema.nullable(),
    draft: BootstrapDraftStateSchema.nullable(),
    planning: BootstrapPlanningStateSchema.nullable(),
    activeTranscriptOperationId: z.string().min(1).nullable(),
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
    runId: z.string().min(1),
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
      kind: z.literal('investigation_completed'),
      sourceAttempt: z.number().int().positive(),
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
    planningEpisodeId: z.string().min(1),
    planningSnapshot: PlanningSnapshotReferenceSchema,
    evidenceBundle: EvidenceBundleReferenceSchema,
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
  })
  .strict()
  .readonly();

export const PrepareTaskWorkspaceResultSchema = z
  .object({
    workspace: BootstrapWorkspaceHandleSchema,
  })
  .strict()
  .readonly();

export const AssembleTaskPlanningContextInputSchema = z
  .object({
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    operationId: z.string().min(1),
    workspace: BootstrapWorkspaceHandleSchema,
  })
  .strict()
  .readonly();

export const AssembleTaskPlanningContextResultSchema = BootstrapContextStateSchema;

export const RunBootstrapInvestigationInputSchema = z
  .object({
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    contextHash: z.string().regex(/^[a-f0-9]{64}$/u),
    planningSnapshot: PlanningSnapshotReferenceSchema,
    evidenceBundle: EvidenceBundleReferenceSchema,
    workspace: BootstrapWorkspaceHandleSchema,
    step: PrePlanInvestigationRequestSchema.shape.steps.element,
    blockRun: z.number().int().positive(),
    operatorGuidance: z.string().trim().min(1).max(10_000).nullable(),
  })
  .strict()
  .readonly();

const BootstrapInvestigationResultBaseSchema = z.object({ summary: z.string().min(1) });

export const RunBootstrapInvestigationResultSchema = z.discriminatedUnion('status', [
  BootstrapInvestigationResultBaseSchema.extend({
    status: z.literal('completed'),
    evidenceBundle: EvidenceBundleReferenceSchema,
  }).strict(),
  BootstrapInvestigationResultBaseSchema.extend({
    status: z.literal('needs_input'),
    waitKind: z.string().min(1),
  }).strict(),
  BootstrapInvestigationResultBaseSchema.extend({
    status: z.literal('continuation_required'),
    waitKind: z.string().min(1),
    requestReference: z.string().min(1),
    evidenceBundle: EvidenceBundleReferenceSchema,
  }).strict(),
]);

export const AdmitTaskExecutionInputSchema = z
  .object({
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    planningSnapshot: PlanningSnapshotReferenceSchema,
    workspace: BootstrapWorkspaceHandleSchema,
    operatorGuidance: z.string().trim().min(1).max(10_000).nullable(),
    waitResolution: JsonValueSchema.nullable(),
  })
  .strict()
  .readonly();

export const AdmitTaskExecutionResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), summary: z.string().min(1) }).strict(),
  z
    .object({
      status: z.literal('needs_input'),
      summary: z.string().min(1),
      waitKind: z.string().min(1),
    })
    .strict(),
]);

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
export type BootstrapWorkspaceContext = z.infer<typeof BootstrapWorkspaceContextSchema>;
export type BootstrapContextState = z.infer<typeof BootstrapContextStateSchema>;
export type BootstrapDraftState = z.infer<typeof BootstrapDraftStateSchema>;
export type BootstrapStageStatus = z.infer<typeof BootstrapStageStatusSchema>;
export type BootstrapWorkflowPublicState = z.infer<typeof BootstrapWorkflowPublicStateSchema>;
export type ResolveBootstrapWaitCommand = z.infer<typeof ResolveBootstrapWaitCommandSchema>;
export type ResolveBootstrapWaitReceipt = z.infer<typeof ResolveBootstrapWaitReceiptSchema>;
export type PlanningActivityCommand = z.infer<typeof PlanningActivityCommandSchema>;
export type PlanTaskImplementationInput = z.infer<typeof PlanTaskImplementationInputSchema>;
export type PrepareTaskWorkspaceInput = z.infer<typeof PrepareTaskWorkspaceInputSchema>;
export type PrepareTaskWorkspaceResult = z.infer<typeof PrepareTaskWorkspaceResultSchema>;
export type AssembleTaskPlanningContextInput = z.infer<
  typeof AssembleTaskPlanningContextInputSchema
>;
export type AssembleTaskPlanningContextResult = z.infer<
  typeof AssembleTaskPlanningContextResultSchema
>;
export type RunBootstrapInvestigationInput = z.infer<typeof RunBootstrapInvestigationInputSchema>;
export type RunBootstrapInvestigationResult = z.infer<typeof RunBootstrapInvestigationResultSchema>;
export type AdmitTaskExecutionInput = z.infer<typeof AdmitTaskExecutionInputSchema>;
export type AdmitTaskExecutionResult = z.infer<typeof AdmitTaskExecutionResultSchema>;
export type BootstrapWorkflowResult = z.infer<typeof BootstrapWorkflowResultSchema>;
export type { FreezeTaskWorkflowInput, WorkflowFreezeReceipt, PlanningSnapshotReference };

export interface BootstrapWorkflowActivities {
  prepareTaskWorkspace(input: PrepareTaskWorkspaceInput): Promise<PrepareTaskWorkspaceResult>;
  assembleTaskPlanningContext(
    input: AssembleTaskPlanningContextInput,
  ): Promise<AssembleTaskPlanningContextResult>;
  planTaskImplementation(input: PlanTaskImplementationInput): Promise<BootstrapPlanningState>;
  runBootstrapInvestigation(
    input: RunBootstrapInvestigationInput,
  ): Promise<RunBootstrapInvestigationResult>;
  admitTaskExecution(input: AdmitTaskExecutionInput): Promise<AdmitTaskExecutionResult>;
  freezeTaskWorkflow(input: FreezeTaskWorkflowInput): Promise<WorkflowFreezeReceipt>;
}
