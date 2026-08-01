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

export const RunProjectionSchema = z
  .object({
    schemaVersion: z.literal(RUN_VIEW_SCHEMA_VERSION),
    runId: z.string().min(1),
    taskReference: z.string().min(1),
    taskId: z.string().min(1),
    workflowId: z.string().min(1),
    workflowHash: z.string().min(1),
    status: z.enum(['executing', 'waiting', 'completed']),
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    cursor: z.number().int().nonnegative(),
    plan: z.array(RunOperationSchema).min(1),
    nodeStates: z.record(z.string(), RunNodeStatusSchema),
    effects: z.array(StubEffectReceiptSchema),
    wait: RunWaitSchema.nullable(),
  })
  .strict();

export type RunNodeStatus = z.infer<typeof RunNodeStatusSchema>;
export type RunOperation = z.infer<typeof RunOperationSchema>;
export type RunProjection = z.infer<typeof RunProjectionSchema>;
