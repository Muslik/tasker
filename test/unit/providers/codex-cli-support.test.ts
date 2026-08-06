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
});
