import { err, ok, type Outcome } from '../shared/outcome.js';
import type { AgentProvider } from './agent-skills.js';
import { parseClaudeStream } from './claude-cli-support.js';
import { parseCodexStream } from './codex-cli-support.js';

export interface SubscriptionCliStreamResult {
  readonly finalMessage: unknown;
  readonly sessionId: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
    readonly reasoningOutputTokens: number;
  } | null;
  readonly reportedCostUsd: number | null;
  readonly diagnostics: readonly string[];
}

export const parseSubscriptionCliStream = (
  provider: AgentProvider,
  stdout: string,
): Outcome<
  SubscriptionCliStreamResult,
  { readonly kind: 'invalid_event_stream'; readonly message: string }
> => {
  if (provider === 'claude') return parseClaudeStream(stdout);
  const parsed = parseCodexStream(stdout);
  if (!parsed.ok) return parsed;
  let finalMessage: unknown;
  try {
    finalMessage = JSON.parse(parsed.value.finalMessage) as unknown;
  } catch {
    return err({ kind: 'invalid_event_stream', message: 'Codex final message was not JSON' });
  }
  return ok({
    finalMessage,
    sessionId: parsed.value.sessionId,
    usage:
      parsed.value.usage === null
        ? null
        : {
            inputTokens: parsed.value.usage.input_tokens,
            cachedInputTokens: parsed.value.usage.cached_input_tokens,
            outputTokens: parsed.value.usage.output_tokens,
            reasoningOutputTokens: parsed.value.usage.reasoning_output_tokens ?? 0,
          },
    reportedCostUsd: null,
    diagnostics: parsed.value.diagnostics,
  });
};
