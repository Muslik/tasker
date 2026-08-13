import { describe, expect, it } from 'vitest';

import {
  createWorkflowProposalFromAnalyzerOutput,
  planWorkflowProposal,
} from '../../../src/planning/index.js';
import { finalize, sequence, step } from '../../../src/workflow/index.js';
import {
  makeAnalyzerOutput,
  makePlanningTaskSnapshot,
  makeWorkflowProposal,
} from '../../support/planning.js';

describe('workflow proposal planning', () => {
  it('compiles an explicit agent proposal into a stable frozen candidate', () => {
    const proposal = makeWorkflowProposal();

    const first = planWorkflowProposal(proposal);
    const second = planWorkflowProposal(proposal);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('Expected proposal to compile');
    expect(first.value.compiled.hash).toBe(second.value.compiled.hash);
    expect(first.value.proposal.task.reference).toBe('avia-13236-short-bug');
  });

  it('rejects an unknown step before execution', () => {
    const proposal = makeWorkflowProposal();
    const result = planWorkflowProposal({
      ...proposal,
      source: {
        id: 'unknown-step',
        version: 1,
        root: sequence('delivery', [
          step('unknown', { uses: 'unknown.step@1', with: {} }),
          finalize('done', { outcome: 'done' }),
        ]),
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected unknown step rejection');
    expect(result.error.stage).toBe('workflow_validation');
    if (result.error.stage !== 'workflow_validation') return;
    expect(result.error.validatorReport.issues.map(({ code }) => code)).toContain(
      'unknown_reference',
    );
  });

  it('rejects a graph without a terminal node', () => {
    const proposal = makeWorkflowProposal();
    const result = planWorkflowProposal({
      ...proposal,
      source: {
        id: 'missing-terminal',
        version: 1,
        root: sequence('delivery', [
          step('implement', {
            uses: 'code.implement@1',
            with: {
              objective: 'Implement the change',
              repository: proposal.task.repository,
              taskId: proposal.task.taskId,
            },
          }),
        ]),
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.error.stage !== 'workflow_validation') {
      throw new Error('Expected graph validation rejection');
    }
    expect(result.error.validatorReport.issues.map(({ code }) => code)).toContain(
      'missing_terminal_path',
    );
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

  it('applies source-specific policy after generic graph compilation', () => {
    const task = makePlanningTaskSnapshot('avia-13236-short-bug', {
      origin: 'jira',
      reference: 'jira:AVIA-13236',
    });
    const output = makeAnalyzerOutput();
    const proposal = createWorkflowProposalFromAnalyzerOutput(task, 'test-analyzer@1', output);
    if (!proposal.ok) throw new Error('Expected proposal construction');

    const result = planWorkflowProposal(proposal.value);

    expect(result.ok).toBe(false);
    if (result.ok || result.error.stage !== 'workflow_validation') {
      throw new Error('Expected Jira policy rejection');
    }
    expect(result.error.validatorReport.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unsatisfied_workflow_obligation' }),
      ]),
    );
  });
});
