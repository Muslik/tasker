import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { PlanningClarificationSurface } from './PlanningClarificationSurface.js';

it('renders every planning question in one answer form', () => {
  const run = {
    runtime: 'bootstrap',
    planning: {
      status: 'needs_clarification',
      questions: [{ id: 'scope', question: 'What is in scope?', reason: 'Avoid ambiguity' }],
    },
  };
  const html = renderToStaticMarkup(
    createElement(PlanningClarificationSurface, {
      run,
      pending: false,
      error: null,
      onSubmit: vi.fn(),
    } as never),
  );
  expect(html).toContain('Planner needs clarification');
  expect(html).toContain('What is in scope?');
});
