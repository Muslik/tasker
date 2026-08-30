import { describe, expect, it } from 'vitest';

import { agentReviewOutputSchema } from '../../../src/harness/step-contracts.js';
import {
  codexOutputJsonSchema,
  normalizeCodexStructuredOutput,
  providerFailureMessage,
} from '../../../src/providers/codex-cli-support.js';
import { agentStepOutcomeSchema } from '../../../src/temporal/activities/block-execution-contracts.js';

const objectRequirementIssues = (value: unknown, path = '$'): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) =>
      objectRequirementIssues(child, `${path}[${String(index)}]`),
    );
  }
  if (value === null || typeof value !== 'object') return [];
  const record = value as Readonly<Record<string, unknown>>;
  const issues: string[] = [];
  if (
    record.type === 'object' &&
    record.properties !== null &&
    typeof record.properties === 'object'
  ) {
    const properties = Object.keys(record.properties);
    const required = Array.isArray(record.required) ? record.required : [];
    if (JSON.stringify(required) !== JSON.stringify(properties)) {
      issues.push(`${path} does not require every declared property`);
    }
    if (record.additionalProperties !== false) {
      issues.push(`${path} allows additional properties`);
    }
  }
  return [
    ...issues,
    ...Object.entries(record).flatMap(([key, child]) =>
      objectRequirementIssues(child, `${path}.${key}`),
    ),
  ];
};

describe('Codex CLI support', () => {
  it('adapts the nested agent outcome union to a strict Codex output schema', () => {
    const outcomeSchema = agentStepOutcomeSchema(agentReviewOutputSchema);

    const schema = codexOutputJsonSchema(outcomeSchema);
    const serialized = JSON.stringify(schema);

    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        status: {
          enum: ['completed', 'waiting', 'failed', 'workflow_change'],
        },
      },
      additionalProperties: false,
    });
    expect(schema).not.toHaveProperty('anyOf');
    expect(serialized).not.toContain('"oneOf"');
    expect(serialized).not.toContain('"propertyNames"');
    expect(serialized).not.toContain('"not"');
    expect(objectRequirementIssues(schema)).toEqual([]);
  });

  it('normalizes Codex null placeholders back to the canonical outcome union', () => {
    const outcomeSchema = agentStepOutcomeSchema(agentReviewOutputSchema);

    const normalized = normalizeCodexStructuredOutput(
      {
        status: 'waiting',
        output: null,
        waitKind: 'dependency.available@1',
        reason: 'The dependency has not been published',
        resumeHint: null,
        category: 'dependency',
        retryable: false,
        detail: null,
        request: null,
      },
      outcomeSchema,
    );

    expect(normalized).toEqual({
      status: 'waiting',
      waitKind: 'dependency.available@1',
      reason: 'The dependency has not been published',
      category: 'dependency',
      retryable: false,
    });
    expect(outcomeSchema.safeParse(normalized).success).toBe(true);
  });

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
