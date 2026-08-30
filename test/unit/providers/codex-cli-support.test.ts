import { describe, expect, it } from 'vitest';

import { providerFailureMessage } from '../../../src/providers/codex-cli-support.js';

describe('Codex CLI support', () => {
  it('unwraps the actionable provider error from a failed JSONL turn', () => {
    const providerError = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'invalid_json_schema',
        message: "Invalid response schema: 'propertyNames' is not permitted.",
      },
      status: 400,
    };
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'error', message: JSON.stringify(providerError) }),
      JSON.stringify({
        type: 'turn.failed',
        error: { message: JSON.stringify(providerError) },
      }),
    ].join('\n');

    expect(providerFailureMessage(stdout)).toBe(
      "Invalid response schema: 'propertyNames' is not permitted.",
    );
  });

  it('surfaces stderr when the provider exits before emitting JSONL', () => {
    expect(providerFailureMessage('', 'No prompt provided via stdin.\n')).toBe(
      'No prompt provided via stdin.',
    );
  });

  it('surfaces plain-text stdout when the provider exits without a structured error', () => {
    expect(
      providerFailureMessage('provider startup failed\nfatal: model access denied\n'),
    ).toContain('fatal: model access denied');
  });

  it('retains the tail of long plain-text stdout within the failure reason limit', () => {
    const message = providerFailureMessage(`${'x'.repeat(4_500)}actionable stdout tail`);
    expect(message).toHaveLength(4_000);
    expect(message).toMatch(/^\.\.\./u);
    expect(message).toMatch(/actionable stdout tail$/u);
  });

  it('retains the tail of long stderr within the failure reason limit', () => {
    const message = providerFailureMessage('', `${'x'.repeat(4_500)}actionable stderr tail`);
    expect(message).toHaveLength(4_000);
    expect(message).toMatch(/^\.\.\./u);
    expect(message).toMatch(/actionable stderr tail$/u);
  });
});
