import { describe, expect, it } from 'vitest';

import {
  findTaskFixture,
  listTaskFixtures,
  planTaskWorkflow,
  planWorkflowProposal,
} from '../../../src/planning/index.js';
import { WorkflowSourceSchema, type WorkflowNodeSource } from '../../../src/workflow/index.js';

const fixture = (fixtureId: string) => {
  const value = findTaskFixture(fixtureId);
  if (value === undefined) {
    throw new Error(`Missing test fixture ${fixtureId}`);
  }
  return value;
};

const removeStep = (node: WorkflowNodeSource, reference: string): WorkflowNodeSource => {
  switch (node.kind) {
    case 'sequence':
      return {
        ...node,
        children: node.children
          .filter((child) => child.kind !== 'step' || child.uses !== reference)
          .map((child) => removeStep(child, reference)),
      };
    case 'branch':
      return {
        ...node,
        then: removeStep(node.then, reference),
        otherwise: removeStep(node.otherwise, reference),
      };
    case 'bounded_loop':
      return { ...node, body: removeStep(node.body, reference) };
    case 'step':
    case 'gate':
    case 'wait':
    case 'finalize':
      return node;
  }
};

const removeNode = (node: WorkflowNodeSource, id: string): WorkflowNodeSource => {
  switch (node.kind) {
    case 'sequence':
      return {
        ...node,
        children: node.children
          .filter((child) => child.id !== id)
          .map((child) => removeNode(child, id)),
      };
    case 'branch':
      return {
        ...node,
        then: removeNode(node.then, id),
        otherwise: removeNode(node.otherwise, id),
      };
    case 'bounded_loop':
      return { ...node, body: removeNode(node.body, id) };
    case 'step':
    case 'gate':
    case 'wait':
    case 'finalize':
      return node;
  }
};

const findNode = (node: WorkflowNodeSource, id: string): WorkflowNodeSource | undefined => {
  if (node.id === id) return node;
  switch (node.kind) {
    case 'sequence':
      return node.children.map((child) => findNode(child, id)).find(Boolean);
    case 'branch':
      return findNode(node.then, id) ?? findNode(node.otherwise, id);
    case 'bounded_loop':
      return findNode(node.body, id);
    case 'step':
    case 'gate':
    case 'wait':
    case 'finalize':
      return undefined;
  }
};

