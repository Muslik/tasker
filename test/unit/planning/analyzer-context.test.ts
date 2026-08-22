import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createWorkflowAnalyzerContext } from '../../../src/planning/index.js';
import { makePlanningTaskSnapshot } from '../../support/planning.js';

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
        'bug.validate_fix@1',
        'validate.targeted@1',
        'review.agent@1',
        'ci.observe@1',
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
    expect(plannerContext.buildingBlocks.steps.map(({ reference }) => reference)).not.toContain(
      'jira.start-work@1',
    );
    const implementationExecutor = plannerContext.buildingBlocks.steps.find(
      ({ reference }) => reference === 'code.implement@1',
    )?.executor;
    expect(implementationExecutor?.kind).toBe('agent');
    expect(implementationExecutor?.skills).toContain('ai-assistance');
    expect(plannerContext.obligations.map(({ id }) => id)).toEqual([
      'review-after-final-bug-proof',
      'publish-and-acknowledge-review-revision',
    ]);
    expect(JSON.stringify(context.plannerContext)).not.toContain('baseTemplate');
    expect(JSON.stringify(context.plannerContext)).not.toContain('workflowTemplates');
  });

  it('exposes Jira lifecycle policy only to Jira-origin task analysis', () => {
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

    expect(plannerContext.buildingBlocks.steps.map(({ reference }) => reference)).toContain(
      'jira.start-work@1',
    );
    expect(plannerContext.buildingBlocks.steps.map(({ reference }) => reference)).toContain(
      'jira.review-ready@1',
    );
    expect(plannerContext.obligations.map(({ id }) => id)).toContain(
      'jira-admission-before-workspace-write',
    );
    expect(plannerContext.obligations.map(({ id }) => id)).toContain(
      'jira-review-ready-before-code-review',
    );
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

    expect(plannerContext.buildingBlocks.steps.map(({ reference }) => reference)).toContain(
      'jira.start-work@1',
    );
  });
});
