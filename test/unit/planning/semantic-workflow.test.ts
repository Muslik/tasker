import { describe, expect, it } from 'vitest';

import { HARNESS_WORKFLOW_CONTRACTS } from '../../../src/planning/contracts.js';
import { validateWorkflowObligations } from '../../../src/planning/obligations.js';
import { compileSemanticWorkflow } from '../../../src/workflow/index.js';

describe('semantic workflow harness', () => {
  it('compiles one visible development loop from the registered semantic agent blocks', () => {
    const taskInput = {
      objective: 'Fix the reproduced layout defect',
      repository: 'onetwotrip/front-avia',
      taskId: 'AVIA-1',
    };
    const result = compileSemanticWorkflow({
      contracts: HARNESS_WORKFLOW_CONTRACTS,
      loopExhaustedWait: 'operator_guidance@1',
      source: {
        schemaVersion: 1,
        id: 'simple-layout-fix',
        version: 1,
        root: {
          kind: 'sequence',
          id: 'local-delivery',
          children: [
            {
              kind: 'bounded_loop',
              id: 'development-loop',
              maxAttempts: 3,
              until: 'verification.accepted@1',
              body: {
                kind: 'sequence',
                id: 'development-attempt',
                children: [
                  { kind: 'step', id: 'implement', uses: 'implement.change@1', with: taskInput },
                  { kind: 'step', id: 'verify', uses: 'verify.acceptance@1', with: taskInput },
                ],
              },
            },
            { kind: 'step', id: 'review', uses: 'review.change@1', with: taskInput },
          ],
        },
      },
    });

    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.source.root.children).toHaveLength(2);
    expect(result.value.semanticCanonicalJson).not.toContain('code.repair');
    expect(result.value.semanticCanonicalJson).not.toContain('bug.validate_fix');
    expect(result.value.compiled.graph.metadata.references).toMatchObject({
      predicates: ['verification.accepted@1'],
      stepTypes: ['implement.change@1', 'review.change@1', 'verify.acceptance@1'],
      waits: ['operator_guidance@1'],
    });
  });

  it('freezes task-caused CI and human-review repair inside the delivery feedback loop', () => {
    const taskInput = {
      objective: 'Fix the flight card layout and publish it',
      repository: 'onetwotrip/front-avia',
      taskId: 'AVIA-1',
    };
    const result = compileSemanticWorkflow({
      contracts: HARNESS_WORKFLOW_CONTRACTS,
      loopExhaustedWait: 'operator_guidance@1',
      source: {
        schemaVersion: 1,
        id: 'flight-card-delivery',
        version: 1,
        root: {
          kind: 'sequence',
          id: 'task-work',
          children: [
            {
              kind: 'bounded_loop',
              id: 'delivery-feedback',
              maxAttempts: 3,
              until: 'delivery.accepted@1',
              body: {
                kind: 'sequence',
                id: 'delivery-attempt',
                children: [
                  {
                    kind: 'bounded_loop',
                    id: 'review-feedback',
                    maxAttempts: 3,
                    until: 'agent_review.accepted@1',
                    body: {
                      kind: 'sequence',
                      id: 'review-attempt',
                      children: [
                        {
                          kind: 'bounded_loop',
                          id: 'development',
                          maxAttempts: 3,
                          until: 'verification.accepted@1',
                          body: {
                            kind: 'sequence',
                            id: 'development-attempt',
                            children: [
                              {
                                kind: 'step',
                                id: 'implement-change',
                                uses: 'implement.change@1',
                                with: taskInput,
                              },
                              {
                                kind: 'step',
                                id: 'verify-change',
                                uses: 'verify.acceptance@1',
                                with: taskInput,
                              },
                            ],
                          },
                        },
                        {
                          kind: 'step',
                          id: 'review-change',
                          uses: 'review.change@1',
                          with: taskInput,
                        },
                      ],
                    },
                  },
                  {
                    kind: 'step',
                    id: 'deliver-change',
                    uses: 'deliver.pull-request@1',
                    with: taskInput,
                  },
                ],
              },
            },
          ],
        },
      },
    });

    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.compiled.graph.metadata.references.predicates).toContain(
      'delivery.accepted@1',
    );
  });

  it('rejects pull-request delivery outside a frozen delivery feedback loop', () => {
    const result = compileSemanticWorkflow({
      contracts: HARNESS_WORKFLOW_CONTRACTS,
      loopExhaustedWait: 'operator_guidance@1',
      source: {
        schemaVersion: 1,
        id: 'unsafe-delivery',
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
                objective: 'Publish',
                repository: 'onetwotrip/front-avia',
                taskId: 'AVIA-1',
              },
            },
          ],
        },
      },
    });

    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const report = validateWorkflowObligations(result.value.compiled.graph, {
      origin: 'fixture',
    });
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unsatisfied_workflow_obligation',
          details: { obligationId: 'delivery-feedback-is-frozen' },
        }),
      ]),
    );
  });

  it('compiles a bounded dev-to-final dependency verification workflow', () => {
    const taskInput = {
      objective: 'Verify the consumer against an exact shared package',
      repository: 'onetwotrip/front-index',
      taskId: 'FI-1309',
    };
    const dependency = {
      declarationId: 'dependency-declaration:jira-link:1:jira:FI-1309',
      declarationRevision: 1,
      packages: ['@ott/interceptors'],
    };
    const dependencyConsumption = {
      declarationId: dependency.declarationId,
      declarationRevision: dependency.declarationRevision,
    };
    const result = compileSemanticWorkflow({
      contracts: HARNESS_WORKFLOW_CONTRACTS,
      loopExhaustedWait: 'operator_guidance@1',
      source: {
        schemaVersion: 1,
        id: 'linked-package-verification',
        version: 1,
        root: {
          kind: 'sequence',
          id: 'dependency-work',
          children: [
            {
              kind: 'bounded_loop',
              id: 'dev-validation',
              maxAttempts: 3,
              until: 'verification.accepted@1',
              body: {
                kind: 'sequence',
                id: 'dev-attempt',
                children: [
                  {
                    kind: 'step',
                    id: 'await-dev',
                    uses: 'dependency.await_packages@1',
                    with: { ...taskInput, ...dependency, channel: 'dev' },
                  },
                  {
                    kind: 'step',
                    id: 'consume-dev',
                    uses: 'dependency.consume_exact@1',
                    with: { ...taskInput, ...dependencyConsumption, channel: 'dev' },
                  },
                  {
                    kind: 'step',
                    id: 'verify-dev',
                    uses: 'verify.acceptance@1',
                    with: taskInput,
                  },
                ],
              },
            },
            {
              kind: 'step',
              id: 'await-final',
              uses: 'dependency.await_packages@1',
              with: { ...taskInput, ...dependency, channel: 'final' },
            },
            {
              kind: 'step',
              id: 'consume-final',
              uses: 'dependency.consume_exact@1',
              with: { ...taskInput, ...dependencyConsumption, channel: 'final' },
            },
            {
              kind: 'step',
              id: 'verify-final',
              uses: 'verify.acceptance@1',
              with: taskInput,
            },
          ],
        },
      },
    });

    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const report = validateWorkflowObligations(result.value.compiled.graph, { origin: 'jira' });
    expect(report.issues).toEqual([]);
    expect(result.value.compiled.graph.metadata.references).toMatchObject({
      stepTypes: [
        'dependency.await_packages@1',
        'dependency.consume_exact@1',
        'verify.acceptance@1',
      ],
      waits: ['operator_guidance@1'],
    });
  });

  it('rejects exact dependency consumption without earlier verified publication evidence', () => {
    const result = compileSemanticWorkflow({
      contracts: HARNESS_WORKFLOW_CONTRACTS,
      loopExhaustedWait: 'operator_guidance@1',
      source: {
        schemaVersion: 1,
        id: 'unverified-dependency-consumption',
        version: 1,
        root: {
          kind: 'sequence',
          id: 'dependency-work',
          children: [
            {
              kind: 'step',
              id: 'consume-final',
              uses: 'dependency.consume_exact@1',
              with: {
                objective: 'Consume an unverified package',
                repository: 'onetwotrip/front-index',
                taskId: 'FI-1309',
                declarationId: 'dependency-declaration:jira-link:1:jira:FI-1309',
                declarationRevision: 1,
                channel: 'final',
              },
            },
          ],
        },
      },
    });

    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const report = validateWorkflowObligations(result.value.compiled.graph, { origin: 'jira' });
    const missingProducer = report.issues.find(
      (issue) =>
        issue.code === 'unsatisfied_workflow_obligation' &&
        issue.details !== undefined &&
        issue.details !== null &&
        typeof issue.details === 'object' &&
        !Array.isArray(issue.details) &&
        issue.details.obligationId === 'artifact-producer-before-consumer',
    );
    expect(missingProducer?.message).toContain('dependency-publication');
  });
});
