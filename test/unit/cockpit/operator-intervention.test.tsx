import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { OperatorIntervention } from '../../../src/cockpit/App.js';

const renderIntervention = (kind: 'external_prerequisite' | 'operator_guidance' | 'retry_step') =>
  renderToStaticMarkup(
    createElement(OperatorIntervention, {
      action: { kind },
      stage: 'The current step needs operator action',
      guidance: '',
      pending: false,
      restartConfirming: false,
      onGuidanceChange: vi.fn(),
      onResume: vi.fn(),
      onRestartRequest: vi.fn(),
      onRestartCancel: vi.fn(),
      onRestartConfirm: vi.fn(),
    }),
  );

describe('operator intervention', () => {
  it('shows no free-form guidance for an external prerequisite', () => {
    const html = renderIntervention('external_prerequisite');

    expect(html).toContain('Prerequisite required');
    expect(html).toContain('Fix the prerequisite, then click Resume');
    expect(html).not.toContain('<textarea');
  });

  it('shows a guidance editor when the active agent consumes it', () => {
    const html = renderIntervention('operator_guidance');

    expect(html).toContain('Guidance required');
    expect(html).toContain('<textarea');
  });

  it('shows a technical retry without asking the operator for prose', () => {
    const html = renderIntervention('retry_step');

    expect(html).toContain('Retry required');
    expect(html).toContain('Retry the same step without additional guidance');
    expect(html).not.toContain('<textarea');
  });
});
