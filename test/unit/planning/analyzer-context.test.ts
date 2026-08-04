import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createWorkflowAnalyzerContext, findTaskFixture } from '../../../src/planning/index.js';

describe('workflow analyzer context', () => {
  it('gives the analyzer building blocks and policies without a base workflow', () => {
    const fixture = findTaskFixture('avia-13236-short-bug');
    if (fixture === undefined) throw new Error('Expected workflow fixture');

    const context = createWorkflowAnalyzerContext(fixture);

    const plannerContext = z
      .object({
        buildingBlocks: z
          .object({
            nodeKinds: z.array(z.string()),
            steps: z.array(z.object({ reference: z.string() }).loose()),
          })
          .loose(),
        obligations: z.array(z.object({ id: z.string() }).loose()),
      })
      .loose()
      .parse(context.plannerContext);

    expect(plannerContext.buildingBlocks.nodeKinds).toEqual(
      expect.arrayContaining(['sequence', 'step', 'bounded_loop', 'wait']),
    );
    expect(plannerContext.buildingBlocks.steps.map(({ reference }) => reference)).toEqual(
      expect.arrayContaining([
        'bug.reproduce@1',
        'ci.observe@1',
        'ai.assistance.initialize@1',
        'ai.assistance.validate@1',
      ]),
    );
    expect(plannerContext.obligations.map(({ id }) => id)).toContain('pr-requires-ci-and-review');
    expect(plannerContext.obligations.map(({ id }) => id)).toContain('pr-requires-ai-assistance');
    expect(JSON.stringify(context.plannerContext)).not.toContain('baseTemplate');
    expect(JSON.stringify(context.plannerContext)).not.toContain('workflowTemplates');
  });
});
