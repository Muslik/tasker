import { z } from 'zod';
import { SemanticExecutionRoleSchema } from '../graph/semantic-schema.js';

export const ExecutionProfileNameSchema = z.string().regex(/^[a-z][a-z0-9-]*$/u);
export const TaskExecutionStrategySchema = z.enum(['simple', 'standard', 'complex']);
export const TaskExecutionRoleSchema = SemanticExecutionRoleSchema;

const TaskExecutionStrategyRouteSchema = z
  .object({
    context: ExecutionProfileNameSchema,
    implementation: ExecutionProfileNameSchema,
    verification: ExecutionProfileNameSchema,
    review: ExecutionProfileNameSchema,
  })
  .strict();

export const AgentEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

const ApiModelPricingShape = {
  inputPerMillionUsd: z.number().nonnegative(),
  cachedInputPerMillionUsd: z.number().nonnegative(),
  outputPerMillionUsd: z.number().nonnegative(),
  longContext: z
    .object({
      thresholdTokens: z.number().int().positive(),
      inputMultiplier: z.number().positive(),
      outputMultiplier: z.number().positive(),
    })
    .strict()
    .optional(),
};

const ApiModelPricingSchema = z.object(ApiModelPricingShape).strict().readonly();

export const ApiPricingTableSchema = z
  .object({
    version: z.string().trim().min(1),
    sourceUrls: z.array(z.url()).min(1),
    models: z.record(z.string().trim().min(1), ApiModelPricingSchema),
  })
  .strict()
  .readonly();

const ResolvedApiPricingSchema = z
  .object({
    ...ApiModelPricingShape,
    version: z.string().trim().min(1),
  })
  .strict()
  .readonly();

const ExecutionProfileBaseSchema = {
  command: z.string().trim().min(1),
  model: z.string().trim().min(1),
  effort: AgentEffortSchema,
  timeoutMs: z.number().int().positive(),
};

export const ExecutionProfileSchema = z.discriminatedUnion('provider', [
  z
    .object({
      provider: z.literal('codex'),
      ...ExecutionProfileBaseSchema,
      serviceTier: z.enum(['fast', 'flex']),
    })
    .strict()
    .readonly(),
  z
    .object({
      provider: z.literal('claude'),
      ...ExecutionProfileBaseSchema,
    })
    .strict()
    .readonly(),
]);

export const ResolvedExecutionProfileSchema = z.discriminatedUnion('provider', [
  z
    .object({
      name: ExecutionProfileNameSchema,
      provider: z.literal('codex'),
      command: z.string().trim().min(1),
      model: z.string().trim().min(1),
      effort: AgentEffortSchema,
      timeoutMs: z.number().int().positive(),
      serviceTier: z.enum(['fast', 'flex']),
      apiPricing: ResolvedApiPricingSchema.nullable(),
      configurationSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict()
    .readonly(),
  z
    .object({
      name: ExecutionProfileNameSchema,
      provider: z.literal('claude'),
      command: z.string().trim().min(1),
      model: z.string().trim().min(1),
      effort: AgentEffortSchema,
      timeoutMs: z.number().int().positive(),
      apiPricing: ResolvedApiPricingSchema.nullable(),
      configurationSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict()
    .readonly(),
]);

export const ExecutionProfileRoutingSchema = z
  .object({
    workflowAnalyzer: ExecutionProfileNameSchema,
    implementationPlanner: z
      .object({
        fast: ExecutionProfileNameSchema,
        ralplan: ExecutionProfileNameSchema,
      })
      .strict(),
    taskStrategies: z
      .object({
        simple: TaskExecutionStrategyRouteSchema,
        standard: TaskExecutionStrategyRouteSchema,
        complex: TaskExecutionStrategyRouteSchema,
      })
      .strict(),
  })
  .strict()
  .readonly();

export const ProjectExecutionProfileOverridesSchema = z
  .object({
    workflowAnalyzer: ExecutionProfileNameSchema.optional(),
    implementationPlanner: z
      .object({
        fast: ExecutionProfileNameSchema.optional(),
        ralplan: ExecutionProfileNameSchema.optional(),
      })
      .strict()
      .optional(),
    agents: z.record(ExecutionProfileNameSchema, ExecutionProfileNameSchema).optional(),
    taskStrategies: z
      .partialRecord(
        TaskExecutionStrategySchema,
        z
          .object({
            context: ExecutionProfileNameSchema.optional(),
            implementation: ExecutionProfileNameSchema.optional(),
            verification: ExecutionProfileNameSchema.optional(),
            review: ExecutionProfileNameSchema.optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .readonly();

export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;
export type ApiPricingTable = z.infer<typeof ApiPricingTableSchema>;
export type ResolvedExecutionProfile = z.infer<typeof ResolvedExecutionProfileSchema>;
export type ExecutionProfileRouting = z.infer<typeof ExecutionProfileRoutingSchema>;
export type TaskExecutionStrategy = z.infer<typeof TaskExecutionStrategySchema>;
export type TaskExecutionRole = z.infer<typeof TaskExecutionRoleSchema>;
export type ProjectExecutionProfileOverrides = z.infer<
  typeof ProjectExecutionProfileOverridesSchema
>;
