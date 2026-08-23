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
});
