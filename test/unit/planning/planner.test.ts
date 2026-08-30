import { describe, expect, it } from 'vitest';

import { planWorkflowProposal } from '../../../src/planning/index.js';
import { makeWorkflowProposal } from '../../support/planning.js';

describe('semantic workflow proposal planning', () => {
  it('compiles an explicit semantic proposal into stable semantic and executable artifacts', () => {
    const proposal = makeWorkflowProposal();

    const first = planWorkflowProposal(proposal);
    const second = planWorkflowProposal(proposal);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('Expected proposal to compile');
    expect(first.value.semantic.semanticHash).toBe(second.value.semantic.semanticHash);
    expect(first.value.compiled.hash).toBe(second.value.compiled.hash);
    expect(first.value.semantic.source.root.children).toHaveLength(1);
    expect(first.value.semantic.source.root.children[0]).toMatchObject({
      kind: 'bounded_loop',
      until: 'delivery.accepted@1',
    });
    expect(first.value.proposal.task.reference).toBe('avia-13236-short-bug');
  });

  it('rejects an unknown semantic block before execution', () => {
    const proposal = makeWorkflowProposal();
    const result = planWorkflowProposal({
      ...proposal,
      source: {
        schemaVersion: 1,
        id: 'unknown-step',
        version: 1,
        root: {
          kind: 'sequence',
          id: 'task-work',
          children: [{ kind: 'step', id: 'unknown', uses: 'unknown.step@1', with: {} }],
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.error.stage !== 'workflow_validation') {
      throw new Error('Expected unknown semantic block rejection');
    }
    expect(result.error.validatorReport.issues.map(({ code }) => code)).toContain(
      'unknown_reference',
    );
  });

  it('rejects speculative branch recovery at the semantic boundary', () => {
    const proposal = makeWorkflowProposal();
    const result = planWorkflowProposal({
      ...proposal,
      source: {
        schemaVersion: 1,
        id: 'speculative-recovery',
        version: 1,
        root: {
          kind: 'sequence',
          id: 'task-work',
          children: [
            {
              kind: 'branch',
              id: 'ci-recovery',
              when: 'ci.passed@1',
              then: { kind: 'sequence', id: 'passed', children: [] },
              otherwise: { kind: 'sequence', id: 'failed', children: [] },
            },
          ],
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.error.stage !== 'workflow_validation') {
      throw new Error('Expected semantic source rejection');
    }
    expect(result.error.validatorReport.issues.map(({ code }) => code)).toContain('invalid_source');
  });

  it('throws when an internal scaffold violates workflow obligations', () => {
    const proposal = makeWorkflowProposal();
    const source = {
      schemaVersion: 1,
      id: 'invalid-deliver-pr-scaffold',
      version: 1,
      root: {
        kind: 'sequence',
        id: 'task-work',
        children: [
          {
            kind: 'step',
            id: 'deliver-change',
            uses: 'deliver.pull-request@1',
            with: {
              objective: 'Deliver the change',
              repository: proposal.task.repository,
              taskId: proposal.task.taskId,
            },
          },
        ],
      },
    };

    expect(() =>
      planWorkflowProposal({ ...proposal, source }, { internalInvariant: 'deliver-pr scaffold' }),
    ).toThrow('Internal deliver-pr scaffold invariant violated');
  });

  it('rejects capabilities unavailable in the active harness', () => {
    const proposal = makeWorkflowProposal();
    const result = planWorkflowProposal({
      ...proposal,
      capabilities: {
        available: proposal.capabilities.available,
        required: [...proposal.capabilities.required, 'missing.capability'],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.error.stage !== 'capability_validation') {
      throw new Error('Expected capability rejection');
    }
    expect(result.error.missingCapabilities).toContain('missing.capability');
  });

  it('inserts one internal terminal instead of asking the planner to emit it', () => {
    const result = planWorkflowProposal(makeWorkflowProposal());
    if (!result.ok) throw new Error('Expected semantic proposal to compile');
    if (result.value.compiled.graph.root.kind !== 'sequence') {
      throw new Error('Expected compiled root sequence');
    }

    expect(result.value.compiled.graph.root.children.at(-1)).toMatchObject({
      kind: 'finalize',
      id: '__tasker_complete',
      outcome: 'accepted',
    });
  });
});
