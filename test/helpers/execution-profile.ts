import { ResolvedExecutionProfileSchema } from '../../src/harness/index.js';

export const TEST_CODEX_PROFILE = ResolvedExecutionProfileSchema.parse({
  name: 'test-codex',
  provider: 'codex',
  command: 'codex',
  model: 'gpt-5.6-terra',
  effort: 'medium',
  timeoutMs: 600_000,
  serviceTier: 'fast',
  apiPricing: null,
  configurationSha256: 'e'.repeat(64),
});

export const TEST_CLAUDE_PROFILE = ResolvedExecutionProfileSchema.parse({
  name: 'test-claude',
  provider: 'claude',
  command: 'claude',
  model: 'sonnet',
  effort: 'high',
  timeoutMs: 600_000,
  apiPricing: null,
  configurationSha256: 'f'.repeat(64),
});
