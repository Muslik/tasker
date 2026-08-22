import { z } from 'zod';

import { JsonValueSchema, PredicateReferenceSchema, StepTypeReferenceSchema } from './schema.js';

export const SEMANTIC_WORKFLOW_SCHEMA_VERSION = 1;
export const SEMANTIC_WORKFLOW_IR_VERSION = 'semantic-workflow-v1';
export const SemanticExecutionRoleSchema = z.enum([
  'context',
  'implementation',
  'verification',
  'review',
]);
export type SemanticExecutionRole = z.infer<typeof SemanticExecutionRoleSchema>;

const SemanticNodeIdSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('__tasker_'), 'The __tasker_ prefix is reserved');

export interface SemanticStepSource {
  readonly kind: 'step';
  readonly id: string;
  readonly uses: string;
  readonly with: z.infer<typeof JsonValueSchema>;
}

export interface SemanticSequenceSource {
  readonly kind: 'sequence';
  readonly id: string;
  readonly children: readonly SemanticNodeSource[];
}

export interface SemanticBoundedLoopSource {
  readonly kind: 'bounded_loop';
  readonly id: string;
  readonly maxAttempts: number;
  readonly until: string;
  readonly body: SemanticSequenceSource;
}

export type SemanticNodeSource =
  SemanticBoundedLoopSource | SemanticSequenceSource | SemanticStepSource;

export interface SemanticWorkflowSource {
  readonly schemaVersion: typeof SEMANTIC_WORKFLOW_SCHEMA_VERSION;
  readonly id: string;
  readonly version: number;
  readonly root: SemanticSequenceSource;
}

export const SemanticStepSourceSchema = z
  .object({
    kind: z.literal('step'),
    id: SemanticNodeIdSchema,
    uses: StepTypeReferenceSchema,
    with: JsonValueSchema,
  })
  .strict();

export const SemanticSequenceSourceSchema: z.ZodType<SemanticSequenceSource> = z.lazy(() =>
  z
    .object({
      kind: z.literal('sequence'),
      id: SemanticNodeIdSchema,
      children: z.array(SemanticNodeSourceSchema).min(1),
    })
    .strict(),
);

export const SemanticBoundedLoopSourceSchema: z.ZodType<SemanticBoundedLoopSource> = z.lazy(() =>
  z
    .object({
      kind: z.literal('bounded_loop'),
      id: SemanticNodeIdSchema,
      maxAttempts: z.number().int().positive(),
      until: PredicateReferenceSchema,
      body: SemanticSequenceSourceSchema,
    })
    .strict(),
);

export const SemanticNodeSourceSchema: z.ZodType<SemanticNodeSource> = z.lazy(() =>
  z.union([
    SemanticStepSourceSchema,
    SemanticSequenceSourceSchema,
    SemanticBoundedLoopSourceSchema,
  ]),
);

export const SemanticWorkflowSourceSchema: z.ZodType<SemanticWorkflowSource> = z
  .object({
    schemaVersion: z.literal(SEMANTIC_WORKFLOW_SCHEMA_VERSION),
    id: z.string().min(1),
    version: z.number().int().positive(),
    root: SemanticSequenceSourceSchema,
  })
  .strict();
