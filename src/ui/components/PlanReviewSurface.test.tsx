import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { captureResearchDocumentSelection } from '../lib/research-document-review-selection.js';
import { planReviewFeedbackFrom } from '../lib/plan-review-feedback.js';
import { appendPlanReviewAnnotation } from './PlanReviewEditor.js';
import { PlanReviewSurface } from './PlanReviewSurface.js';

const run = {
  runtime: 'bootstrap',
  taskReference: 'jira:AVIA-77',
  runId: 'run-plan-review',
  planning: { status: 'ready', artifactId: 'implementation-plan:task:attempt-1', attempt: 2 },
};

const plan = {
  status: 'ready',
  attempt: 2,
  selectedStrategy: 'fast',
  decision: {
    plan: {
      title: 'Repair payment spacing',
      summary: 'Keep the ~~legacy~~ **payment flow** unchanged.',
      steps: [
        {
          id: 'repair-spacing',
          title: 'Repair spacing',
          objective: 'Change the bounded payment page style.',
          repository: 'front-avia',
          files: ['src/pages/FlightsPay/ui/Pay/Pay.scss'],
          verification: ['Run the targeted payment-page check.'],
        },
      ],
      acceptanceCriteria: [
        {
          id: 'spacing-restored',
          expected: 'The button has the intended gap.',
          verification: [
            {
              kind: 'inspection',
              target: 'pull request',
              expectation: 'The PR contains only the payment spacing change.',
              workflowStepIds: ['prepare-pr'],
            },
          ],
        },
      ],
      assumptions: [],
      risks: [],
    },
    rationale: 'One repository, one focused fix.',
  },
};

const history = [
  {
    schemaVersion: 2,
    planningEpisodeId: 'tasker:v3:jira:AVIA-77:run-plan-review:planning',
    taskReference: 'jira:AVIA-77',
    reviewId: 'review-1',
    planArtifactId: 'implementation-plan:task:attempt-1',
    planAttempt: 1,
    decision: 'request_changes',
    guidance: 'Keep the validation targeted.',
    annotations: [],
    submittedAt: '2026-08-30T10:00:00.000Z',
    status: 'applied',
    appliedAt: '2026-08-30T10:01:00.000Z',
  },
] as const;

describe('PlanReviewSurface', () => {
  it('renders the implementation plan as readable GFM markdown with review controls', () => {
    const html = renderToStaticMarkup(
      createElement(PlanReviewSurface, {
        run,
        plan,
        history,
        pending: false,
        error: null,
        onReview: vi.fn(),
      } as never),
    );

    expect(html).toContain('Implementation plan');
    expect(html).toContain('<del>legacy</del>');
    expect(html).toContain('Repair spacing');
    expect(html).toContain('Overall guidance');
    expect(html).toContain('Previous review rounds · 1');
  });

  it('captures a selected excerpt and builds the separate annotation callback payload', () => {
    const inside = { id: 'plan-text' };
    const selection = captureResearchDocumentSelection(
      {
        rangeCount: 1,
        toString: () => 'payment flow',
        getRangeAt: () => ({
          commonAncestorContainer: inside,
          getBoundingClientRect: () => ({ left: 40, bottom: 120 }),
        }),
      },
      { contains: (node) => node === inside },
    );

    expect(selection).toMatchObject({ kind: 'captured', quote: 'payment flow' });
    const annotations = appendPlanReviewAnnotation([], {
      id: 'annotation-1',
      quote: selection.kind === 'captured' ? selection.quote : '',
      note: 'Keep the payment copy unchanged.',
    });
    expect(
      planReviewFeedbackFrom({
        guidance: 'Keep the change bounded.',
        annotations,
      }),
    ).toContain('Keep the change bounded.');
  });
});
