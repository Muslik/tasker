import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { OperatorWorkflowStage } from '../../control-plane/operator-contracts.js';
import { WorkflowRail } from './WorkflowRail.js';

const stages: readonly OperatorWorkflowStage[] = [
  {
    key: 'execution:delivery:1',
    id: 'delivery',
    label: 'Delivery',
    status: 'running',
    steps: [
      {
        kind: 'agent',
        id: 'open-pr',
        label: 'Open pull request',
        status: 'running',
        reference: 'deliver.pull-request@1',
        profile: 'delivery',
        skills: [],
        attempts: 2,
        receipts: [],
      },
    ],
  },
];

describe('WorkflowRail', () => {
  it('renders projected stages and marks the current step', () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowRail, { stages, currentNodeId: 'open-pr' }),
    );

    expect(html).toContain('Delivery');
    expect(html).toContain('Open pull request');
    expect(html).toContain('Attempt 2');
    expect(html).toContain('data-current="true"');
  });
});
