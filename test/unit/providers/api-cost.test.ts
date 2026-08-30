import { describe, expect, it } from 'vitest';

import { ResolvedExecutionProfileSchema } from '../../../src/harness/index.js';
import { estimateApiCost } from '../../../src/providers/api-cost.js';

const profile = ResolvedExecutionProfileSchema.parse({
  name: 'priced',
  provider: 'codex',
  command: 'codex',
  model: 'gpt-5.6-terra',
  effort: 'medium',
  timeoutMs: 60_000,
  serviceTier: 'fast',
  apiPricing: {
    version: 'test-v1',
    inputPerMillionUsd: 2,
    cachedInputPerMillionUsd: 0.2,
    outputPerMillionUsd: 12,
    longContext: {
      thresholdTokens: 272_000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
    },
  },
  configurationSha256: 'a'.repeat(64),
});

describe('API-equivalent cost estimation', () => {
  it('prices cached input separately and records the table version', () => {
    expect(
      estimateApiCost(
        profile,
        { inputTokens: 100_000, cachedInputTokens: 40_000, outputTokens: 10_000 },
        null,
      ),
    ).toEqual({ source: 'price_table', amountUsd: 0.248, pricingVersion: 'test-v1' });
  });

  it('applies the declared long-context multipliers to the complete invocation', () => {
    expect(
      estimateApiCost(
        profile,
        { inputTokens: 300_000, cachedInputTokens: 0, outputTokens: 20_000 },
        null,
      ),
    ).toEqual({ source: 'price_table', amountUsd: 1.56, pricingVersion: 'test-v1' });
  });

  it('returns unrated when priced usage is unavailable and the provider reports no usd value', () => {
    expect(estimateApiCost(profile, null, null)).toEqual({ source: 'unrated' });
  });
});
