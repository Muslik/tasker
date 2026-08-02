import { z } from 'zod';

export const RUN_VIEW_SCHEMA_VERSION = 1;

export const RunNodeStatusSchema = z.enum([
  'planned',
  'running',
  'waiting',
  'succeeded',
  'skipped',
  'failed',
]);

export const RunOperationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('step'),
      nodeId: z.string().min(1),
      uses: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('wait'),
      nodeId: z.string().min(1),
      waitKind: z.string().min(1),
      slotPolicy: z.enum(['release', 'retain']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('gate'),
      nodeId: z.string().min(1),
      waitKind: z.string().min(1),
      slotPolicy: z.literal('release'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('finalize'),
      nodeId: z.string().min(1),
      outcome: z.string().min(1),
    })
    .strict(),
]);

export const RunWaitSchema = z
  .object({
    waitId: z.string().min(1),
    nodeId: z.string().min(1),
    waitKind: z.string().min(1),
    slotPolicy: z.enum(['release', 'retain']),
    openedAt: z.iso.datetime(),
  })
  .strict();

export const StubEffectReceiptSchema = z
  .object({
    effectKey: z.string().min(1),
    nodeId: z.string().min(1),
    uses: z.string().min(1),
    receiptId: z.string().min(1),
    completedAt: z.iso.datetime(),
  })
  .strict();

export const PlanReviewCommandSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }).strict(),
  z
    .object({
      decision: z.literal('request_changes'),
      guidance: z.string().trim().min(1).max(10_000),
    })
    .strict(),
]);

export const PlanRevisionRequestSchema = z
  .object({
    interventionId: z.string().min(1),
    reviewNodeId: z.string().min(1),
    targetNodeId: z.string().min(1),
    priorAttempt: z.number().int().positive(),
    nextAttempt: z.number().int().positive(),
    guidanceArtifactId: z.string().min(1),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const RunLeaseSchema = z
  .object({
    leaseKey: z.string().min(1),
    ownerId: z.string().min(1),
    fenceToken: z.number().int().positive(),
  })
  .strict();

const runBaseShape = {
  schemaVersion: z.literal(RUN_VIEW_SCHEMA_VERSION),
  runId: z.string().min(1),
  taskReference: z.string().min(1),
  taskId: z.string().min(1),
  workflowId: z.string().min(1),
  workflowHash: z.string().min(1),
  queuedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  cursor: z.number().int().nonnegative(),
  plan: z.array(RunOperationSchema).min(1),
  nodeStates: z.record(z.string(), RunNodeStatusSchema),
  effects: z.array(StubEffectReceiptSchema),
  planRevisionRequests: z.array(PlanRevisionRequestSchema).default([]),
};

export const RunProjectionSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...runBaseShape,
      status: z.literal('queued'),
      startedAt: z.iso.datetime().nullable(),
      completedAt: z.null(),
      lease: z.null(),
      wait: z.null(),
    })
    .strict(),
  z
    .object({
      ...runBaseShape,
      status: z.literal('executing'),
      startedAt: z.iso.datetime(),
      completedAt: z.null(),
      lease: RunLeaseSchema,
      wait: z.null(),
    })
    .strict(),
  z
    .object({
      ...runBaseShape,
      status: z.literal('waiting'),
      startedAt: z.iso.datetime(),
      completedAt: z.null(),
      lease: z.null(),
      wait: RunWaitSchema,
    })
    .strict(),
  z
    .object({
      ...runBaseShape,
      status: z.literal('completed'),
      startedAt: z.iso.datetime(),
      completedAt: z.iso.datetime(),
      lease: z.null(),
      wait: z.null(),
    })
    .strict(),
]);

export type RunNodeStatus = z.infer<typeof RunNodeStatusSchema>;
export type RunOperation = z.infer<typeof RunOperationSchema>;
export type RunProjection = z.infer<typeof RunProjectionSchema>;
export type ExecutingRunProjection = Extract<RunProjection, { readonly status: 'executing' }>;
export type PlanReviewCommand = z.infer<typeof PlanReviewCommandSchema>;
