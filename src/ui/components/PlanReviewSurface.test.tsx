import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { PlanReviewSurface } from './PlanReviewSurface.js';

describe('plan review surface', () => {
  it('documents the v1 guidance-only annotation behavior when a plan is available', () => {
    const plan = {
      status: 'ready',
      attempt: 1,
      selectedStrategy: 'fast',
      decision: {
        plan: {
          title: 'Plan',
          summary: 'Summary',
          steps: [
            {
              id: 'step',
              title: 'Step',
              objective: 'Do it',
              repository: 'repo',
              files: [],
              verification: ['Test it'],
            },
          ],
          acceptanceCriteria: [
            {
              id: 'accept',
              expected: 'Works',
              verification: [
                {
                  kind: 'inspection',
                  target: 'diff',
                  expectation: 'Clean',
                  workflowStepIds: ['step'],
                },
              ],
            },
          ],
          assumptions: [],
          risks: [],
        },
        rationale: 'Small change',
      },
    };
    const run = {
      runtime: 'bootstrap',
      planning: { status: 'ready', artifactId: 'artifact', attempt: 1 },
    };
    const html = renderToStaticMarkup(
      createElement(PlanReviewSurface, {
        run,
        plan,
        history: [],
        pending: false,
        error: null,
        onReview: vi.fn(),
      } as never),
    );
    expect(html).toContain('Implementation plan');
    expect(html).toContain('Inline annotations are represented as guidance text in v1.');
  });
});
