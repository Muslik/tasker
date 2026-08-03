import { z } from 'zod';

import {
  CompiledWorkflowSchema,
  JsonValueSchema,
  type CompiledWorkflow,
  type JsonValue,
} from '../workflow/index.js';
import {
  TASK_WORKFLOW_SCHEMA_VERSION,
  TaskWorkflowPlanningStateSchema,
  TaskWorkflowSettingsSchema,
  type TaskWorkflowPlanningState,
  type TaskWorkflowSettings,
} from './public-state.js';
import {
  PlanningQuestionAnswerSchema,
  PlanningStrategyRequestSchema,
} from '../planning/implementation-plan.js';
import {
  PlanningSnapshotReferenceSchema,
  type PlanningSnapshotReference,
} from '../planning/run-planning-snapshot.js';

export * from './public-state.js';

export const TaskWorkflowInputSchema = z
  .object({
    schemaVersion: z.literal(TASK_WORKFLOW_SCHEMA_VERSION),
    taskReference: z.string().min(1),
    workflowHash: z.string().min(1),
    planningSnapshot: PlanningSnapshotReferenceSchema,
    graph: CompiledWorkflowSchema,
    settings: TaskWorkflowSettingsSchema,
  })
  .strict()
  .readonly();

export const TaskWorkflowMemoSchema = z
  .object({
    schemaVersion: z.literal(TASK_WORKFLOW_SCHEMA_VERSION),
    taskReference: z.string().min(1),
    workflowHash: z.string().min(1),
    settings: TaskWorkflowSettingsSchema,
  })
  .strict()
  .readonly();

export const ResolveTaskWaitCommandSchema = z
  .object({
    nodeId: z.string().min(1),
    waitKind: z.string().min(1),
    resolution: JsonValueSchema,
  })
  .strict()
  .readonly();

export const ResolveTaskWaitReceiptSchema = z
  .object({
    nodeId: z.string().min(1),
    waitKind: z.string().min(1),
    accepted: z.literal(true),
  })
  .strict()
  .readonly();

export const ExecuteTaskStepInputSchema = z
  .object({
    taskReference: z.string().min(1),
    nodeId: z.string().min(1),
    uses: z.string().min(1),
    input: JsonValueSchema,
  })
  .strict()
  .readonly();

export const ExecuteTaskStepResultSchema = z
  .object({
    summary: z.string().min(1),
    predicateResults: z.record(z.string(), z.boolean()),
    artifactIds: z.array(z.string().min(1)),
  })
  .strict()
  .readonly();

export const EvaluatePredicateInputSchema = z
  .object({
    taskReference: z.string().min(1),
    reference: z.string().min(1),
    facts: z.record(z.string(), z.boolean()),
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
    workflowHash: z.string().min(1),
    planningSnapshot: PlanningSnapshotReferenceSchema,
    nodeId: z.string().min(1),
    commandId: z.string().min(1),
    requestedStrategy: PlanningStrategyRequestSchema,
    command: PlanningActivityCommandSchema,
  })
  .strict()
  .readonly();

export const PlanTaskImplementationResultSchema = TaskWorkflowPlanningStateSchema;

export type TaskWorkflowInput = z.infer<typeof TaskWorkflowInputSchema>;
export type TaskWorkflowMemo = z.infer<typeof TaskWorkflowMemoSchema>;
export type ResolveTaskWaitCommand = z.infer<typeof ResolveTaskWaitCommandSchema>;
export type ResolveTaskWaitReceipt = z.infer<typeof ResolveTaskWaitReceiptSchema>;
export type ExecuteTaskStepInput = z.infer<typeof ExecuteTaskStepInputSchema>;
export type ExecuteTaskStepResult = z.infer<typeof ExecuteTaskStepResultSchema>;
export type EvaluatePredicateInput = z.infer<typeof EvaluatePredicateInputSchema>;
export type PlanningActivityCommand = z.infer<typeof PlanningActivityCommandSchema>;
export type PlanTaskImplementationInput = z.infer<typeof PlanTaskImplementationInputSchema>;
export type { PlanningSnapshotReference };

export interface TaskWorkflowActivities {
  executeStep(input: ExecuteTaskStepInput): Promise<ExecuteTaskStepResult>;
  evaluatePredicate(input: EvaluatePredicateInput): Promise<boolean>;
  planTaskImplementation(input: PlanTaskImplementationInput): Promise<TaskWorkflowPlanningState>;
}

export interface TaskWorkflowResult {
  readonly taskReference: string;
  readonly workflowHash: string;
  readonly outcome: string;
}

export interface StartTaskWorkflowInput {
  readonly taskReference: string;
  readonly workflowHash: string;
  readonly graph: CompiledWorkflow;
  readonly settings: TaskWorkflowSettings;
}

export type TaskWaitResolution = JsonValue;
