import { z } from 'zod';

export const TASK_WORKFLOW_SCHEMA_VERSION = 1;
export const TASKER_TEMPORAL_TASK_QUEUE = 'tasker-local';

export const TaskWorkflowSettingsSchema = z
  .object({
    planApproval: z.enum(['required', 'automatic']),
  })
  .strict()
  .readonly();

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
export type TemporalNodeStatus = z.infer<typeof TemporalNodeStatusSchema>;
export type TaskWorkflowWait = z.infer<typeof TaskWorkflowWaitSchema>;
export type TaskWorkflowPublicState = z.infer<typeof TaskWorkflowPublicStateSchema>;
