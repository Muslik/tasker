import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { RetrospectiveSurface } from './RetrospectiveSurface.js';

it('summarizes completed task outcome and metrics', () => {
  const response = {
    status: 'ready',
    report: {
      schemaVersion: 2,
      taskReference: 'jira:FC-1',
      workflowId: 'workflow',
      workflowRunId: 'run',
      outcome: 'completed',
      metrics: {
        attempts: 2,
        blockedAttempts: 1,
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        durationMs: 100,
        estimatedCostUsd: 0.01,
        effort: {
          waitResolutions: { count: 0, kinds: {} },
          guidance: { count: 0, totalChars: 0 },
          planReviews: { rounds: 0, annotations: 0 },
          documentReviews: { rounds: 0, annotations: 0 },
          restarts: 0,
        },
        byStep: [],
      },
      findings: [],
      proposals: [],
      generatedAt: '2026-08-30T00:00:00.000Z',
    },
  };
  const html = renderToStaticMarkup(createElement(RetrospectiveSurface, { response } as never));
  expect(html).toContain('Retrospective · completed');
  expect(html).toContain('Attempts');
});
