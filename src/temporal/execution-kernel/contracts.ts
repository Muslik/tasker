import { z } from 'zod';

import {
  CompiledWorkflowSchema,
  JsonValueSchema,
  StepActivityDeliverySchema,
} from '../../workflow/schema.js';
import { PlanningSnapshotReferenceSchema } from '../../planning/run-planning-snapshot.js';
import { EvidenceBundleReferenceSchema } from '../../planning/evidence-bundle.js';
import { AgentInvocationUsageSchema } from '../../observability/agent-usage.js';

export const EXECUTION_WORKFLOW_SCHEMA_VERSION = 2;

export const ExecutionContextReferenceSchema = z
  .object({
    kind: z.string().min(1),
    reference: z.string().min(1),
    hash: z.string().min(1).optional(),
  })
  .strict()
  .readonly();

export const ExecutionWorkflowInputSchema = z
  .object({
    schemaVersion: z.literal(EXECUTION_WORKFLOW_SCHEMA_VERSION),
    taskReference: z.string().min(1),
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
    graph: CompiledWorkflowSchema,
    retrospectiveEnabled: z.boolean(),
    contextReferences: z.array(ExecutionContextReferenceSchema),
  })
  .strict()
  .readonly();

export const ExecutionNodeStatusSchema = z.enum([
  'planned',
  'running',
  'waiting',
  'succeeded',
  'skipped',
  'failed',
]);

export const ExecutionWaitSchema = z
  .object({
    nodeId: z.string().min(1),
    waitKind: z.string().min(1),
    reason: z.string().min(1).optional(),
  })
  .strict()
  .readonly();

const ExecutionContinuationCandidateObjectSchema = z
  .object({
    continuationId: z.string().min(1),
    attempt: z.number().int().positive(),
    parentNodeId: z.string().min(1),
    requestReference: z.string().min(1),
    reason: z.string().min(1),
    evidenceBundle: EvidenceBundleReferenceSchema,
    transcriptOperationId: z.string().min(1),
    analyzerReceiptReference: z.string().min(1),
    usage: AgentInvocationUsageSchema,
    semanticHash: z.string().regex(/^[a-f0-9]{64}$/u),
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
    graph: CompiledWorkflowSchema,
  })
  .strict();

export const ExecutionContinuationCandidateSchema =
  ExecutionContinuationCandidateObjectSchema.readonly();

const ExecutionContinuationCandidateStateSchema = ExecutionContinuationCandidateObjectSchema.extend(
  {
    status: z.enum(['awaiting_review', 'rejected', 'running', 'completed']),
  },
)
  .strict()
  .readonly();

const ExecutionContinuationPlanningStateSchema = z
  .object({
    continuationId: z.string().min(1),
    attempt: z.number().int().positive(),
    parentNodeId: z.string().min(1),
    requestReference: z.string().min(1),
    reason: z.string().min(1),
    transcriptOperationId: z.string().min(1),
    status: z.enum(['planning', 'needs_input']),
  })
  .strict()
  .readonly();

export const ExecutionContinuationStateSchema = z.union([
  ExecutionContinuationPlanningStateSchema,
  ExecutionContinuationCandidateStateSchema,
]);

const ExecutionWorkflowStateBaseSchema = z
  .object({
    runtime: z.literal('execution'),
    schemaVersion: z.literal(EXECUTION_WORKFLOW_SCHEMA_VERSION),
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    runId: z.string().min(1),
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
    nodeStates: z.record(z.string(), ExecutionNodeStatusSchema),
    blockRuns: z.record(z.string(), z.number().int().nonnegative()),
    loopIterations: z.record(z.string(), z.number().int().nonnegative()),
    continuations: z.array(ExecutionContinuationStateSchema),
    retrospective: z.enum(['disabled', 'pending', 'running', 'succeeded', 'failed']),
  })
  .strict();

export const ExecutionWorkflowPublicStateSchema = z.discriminatedUnion('status', [
  ExecutionWorkflowStateBaseSchema.extend({
    status: z.literal('running'),
    currentNodeId: z.string().min(1).nullable(),
    wait: z.null(),
    outcome: z.null(),
  }).strict(),
  ExecutionWorkflowStateBaseSchema.extend({
    status: z.literal('waiting'),
    currentNodeId: z.string().min(1),
    wait: ExecutionWaitSchema,
    outcome: z.null(),
  }).strict(),
  ExecutionWorkflowStateBaseSchema.extend({
    status: z.literal('completed'),
    currentNodeId: z.null(),
    wait: z.null(),
    outcome: z.string().min(1),
  }).strict(),
]);

export const ResolveExecutionWaitCommandSchema = z
  .object({
    runId: z.string().min(1),
    nodeId: z.string().min(1),
    waitKind: z.string().min(1),
    resolution: JsonValueSchema,
  })
  .strict()
  .readonly();

export const ResolveExecutionWaitReceiptSchema = z
  .object({
    nodeId: z.string().min(1),
    waitKind: z.string().min(1),
    accepted: z.literal(true),
  })
  .strict()
  .readonly();

