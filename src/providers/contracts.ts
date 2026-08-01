import { z } from 'zod';

export const WorkflowAnalyzerReceiptSchema = z
  .object({
    status: z.literal('completed'),
    provider: z.literal('codex_cli'),
    analyzerVersion: z.literal('codex-cli@1'),
    cliVersion: z.string().min(1),
    model: z.string().min(1),
    serviceTier: z.enum(['fast', 'flex']),
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
    hypotheticalApiCostUsd: z.null(),
  })
  .strict();

export type WorkflowAnalyzerReceipt = z.infer<typeof WorkflowAnalyzerReceiptSchema>;
