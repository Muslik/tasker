import { describe, expect, it } from 'vitest';

import {
  findTaskFixture,
  listTaskFixtures,
  planTaskWorkflow,
} from '../../../src/planning/index.js';

const fixture = (fixtureId: string) => {
  const value = findTaskFixture(fixtureId);
  if (value === undefined) {
    throw new Error(`Missing test fixture ${fixtureId}`);
  }
  return value;
};

describe('M1 task workflow planning', () => {
  it('compiles the three accepted task families into distinct inspectable graphs', () => {
    const results = listTaskFixtures()
      .filter((candidate) => candidate.expected === 'accepted')
      .map((candidate) => planTaskWorkflow(candidate));

    expect(results).toHaveLength(3);
    expect(results.every((result) => result.ok)).toBe(true);
    const hashes = results.flatMap((result) => (result.ok ? [result.value.compiled.hash] : []));
    expect(new Set(hashes).size).toBe(3);
    expect(
      results.every(
        (result) =>
          result.ok &&
          result.value.presentation.nodeCount > 0 &&
          result.value.diff.entries.length > 0,
      ),
    ).toBe(true);
    expect(results[0]?.ok && results[0].value.executionEligibility).toEqual({
      reason: 'm1_read_only',
      status: 'disabled',
    });
  });

  it('produces the same graph, metadata, and diff for identical fixture input', () => {
    const input = fixture('avia-13236-short-bug');

    const results = [planTaskWorkflow(input), planTaskWorkflow(input)];

    expect(results[0]).toEqual(results[1]);
  });

  it.each([
    ['invalid-unknown-step', 'unknown_reference'],
    ['invalid-missing-terminal', 'missing_terminal_path'],
    ['invalid-unsafe-effect', 'effectful_step_without_reconciliation_metadata'],
    ['invalid-unbounded-loop', 'invalid_source'],
  ] as const)('rejects %s before it can become executable', (fixtureId, issueCode) => {
    const result = planTaskWorkflow(fixture(fixtureId));

    expect(result.ok).toBe(false);
    if (result.ok || result.error.stage !== 'workflow_validation') {
      return;
    }
    expect(result.error.code).toBe('workflow_rejected');
    expect(result.error.validatorReport.issues.map((issue) => issue.code)).toContain(issueCode);
  });

  it('rejects a graph whose registered steps need an unavailable capability', () => {
    const result = planTaskWorkflow(fixture('invalid-unmet-capability'));

    expect(result.ok).toBe(false);
    if (result.ok || result.error.stage !== 'capability_validation') {
      return;
    }
    expect(result.error.missingCapabilities).toContain('repository.read');
  });

  it('rejects unknown fixture fields at the untyped intake boundary', () => {
    const input = {
      ...fixture('avia-13236-short-bug'),
      silentlyAcceptedField: true,
    };

    const result = planTaskWorkflow(input);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.stage).toBe('fixture');
  });

  it('exposes loop, wait, retry, artifact, and verification rationale metadata to renderers', () => {
    const result = planTaskWorkflow(fixture('avia-14001-translation-component'));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.proposal.waits.map((wait) => wait.waitKind)).toEqual([
      'code_review@1',
      'final_publish@1',
      'translation_complete@1',
    ]);
    expect(result.value.proposal.retryBudgets.some((budget) => budget.scope === 'loop')).toBe(true);
    expect(result.value.proposal.expectedArtifacts.length).toBeGreaterThan(0);
    expect(result.value.proposal.verificationPlan.rationale).toContain('translation');
    expect(
      Object.values(result.value.presentation.nodes).some((node) => node.kind === 'wait'),
    ).toBe(true);
    expect(result.value.presentation.nodes['consume-published-version']).toMatchObject({
      kind: 'step',
      uses: 'component.consume_published@1',
    });
    expect(result.value.proposal.waits.every((wait) => wait.resumeAt === undefined)).toBe(true);
  });
});
