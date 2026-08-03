import { z } from 'zod';

import {
  CompiledWorkflowSchema,
  JsonValueSchema,
  type CompiledWorkflow,
  type JsonValue,
} from '../workflow/index.js';
import {
  TASK_WORKFLOW_SCHEMA_VERSION,
  TaskWorkflowSettingsSchema,
  type TaskWorkflowSettings,
} from './public-state.js';

export * from './public-state.js';

export const TaskWorkflowInputSchema = z
  .object({
    schemaVersion: z.literal(TASK_WORKFLOW_SCHEMA_VERSION),
    taskReference: z.string().min(1),
    workflowHash: z.string().min(1),
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

export type TaskWorkflowInput = z.infer<typeof TaskWorkflowInputSchema>;
export type TaskWorkflowMemo = z.infer<typeof TaskWorkflowMemoSchema>;
export type ResolveTaskWaitCommand = z.infer<typeof ResolveTaskWaitCommandSchema>;
export type ResolveTaskWaitReceipt = z.infer<typeof ResolveTaskWaitReceiptSchema>;
export type ExecuteTaskStepInput = z.infer<typeof ExecuteTaskStepInputSchema>;
export type ExecuteTaskStepResult = z.infer<typeof ExecuteTaskStepResultSchema>;
export type EvaluatePredicateInput = z.infer<typeof EvaluatePredicateInputSchema>;

export interface TaskWorkflowActivities {
  executeStep(input: ExecuteTaskStepInput): Promise<ExecuteTaskStepResult>;
  evaluatePredicate(input: EvaluatePredicateInput): Promise<boolean>;
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
