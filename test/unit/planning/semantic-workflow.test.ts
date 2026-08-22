import { describe, expect, it } from 'vitest';

import { HARNESS_WORKFLOW_CONTRACTS } from '../../../src/planning/contracts.js';
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
});
