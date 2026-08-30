import { describe, expect, it } from 'vitest';

import {
  acceptsAnyProcessExit,
  evaluateBlockCompletion,
  type AgentClaim,
} from '../../src/blocks/index.js';
import { OutputPredicateMappingSchema } from '../../src/workflow/index.js';

const claim: AgentClaim = {
  status: 'candidate_complete',
  summary: 'Implementation is ready',
  output: {},
  evidenceReferences: [],
};

describe('block completion', () => {
  it('does not allow an agent to self-certify an implementation', () => {
    expect(evaluateBlockCompletion({ kind: 'workspace_mutation' }, claim, [])).toEqual({
      status: 'rejected',
      reasons: ['No workspace mutation was proven'],
    });
  });

  it('accepts completion only after every composed obligation has evidence', () => {
    const evaluator = {
      kind: 'all' as const,
      evaluators: [
        { kind: 'workspace_mutation' as const },
        {
          kind: 'structured_evidence' as const,
          source: 'workspace_files' as const,
          requiredArtifactKinds: ['source-diff'],
        },
      ],
    };
    const mutation = {
      kind: 'workspace_mutation' as const,
      reference: 'mutation:1',
      changed: true,
      fingerprint: 'abc',
    };
    expect(evaluateBlockCompletion(evaluator, claim, [mutation])).toEqual({
      status: 'rejected',
      reasons: ['Missing artifact evidence: source-diff'],
    });
    expect(
      evaluateBlockCompletion(evaluator, claim, [
        mutation,
        {
          kind: 'artifact',
          reference: 'artifact:source-diff:1',
          artifactKind: 'source-diff',
          contentHash: 'def',
        },
      ]),
    ).toEqual({
      status: 'accepted',
      evidenceReferences: ['mutation:1', 'artifact:source-diff:1'],
    });
  });

  it('keeps questions distinct from failed completion evidence', () => {
    expect(
      evaluateBlockCompletion(
        { kind: 'workspace_mutation' },
        {
          status: 'needs_input',
          summary: 'The expected product behavior is ambiguous',
          waitKind: 'implement.change@1.input-required@1',
          questions: [
            {
              id: 'expected-behavior',
              prompt: 'Which behavior is expected?',
              whyBlocking: 'Both implementations are valid and user-visible',
            },
          ],
        },
        [],
      ),
    ).toEqual({
      status: 'waiting',
      waitKind: 'implement.change@1.input-required@1',
      summary: 'The expected product behavior is ambiguous',
    });
  });

  it('records a wait instead of a rejection when a block waits on the world', () => {
    expect(
      evaluateBlockCompletion(
        { kind: 'reconciled_effect' },
        {
          status: 'blocked',
          summary: 'Pull request 495 passed CI and is waiting for human review',
          waitKind: 'code_review@1',
          category: 'unknown_outcome',
          retryable: true,
        },
        [],
      ),
    ).toEqual({
      status: 'waiting',
      waitKind: 'code_review@1',
      summary: 'Pull request 495 passed CI and is waiting for human review',
    });
  });

  it('rejects a claim that neither completes nor waits', () => {
    expect(
      evaluateBlockCompletion(
        { kind: 'workspace_mutation' },
        { status: 'failed', summary: 'The provider crashed', category: 'provider' },
        [],
      ),
    ).toEqual({
      status: 'rejected',
      reasons: ['Agent claim failed is not a completion claim'],
    });
  });

  it('recognizes diagnostic process completion inside a composed evaluator', () => {
    expect(
      acceptsAnyProcessExit({
        kind: 'all',
        evaluators: [
          { kind: 'process_receipt', acceptance: 'any_exit' },
          {
            kind: 'structured_evidence',
            source: 'task_output',
            requiredArtifactKinds: ['validation-report'],
          },
        ],
      }),
    ).toBe(true);
    expect(acceptsAnyProcessExit({ kind: 'process_receipt', acceptance: 'zero' })).toBe(false);
  });

  it('rejects an output predicate mapping that cannot produce a fact', () => {
    expect(
      OutputPredicateMappingSchema.safeParse({ discriminator: 'decision', cases: {} }).success,
    ).toBe(false);
  });
});
