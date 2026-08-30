import { describe, expect, it } from 'vitest';

import { parseSubscriptionCliStream } from './subscription-cli-stream.js';

describe('subscription CLI stream parsing', () => {
  it('normalizes Codex output and usage', () => {
    const stdout = [
      'codex banner',
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify({ status: 'ok' }) },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 15, cached_input_tokens: 4, output_tokens: 6 },
      }),
    ].join('\n');

    const result = parseSubscriptionCliStream('codex', stdout);

    expect(result).toEqual({
      ok: true,
      value: {
        finalMessage: { status: 'ok' },
        sessionId: 'thread-1',
        usage: {
          inputTokens: 15,
          cachedInputTokens: 4,
          outputTokens: 6,
          reasoningOutputTokens: 0,
        },
        reportedCostUsd: null,
        diagnostics: ['codex banner'],
        skippedCount: 1,
      },
    });
  });

  it('preserves null Codex usage when no turn.completed event is emitted', () => {
    const stdout = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: JSON.stringify({ status: 'ok' }) },
    });

    const result = parseSubscriptionCliStream('codex', stdout);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.usage).toBeNull();
  });

  it('normalizes Claude output, usage, cost, and diagnostics', () => {
    const stdout = [
      'claude banner',
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '',
        structured_output: { status: 'ok' },
        session_id: 'session-1',
        usage: {
          input_tokens: 18,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
          output_tokens: 7,
        },
        total_cost_usd: 0.02,
      }),
    ].join('\n');

    const result = parseSubscriptionCliStream('claude', stdout);

    expect(result).toEqual({
      ok: true,
      value: {
        finalMessage: { status: 'ok' },
        sessionId: 'session-1',
        usage: {
          inputTokens: 18,
          cachedInputTokens: 5,
          outputTokens: 7,
          reasoningOutputTokens: 0,
        },
        reportedCostUsd: 0.02,
        diagnostics: ['claude banner'],
        skippedCount: 1,
      },
    });
  });

  it('propagates terminal Codex turn failures', () => {
    const stdout = [
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify({ status: 'partial' }) },
      }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'Provider failed' } }),
    ].join('\n');

    const result = parseSubscriptionCliStream('codex', stdout);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Provider failed');
  });

  it('rejects a non-JSON Codex final message', () => {
    const stdout = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'not JSON' },
    });

    const result = parseSubscriptionCliStream('codex', stdout);

    expect(result).toEqual({
      ok: false,
      error: { kind: 'invalid_event_stream', message: 'Codex final message was not JSON' },
    });
  });
});
