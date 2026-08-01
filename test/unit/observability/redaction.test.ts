import { describe, expect, it } from 'vitest';

import { redactSourceValue } from '../../../src/observability/redaction.js';

describe('redactSourceValue', () => {
  it('redacts nested values by exact key, key pattern, and value pattern', () => {
    const result = redactSourceValue(
      {
        headers: {
          authorization: 'Bearer top-secret-token',
        },
        steps: [
          {
            message: 'safe',
            clientSecret: 'shh',
          },
          {
            note: 'password=ultra-secret',
            tokens: ['visible', 'sk_live_12345'],
          },
        ],
      },
      {
        exactKeys: ['authorization'],
        keyPatterns: [/secret$/iu],
        valuePatterns: [/password=\S+/u, /sk_live_[A-Za-z0-9]+/u],
      },
    );

    expect(result.status).toBe('redacted');
    if (result.status !== 'redacted') {
      throw new Error('Expected redacted result');
    }

    expect(result.value).toEqual({
      headers: {
        authorization: '[REDACTED]',
      },
      steps: [
        {
          message: 'safe',
          clientSecret: '[REDACTED]',
        },
        {
          note: '[REDACTED]',
          tokens: ['visible', '[REDACTED]'],
        },
      ],
    });
    expect(result.summary).toEqual({
      status: 'redacted',
      redactedCount: 4,
      blockedCount: 0,
      redactions: [
        { path: '$.headers.authorization', reason: 'exact_key' },
        { path: '$.steps[0].clientSecret', reason: 'key_pattern' },
        { path: '$.steps[1].note', reason: 'value_pattern' },
        { path: '$.steps[1].tokens[1]', reason: 'value_pattern' },
      ],
      blocked: [],
    });

    const diagnosticText = JSON.stringify(result);
    expect(diagnosticText).not.toContain('top-secret-token');
    expect(diagnosticText).not.toContain('ultra-secret');
    expect(diagnosticText).not.toContain('sk_live_12345');
    expect(diagnosticText).not.toContain('shh');
  });

  it('blocks unsupported payloads without exposing raw values in diagnostics', () => {
    const result = redactSourceValue(
      {
        secretBundle: {
          issuedAt: new Date('2026-07-31T12:30:00.000Z'),
        },
      },
      {
        keyPatterns: [/secret/iu],
      },
    );

    expect(result).toEqual({
      status: 'blocked',
      summary: {
        status: 'blocked',
        redactedCount: 0,
        blockedCount: 1,
        redactions: [],
        blocked: [
          {
            path: '$.secretBundle.issuedAt',
            reason: 'unsupported_type',
            detail: '[object Date]',
          },
        ],
      },
    });

    const diagnosticText = JSON.stringify(result);
    expect(diagnosticText).not.toContain('2026-07-31T12:30:00.000Z');
    expect('value' in result).toBe(false);
  });

  it('blocks sparse arrays as non-json values', () => {
    const values = new Array<string>(2);
    values[0] = 'visible';

    const result = redactSourceValue({ values });

    expect(result).toEqual({
      status: 'blocked',
      summary: {
        status: 'blocked',
        redactedCount: 0,
        blockedCount: 1,
        redactions: [],
        blocked: [
          {
            path: '$.values[1]',
            reason: 'array_hole',
            detail: 'Sparse arrays are not valid JSON-like values',
          },
        ],
      },
    });
  });

  it('blocks accessor properties without invoking them', () => {
    let getterCalls = 0;
    const payload = Object.defineProperty({}, 'credential', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'must-not-be-read';
      },
    });

    const result = redactSourceValue(payload, { exactKeys: ['credential'] });

    expect(result).toEqual({
      status: 'blocked',
      summary: {
        status: 'blocked',
        redactedCount: 0,
        blockedCount: 1,
        redactions: [],
        blocked: [
          {
            path: '$.credential',
            reason: 'accessor_property',
            detail: 'Accessor properties cannot be inspected without executing code',
          },
        ],
      },
    });
    expect(getterCalls).toBe(0);
  });
});