export const RunExecutionBlockInputSchema = z
  .object({
    schemaVersion: z.literal(EXECUTION_WORKFLOW_SCHEMA_VERSION),
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
    nodeId: z.string().min(1),
    blockRun: z.number().int().positive(),
    uses: z.string().min(1),
    activityDelivery: StepActivityDeliverySchema,
    contextReferences: z.array(ExecutionContextReferenceSchema),
    operatorGuidance: z.string().trim().min(1).max(10_000).nullable(),
    waitResolution: JsonValueSchema.nullable(),
    input: JsonValueSchema,
  })
  .strict()
  .readonly();

const ExecutionBlockResultBaseSchema = z.object({ summary: z.string().min(1) });

export const ExecutionBlockResultSchema = z.discriminatedUnion('status', [
  ExecutionBlockResultBaseSchema.extend({
    status: z.literal('completed'),
    predicateFacts: z.record(z.string(), z.boolean()),
    receiptReference: z.string().min(1),
  })
    .strict()
    .readonly(),
  ExecutionBlockResultBaseSchema.extend({
    status: z.literal('needs_input'),
    waitKind: z.string().min(1),
  })
    .strict()
    .readonly(),
  ExecutionBlockResultBaseSchema.extend({
    status: z.literal('continuation_required'),
    waitKind: z.string().min(1),
    requestReference: z.string().min(1),
    receiptReference: z.string().min(1),
  })
    .strict()
    .readonly(),
]);

export const EvaluateExecutionPredicateInputSchema = z
  .object({
    schemaVersion: z.literal(EXECUTION_WORKFLOW_SCHEMA_VERSION),
    taskReference: z.string().min(1),
    reference: z.string().min(1),
    facts: z.record(z.string(), z.boolean()),
    contextReferences: z.array(ExecutionContextReferenceSchema),
  })
  .strict()
  .readonly();

export const PlanExecutionContinuationInputSchema = z
  .object({
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    parentNodeId: z.string().min(1),
    attempt: z.number().int().positive(),
    requestReference: z.string().min(1),
    planningSnapshot: PlanningSnapshotReferenceSchema,
    guidance: z.string().trim().min(1).max(10_000).nullable(),
  })
  .strict()
  .readonly();

export const PlanExecutionContinuationResultSchema = z.discriminatedUnion('status', [
  ExecutionContinuationCandidateObjectSchema.extend({ status: z.literal('ready') })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal('needs_input'),
      summary: z.string().min(1),
      waitKind: z.string().min(1),
    })
    .strict(),
]);

export const ExecutionWorkflowResultSchema = z
  .object({
    taskReference: z.string().min(1),
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
    outcome: z.string().min(1),
  })
  .strict()
  .readonly();

export const RunExecutionRetrospectiveInputSchema = z
  .object({
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    outcome: z.string().min(1),
  })
  .strict()
  .readonly();

export const RunExecutionRetrospectiveResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), artifactId: z.string().min(1) }).strict(),
  z.object({ status: z.literal('failed'), reason: z.string().min(1) }).strict(),
]);

export type ExecutionContextReference = z.infer<typeof ExecutionContextReferenceSchema>;
export type ExecutionWorkflowInput = z.infer<typeof ExecutionWorkflowInputSchema>;
export type ExecutionNodeStatus = z.infer<typeof ExecutionNodeStatusSchema>;
export type ExecutionWorkflowPublicState = z.infer<typeof ExecutionWorkflowPublicStateSchema>;
export type ResolveExecutionWaitCommand = z.infer<typeof ResolveExecutionWaitCommandSchema>;
export type ResolveExecutionWaitReceipt = z.infer<typeof ResolveExecutionWaitReceiptSchema>;
export type RunExecutionBlockInput = z.infer<typeof RunExecutionBlockInputSchema>;
export type ExecutionBlockResult = z.infer<typeof ExecutionBlockResultSchema>;
export type EvaluateExecutionPredicateInput = z.infer<typeof EvaluateExecutionPredicateInputSchema>;
export type ExecutionContinuationCandidate = z.infer<typeof ExecutionContinuationCandidateSchema>;
export type ExecutionContinuationState = z.infer<typeof ExecutionContinuationStateSchema>;
export type PlanExecutionContinuationInput = z.infer<typeof PlanExecutionContinuationInputSchema>;
export type PlanExecutionContinuationResult = z.infer<typeof PlanExecutionContinuationResultSchema>;
export type ExecutionWorkflowResult = z.infer<typeof ExecutionWorkflowResultSchema>;
export type RunExecutionRetrospectiveInput = z.infer<typeof RunExecutionRetrospectiveInputSchema>;
export type RunExecutionRetrospectiveResult = z.infer<typeof RunExecutionRetrospectiveResultSchema>;

export interface ExecutionWorkflowActivities {
  runExecutionBlock(input: RunExecutionBlockInput): Promise<ExecutionBlockResult>;
  planExecutionContinuation(
    input: PlanExecutionContinuationInput,
  ): Promise<PlanExecutionContinuationResult>;
  evaluateExecutionPredicate(input: EvaluateExecutionPredicateInput): Promise<boolean>;
  runExecutionRetrospective(
    input: RunExecutionRetrospectiveInput,
  ): Promise<RunExecutionRetrospectiveResult>;
}
