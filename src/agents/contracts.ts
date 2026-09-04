import { z } from 'zod';

import { PlanningStrategySchema } from '../planning/implementation-plan.js';
import { AgentApiCostSchema } from '../steps/agent-usage.js';

export const WorkflowAnalyzerReceiptSchema = z
  .object({
    status: z.literal('completed'),
    provider: z.enum(['codex_cli', 'claude_cli']),
    analyzerVersion: z.literal('workflow-analyzer@2'),
    profile: z.string().min(1),
    profileSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    cliVersion: z.string().min(1),
    model: z.string().min(1),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    serviceTier: z.enum(['fast', 'flex']).nullable(),
    sessionId: z.string().min(1),
    promptHash: z.string().regex(/^[a-f0-9]{64}$/u),
    durationMs: z.number().nonnegative(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        cachedInputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        reasoningOutputTokens: z.number().int().nonnegative(),
      })
      .strict(),
    apiCost: AgentApiCostSchema,
  })
  .strict();

export type WorkflowAnalyzerReceipt = z.infer<typeof WorkflowAnalyzerReceiptSchema>;

export const ImplementationPlannerReceiptSchema = z
  .object({
    status: z.literal('completed'),
    provider: z.enum(['codex_cli', 'claude_cli']),
    plannerVersion: z.literal('implementation-planner@4'),
    profile: z.string().min(1),
    profileSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    cliVersion: z.string().min(1),
    model: z.string().min(1),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    serviceTier: z.enum(['fast', 'flex']).nullable(),
    strategy: PlanningStrategySchema,
    sessionId: z.string().min(1),
    promptHash: z.string().regex(/^[a-f0-9]{64}$/u),
    durationMs: z.number().nonnegative(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        cachedInputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        reasoningOutputTokens: z.number().int().nonnegative(),
      })
      .strict(),
    apiCost: AgentApiCostSchema,
  })
  .strict();

export type ImplementationPlannerReceipt = z.infer<typeof ImplementationPlannerReceiptSchema>;
