import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createWorkflowAnalyzerContext } from './index.js';
import { makePlanningTaskSnapshot } from '../../test/support/planning.js';

describe('workflow analyzer context', () => {
  it('gives the analyzer building blocks and policies without a base workflow', () => {
    const fixture = makePlanningTaskSnapshot('avia-13236-short-bug');

    const context = createWorkflowAnalyzerContext(fixture);

    const plannerContext = z
      .object({
        buildingBlocks: z
          .object({
            nodeKinds: z.array(z.string()),
            steps: z.array(
              z
                .object({
                  reference: z.string(),
                  executor: z
                    .object({ kind: z.string(), skills: z.array(z.string()).optional() })
                    .loose()
                    .optional(),
                })
                .loose(),
            ),
          })
          .loose(),
        obligations: z.array(z.object({ id: z.string() }).loose()),
      })
      .loose()
      .parse(context.plannerContext);

    expect(plannerContext.buildingBlocks.nodeKinds).toEqual(['sequence', 'step', 'bounded_loop']);
    expect(plannerContext.buildingBlocks).not.toHaveProperty('waits');
    expect(plannerContext.buildingBlocks.steps.map(({ reference }) => reference)).toEqual(
      expect.arrayContaining([
        'implement.change@1',
        'verify.acceptance@1',
        'review.change@1',
        'deliver.pull-request@1',
      ]),
    );
    expect(plannerContext.buildingBlocks.steps.map(({ reference }) => reference)).not.toEqual(
      expect.arrayContaining([
        'ai.assistance.initialize@1',
        'ai.assistance.record_plan@1',
        'ai.assistance.finalize@1',
        'ai.assistance.validate@1',
      ]),
    );
    expect(plannerContext.buildingBlocks.steps.map(({ reference }) => reference)).not.toEqual(
      expect.arrayContaining(['code.repair@1', 'ci.repair@1', 'jira.start-work@1']),
    );
    const implementationExecutor = plannerContext.buildingBlocks.steps.find(
      ({ reference }) => reference === 'implement.change@1',
    )?.executor;
    expect(implementationExecutor?.kind).toBe('agent');
    expect(implementationExecutor?.skills).not.toContain('ai-assistance');
    expect(plannerContext.obligations.map(({ id }) => id)).toEqual([
      'local-ready-before-delivery',
      'delivery-feedback-is-frozen',
    ]);
    expect(JSON.stringify(context.plannerContext)).not.toContain('baseTemplate');
    expect(JSON.stringify(context.plannerContext)).not.toContain('workflowTemplates');
  });

  it('keeps Jira lifecycle operations out of the semantic Jira task catalog', () => {
    const fixture = makePlanningTaskSnapshot('avia-13236-short-bug', { origin: 'jira' });

    const context = createWorkflowAnalyzerContext(fixture);
    const plannerContext = z
      .object({
        buildingBlocks: z.object({
          steps: z.array(z.object({ reference: z.string() }).loose()),
        }),
        obligations: z.array(z.object({ id: z.string() }).loose()),
      })
      .loose()
      .parse(context.plannerContext);

    expect(plannerContext.buildingBlocks.steps.map(({ reference }) => reference)).not.toEqual(
      expect.arrayContaining(['jira.start-work@1', 'jira.review-ready@1']),
    );
    expect(plannerContext.buildingBlocks.steps.map(({ reference }) => reference)).toContain(
      'deliver.pull-request@1',
    );
    expect(plannerContext.obligations.map(({ id }) => id)).toEqual([
      'local-ready-before-delivery',
      'delivery-feedback-is-frozen',
    ]);
  });

  it('does not expose bug reproduction policy to a Jira feature task', () => {
    const fixture = makePlanningTaskSnapshot('avia-12536-feature-review', { origin: 'jira' });

    const context = createWorkflowAnalyzerContext(fixture);
    const plannerContext = z
      .object({
        buildingBlocks: z.object({
          steps: z.array(z.object({ reference: z.string() }).loose()),
        }),
        obligations: z.array(z.object({ id: z.string() }).loose()),
      })
      .loose()
      .parse(context.plannerContext);

    expect(plannerContext.buildingBlocks.steps.map(({ reference }) => reference)).not.toContain(
      'jira.start-work@1',
    );
  });

  it('keeps validation in the catalog when project profiles are incomplete', () => {
    const fixture = makePlanningTaskSnapshot('avia-13236-short-bug', {
      repository: 'onetwotrip/front-backoffice',
    });

    const context = createWorkflowAnalyzerContext(fixture);
    const plannerContext = z
      .object({
        buildingBlocks: z.object({
          steps: z.array(z.object({ reference: z.string() }).loose()),
        }),
      })
      .loose()
      .parse(context.plannerContext);

    expect(plannerContext.buildingBlocks.steps.map(({ reference }) => reference)).toContain(
      'validation.run@1',
    );
  });
});
