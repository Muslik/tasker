import { z } from 'zod';

export const ExecutionProfileNameSchema = z.string().regex(/^[a-z][a-z0-9-]*$/u);

export const AgentEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

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
  })
  .strict()
  .readonly();

export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;
export type ResolvedExecutionProfile = z.infer<typeof ResolvedExecutionProfileSchema>;
export type ExecutionProfileRouting = z.infer<typeof ExecutionProfileRoutingSchema>;
export type ProjectExecutionProfileOverrides = z.infer<
  typeof ProjectExecutionProfileOverridesSchema
>;
