import type { ResolvedExecutionProfile } from '../harness/execution-profile-contracts.js';
import { AgentApiCostSchema, type AgentInvocationUsage } from './agent-usage.js';

type TokenUsage = Pick<AgentInvocationUsage, 'inputTokens' | 'cachedInputTokens' | 'outputTokens'>;

export const estimateApiCost = (
  profile: ResolvedExecutionProfile,
  usage: TokenUsage,
  providerReportedUsd: number | null,
) => {
  if (profile.apiPricing === null) {
    return AgentApiCostSchema.parse(
      providerReportedUsd === null
        ? { source: 'unrated' }
        : { source: 'provider_reported', amountUsd: providerReportedUsd },
    );
  }
  const uncachedInputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const longContext = profile.apiPricing.longContext;
  const hasLongContextPricing =
    longContext !== undefined && usage.inputTokens > longContext.thresholdTokens;
  const inputMultiplier = hasLongContextPricing ? longContext.inputMultiplier : 1;
  const outputMultiplier = hasLongContextPricing ? longContext.outputMultiplier : 1;
  const amountUsd =
    ((uncachedInputTokens * profile.apiPricing.inputPerMillionUsd +
      usage.cachedInputTokens * profile.apiPricing.cachedInputPerMillionUsd) *
      inputMultiplier +
      usage.outputTokens * profile.apiPricing.outputPerMillionUsd * outputMultiplier) /
    1_000_000;
  return AgentApiCostSchema.parse({
    source: 'price_table',
    amountUsd,
    pricingVersion: profile.apiPricing.version,
  });
};
