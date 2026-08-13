import { z } from 'zod';

import {
  CompiledWorkflowSchema,
  JsonValueSchema,
  StepActivityDeliverySchema,
} from '../../workflow/schema.js';

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

export const ExecutionWorkflowResultSchema = z
  .object({
    taskReference: z.string().min(1),
    workflowHash: z.string().regex(/^[a-f0-9]{64}$/u),
    outcome: z.string().min(1),
  })
  .strict()
  .readonly();

export type ExecutionContextReference = z.infer<typeof ExecutionContextReferenceSchema>;
export type ExecutionWorkflowInput = z.infer<typeof ExecutionWorkflowInputSchema>;
export type ExecutionNodeStatus = z.infer<typeof ExecutionNodeStatusSchema>;
export type ExecutionWorkflowPublicState = z.infer<typeof ExecutionWorkflowPublicStateSchema>;
export type ResolveExecutionWaitCommand = z.infer<typeof ResolveExecutionWaitCommandSchema>;
export type ResolveExecutionWaitReceipt = z.infer<typeof ResolveExecutionWaitReceiptSchema>;
export type RunExecutionBlockInput = z.infer<typeof RunExecutionBlockInputSchema>;
export type ExecutionBlockResult = z.infer<typeof ExecutionBlockResultSchema>;
export type EvaluateExecutionPredicateInput = z.infer<typeof EvaluateExecutionPredicateInputSchema>;
export type ExecutionWorkflowResult = z.infer<typeof ExecutionWorkflowResultSchema>;

export interface ExecutionWorkflowActivities {
  runExecutionBlock(input: RunExecutionBlockInput): Promise<ExecutionBlockResult>;
  evaluateExecutionPredicate(input: EvaluateExecutionPredicateInput): Promise<boolean>;
}