describe('M1 task workflow planning', () => {
  it('compiles every accepted task analysis into a distinct inspectable graph', () => {
    const results = listTaskFixtures()
      .filter((candidate) => candidate.expected === 'accepted')
      .map((candidate) => planTaskWorkflow(candidate));

    expect(results).toHaveLength(4);
    expect(results.every((result) => result.ok)).toBe(true);
    const hashes = results.flatMap((result) => (result.ok ? [result.value.compiled.hash] : []));
    expect(new Set(hashes).size).toBe(4);
    expect(
      results.every(
        (result) =>
          result.ok &&
          result.value.presentation.nodeCount > 0 &&
          result.value.proposal.assemblyDecisions.length > 0,
      ),
    ).toBe(true);
    expect(results[0]?.ok && results[0].value.executionEligibility).toEqual({
      reason: 'm1_read_only',
      status: 'disabled',
    });
  });

  it('produces the same graph and metadata for identical fixture input', () => {
    const input = fixture('avia-13236-short-bug');

    const results = [planTaskWorkflow(input), planTaskWorkflow(input)];

    expect(results[0]).toEqual(results[1]);
  });

  it('assembles declared validation and independent review as separate bounded boundaries', () => {
    const planned = planTaskWorkflow(fixture('avia-13236-short-bug'));
    if (!planned.ok) throw new Error('Expected the short bug fixture to produce a proposal');
    const source = WorkflowSourceSchema.parse(planned.value.proposal.source);

    expect(findNode(source.root, 'validate-targeted')).toMatchObject({
      kind: 'step',
      uses: 'validate.targeted@1',
    });
    expect(findNode(source.root, 'validation-repair-loop')).toMatchObject({
      kind: 'bounded_loop',
      maxAttempts: 3,
      until: 'validation.passed@1',
      checkBefore: true,
      exhaustedWait: 'operator_guidance@1',
    });
    expect(findNode(source.root, 'agent-review')).toMatchObject({
      kind: 'step',
      uses: 'review.agent@1',
    });
    expect(findNode(source.root, 'agent-review-repair-loop')).toMatchObject({
      kind: 'bounded_loop',
      maxAttempts: 3,
      until: 'agent_review.accepted@1',
      checkBefore: true,
      exhaustedWait: 'operator_guidance@1',
    });
  });

  it('rejects a PR workflow when the analyzer omits CI observation', () => {
    const planned = planTaskWorkflow(fixture('avia-13236-short-bug'));
    if (!planned.ok) {
      throw new Error('Expected the short bug fixture to produce a sequence proposal');
    }
    const source = WorkflowSourceSchema.parse(planned.value.proposal.source);
    if (source.root.kind !== 'sequence') {
      throw new Error('Expected the short bug fixture to produce a sequence proposal');
    }
    const withoutCi = {
      ...planned.value.proposal,
      source: {
        ...source,
        root: {
          ...source.root,
          children: source.root.children.filter(
            (child) => child.kind !== 'step' || child.uses !== 'ci.observe@1',
          ),
        },
      },
    };

    const result = planWorkflowProposal(withoutCi);

    expect(result.ok).toBe(false);
    if (result.ok || result.error.stage !== 'workflow_validation') return;
    expect(result.error.validatorReport.issues).toContainEqual(
      expect.objectContaining({
        code: 'unsatisfied_workflow_obligation',
        details: { obligationId: 'pr-requires-ci-and-review' },
      }),
    );
  });

  it('assembles a bounded CI recovery boundary before human review', () => {
    const planned = planTaskWorkflow(fixture('avia-13236-short-bug'));
    if (!planned.ok) throw new Error('Expected the short bug fixture to produce a proposal');
    const source = WorkflowSourceSchema.parse(planned.value.proposal.source);

    expect(findNode(source.root, 'ci-recovery-loop')).toMatchObject({
      kind: 'bounded_loop',
      maxAttempts: 3,
      until: 'ci.passed@1',
      checkBefore: true,
      exhaustedWait: 'operator_guidance@1',
    });
    expect(findNode(source.root, 'repair-ci-failure')).toMatchObject({
      kind: 'step',
      uses: 'ci.repair@1',
    });
    expect(findNode(source.root, 'wait-for-flaky-ci-retry')).toMatchObject({
      kind: 'wait',
      for: 'ci_retry@1',
    });
    expect(findNode(source.root, 'wait-for-ci-infrastructure')).toMatchObject({
      kind: 'wait',
      for: 'ci_infrastructure@1',
    });
  });

  it('rejects a PR workflow that can enter review without a passed CI fact', () => {
    const planned = planTaskWorkflow(fixture('avia-13236-short-bug'));
    if (!planned.ok) throw new Error('Expected the short bug fixture to produce a proposal');
    const source = WorkflowSourceSchema.parse(planned.value.proposal.source);

    const result = planWorkflowProposal({
      ...planned.value.proposal,
      source: { ...source, root: removeNode(source.root, 'ci-recovery-loop') },
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.error.stage !== 'workflow_validation') return;
    expect(result.error.validatorReport.issues).toContainEqual(
      expect.objectContaining({
        code: 'unsatisfied_workflow_obligation',
        details: { obligationId: 'pr-requires-passed-ci' },
      }),
    );
  });

  it('rejects a PR workflow when its enabled company policy is incomplete', () => {
    const planned = planTaskWorkflow(fixture('avia-13236-short-bug'));
    if (!planned.ok) throw new Error('Expected the short bug fixture to produce a proposal');
    const source = WorkflowSourceSchema.parse(planned.value.proposal.source);
    if (source.root.kind !== 'sequence') throw new Error('Expected a sequence proposal');
    const withoutPolicyValidation = {
      ...planned.value.proposal,
      source: {
        ...source,
        root: {
          ...source.root,
          children: source.root.children.filter(
            (child) => child.kind !== 'step' || child.uses !== 'ai.assistance.validate@1',
          ),
        },
      },
    };

    const result = planWorkflowProposal(withoutPolicyValidation);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.stage).toBe('workflow_validation');
    if (result.error.stage !== 'workflow_validation') return;
    expect(result.error.validatorReport.issues).toContainEqual(
      expect.objectContaining({
        code: 'unsatisfied_workflow_obligation',
        details: { obligationId: 'pr-requires-ai-assistance' },
      }),
    );
  });

  it('rejects a Jira workflow that mutates the repository before tracker admission', () => {
    const planned = planTaskWorkflow(fixture('avia-12536-feature-review'));
    if (!planned.ok) throw new Error('Expected the feature fixture to produce a proposal');

    const result = planWorkflowProposal({
      ...planned.value.proposal,
      fixture: { ...planned.value.proposal.fixture, origin: 'jira' },
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.error.stage !== 'workflow_validation') return;
    expect(result.error.validatorReport.issues).toContainEqual(
      expect.objectContaining({
        code: 'unsatisfied_workflow_obligation',
        details: { obligationId: 'jira-admission-before-workspace-write' },
      }),
    );
  });

  it('accepts Jira admission after plan approval and before operational effects', () => {
    const result = planTaskWorkflow({
      ...fixture('avia-12536-feature-review'),
      origin: 'jira',
    });

    expect(result.ok).toBe(true);
  });

  it('rejects a Jira workflow that reaches code review before Jira review readiness', () => {
    const planned = planTaskWorkflow({
      ...fixture('avia-12536-feature-review'),
      origin: 'jira',
    });
    if (!planned.ok) throw new Error('Expected the Jira feature fixture to produce a proposal');
    const source = WorkflowSourceSchema.parse(planned.value.proposal.source);

    const result = planWorkflowProposal({
      ...planned.value.proposal,
      source: { ...source, root: removeStep(source.root, 'jira.review-ready@1') },
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.error.stage !== 'workflow_validation') return;
    expect(result.error.validatorReport.issues).toContainEqual(
      expect.objectContaining({
        code: 'unsatisfied_workflow_obligation',
        details: { obligationId: 'jira-review-ready-before-code-review' },
      }),
    );
  });

  it('rejects a review revision that is not acknowledged before returning to review', () => {
    const planned = planTaskWorkflow(fixture('avia-13236-short-bug'));
    if (!planned.ok) throw new Error('Expected the short bug fixture to produce a proposal');
    const source = WorkflowSourceSchema.parse(planned.value.proposal.source);
    const result = planWorkflowProposal({
      ...planned.value.proposal,
      source: { ...source, root: removeStep(source.root, 'review.acknowledge@1') },
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.error.stage !== 'workflow_validation') return;
    expect(result.error.validatorReport.issues).toContainEqual(
      expect.objectContaining({
        code: 'unsatisfied_workflow_obligation',
        details: { obligationId: 'publish-and-acknowledge-review-revision' },
      }),
    );
  });

  it('rejects a write-capable workflow when the analyzer omits PR preparation', () => {
    const planned = planTaskWorkflow(fixture('avia-12536-feature-review'));
    if (!planned.ok) throw new Error('Expected the feature fixture to produce a proposal');
    const source = WorkflowSourceSchema.parse(planned.value.proposal.source);
    if (source.root.kind !== 'sequence') throw new Error('Expected a sequence proposal');
    const withoutPullRequest = {
      ...planned.value.proposal,
      source: {
        ...source,
        root: {
          ...source.root,
          children: source.root.children.filter(
            (child) => child.kind !== 'step' || child.uses !== 'pr.prepare@1',
          ),
        },
      },
    };

    const result = planWorkflowProposal(withoutPullRequest);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.stage).toBe('workflow_validation');
    if (result.error.stage !== 'workflow_validation') return;
    expect(result.error.validatorReport.issues).toContainEqual(
      expect.objectContaining({
        code: 'unsatisfied_workflow_obligation',
        details: { obligationId: 'write-requires-pr' },
      }),
    );
  });

  it('rejects a bug workflow without after-fix reproduction evidence', () => {
    const planned = planTaskWorkflow(fixture('avia-13236-short-bug'));
    if (!planned.ok) throw new Error('Expected the short bug fixture to produce a proposal');
    const source = WorkflowSourceSchema.parse(planned.value.proposal.source);
    if (source.root.kind !== 'sequence') throw new Error('Expected a sequence proposal');
    const withoutAfterEvidence = {
      ...planned.value.proposal,
      source: {
        ...source,
        root: removeStep(source.root, 'bug.validate_fix@1'),
      },
    };

    const result = planWorkflowProposal(withoutAfterEvidence);

    expect(result).toMatchObject({
      ok: false,
      error: {
        stage: 'workflow_validation',
        validatorReport: {
          issues: [
            {
              code: 'unsatisfied_workflow_obligation',
              details: { obligationId: 'bug-requires-after-evidence' },
            },
          ],
        },
      },
    });
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
    expect(result.value.proposal.waits.map((wait) => wait.waitKind)).toEqual(
      expect.arrayContaining([
        'ci_infrastructure@1',
        'ci_retry@1',
        'ci_unknown@1',
        'code_review@1',
        'final_publish@1',
        'translation_complete@1',
      ]),
    );
    expect(JSON.stringify(result.value.proposal)).not.toContain('retryBudgets');
    expect(result.value.proposal.expectedArtifacts.length).toBeGreaterThan(0);
    expect(result.value.proposal.verificationPlan.rationale).toContain('translation');
    expect(result.value.proposal.assemblyDecisions.map((decision) => decision.id)).toEqual([
      'task-family',
      'bounded-repair',
      'planning-boundary',
      'ai-assistance-policy',
      'cross-repository-component',
      'translation-policy',
      'publication-policy',
      'verification-profile',
      'pr-readiness',
    ]);
    expect(
      Object.values(result.value.presentation.nodes).some((node) => node.kind === 'wait'),
    ).toBe(true);
    expect(result.value.presentation.nodes['consume-published-version']).toMatchObject({
      kind: 'step',
      uses: 'component.consume_published@1',
    });
    expect(result.value.presentation.nodes['acknowledge-review-threads']).toMatchObject({
      kind: 'step',
      uses: 'review.acknowledge@1',
    });
    expect(result.value.proposal.waits.every((wait) => wait.resumeAt === undefined)).toBe(true);
    const publicationDecision = result.value.proposal.assemblyDecisions.find(
      (decision) => decision.id === 'publication-policy',
    );
    expect(publicationDecision?.title).toBe('Global package publication policy applied');
    expect(publicationDecision?.source).toBe('global:frontend-ott-package');
    expect(publicationDecision?.reason).toContain('frontend-ott-package');
  });

  it('adds external translation work only when the target project policy requires it', () => {
    const result = planTaskWorkflow(fixture('avia-14001-translation-component'));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.proposal.assemblyDecisions).toContainEqual(
      expect.objectContaining({
        id: 'translation-policy',
        title: 'External translation policy applied',
        source: 'project:twiket/ui-kit',
      }),
    );
    expect(result.value.proposal.waits.map((entry) => entry.waitKind)).toContain(
      'translation_complete@1',
    );
    expect(Object.values(result.value.presentation.nodes)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uses: 'translations.extract@1' }),
        expect.objectContaining({ uses: 'translations.pull@1' }),
      ]),
    );
  });

  it('keeps project-owned locale JSON inside implementation without translation orchestration', () => {
    const result = planTaskWorkflow(fixture('avia-14002-inline-copy'));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.proposal.assemblyDecisions).toContainEqual(
      expect.objectContaining({
        id: 'translation-policy',
        title: 'Inline translation policy applied',
        source: 'project:onetwotrip/front-avia',
      }),
    );
    expect(result.value.proposal.waits.map((entry) => entry.waitKind)).not.toContain(
      'translation_complete@1',
    );
    expect(
      Object.values(result.value.presentation.nodes).some(
        (node) =>
          node.kind === 'step' &&
          (node.uses === 'translations.extract@1' || node.uses === 'translations.pull@1'),
      ),
    ).toBe(false);
  });
});
