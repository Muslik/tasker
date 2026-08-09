import { describe, expect, it } from 'vitest';

import { evaluateBlockCompletion, type AgentClaim } from '../../src/blocks/index.js';

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
        { kind: 'structured_evidence' as const, requiredArtifactKinds: ['source-diff'] },
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
      status: 'rejected',
      reasons: ['Agent claim needs_input is not a completion claim'],
    });
  });
});
