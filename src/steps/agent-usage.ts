import { z } from 'zod';

export const AgentApiCostSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('unrated') }).strict(),
  z
    .object({
      source: z.literal('price_table'),
      amountUsd: z.number().nonnegative(),
      pricingVersion: z.string().min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal('provider_reported'),
      amountUsd: z.number().nonnegative(),
    })
    .strict(),
]);

export const AgentInvocationUsageSchema = z
  .object({
    provider: z.enum(['codex', 'claude']),
    profile: z.string().min(1),
    profileSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    model: z.string().min(1),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    serviceTier: z.enum(['fast', 'flex']).nullable(),
    sessionId: z.string().min(1),
    durationMs: z.number().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
    apiCost: AgentApiCostSchema,
  })
  .strict()
  .readonly();

export type AgentInvocationUsage = z.infer<typeof AgentInvocationUsageSchema>;
