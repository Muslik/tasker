import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createWorkflowAnalyzerContext,
  findTaskFixture,
  TaskFixtureSchema,
} from '../../../src/planning/index.js';

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
        'bug.validate_fix@1',
        'validate.targeted@1',
        'review.agent@1',
        'ci.observe@1',
        'ai.assistance.initialize@1',
        'ai.assistance.validate@1',
      ]),
    );
    expect(plannerContext.buildingBlocks.steps.map(({ reference }) => reference)).not.toContain(
      'jira.start-work@1',
    );
    expect(plannerContext.obligations.map(({ id }) => id)).toContain('pr-requires-ci-and-review');
    expect(plannerContext.obligations.map(({ id }) => id)).toContain('write-requires-agent-review');
    expect(plannerContext.obligations.map(({ id }) => id)).toContain('pr-requires-ai-assistance');
    expect(JSON.stringify(context.plannerContext)).not.toContain('baseTemplate');
    expect(JSON.stringify(context.plannerContext)).not.toContain('workflowTemplates');
  });

  it('exposes Jira lifecycle policy only to Jira-origin task analysis', () => {
    const source = findTaskFixture('avia-13236-short-bug');
    if (source === undefined) throw new Error('Expected workflow fixture');
    const fixture = TaskFixtureSchema.parse({ ...source, origin: 'jira' });

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
    const source = findTaskFixture('avia-12536-feature-review');
    if (source === undefined) throw new Error('Expected workflow fixture');
    const fixture = TaskFixtureSchema.parse({ ...source, origin: 'jira' });

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
