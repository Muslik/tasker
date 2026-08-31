import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { ExecutionRunView } from '../../server/operator-contracts.js';
import { TaskRunSettingsSummary } from './TaskRunSettingsSummary.js';

describe('TaskRunSettingsSummary', () => {
  it('renders the complete immutable run settings and close action', () => {
    const html = renderToStaticMarkup(
      createElement(TaskRunSettingsSummary, {
        task: {
          taskId: 'AVIA-42',
          title: 'Stabilize checkout recovery',
          origin: { repositoryBinding: { status: 'resolved', reference: 'front-avia' } },
        } as never,
        run: {
          settings: {
            branchName: 'tasker/AVIA-42/recovery',
            planningStrategy: 'fast',
            planReview: 'automatic',
            trackerStatusUpdates: 'disabled',
            operatorBrief: 'Full operator brief',
          },
        } as ExecutionRunView,
        productTitle: 'Avia',
        onClose: vi.fn(),
      }),
    );

    expect(html).toContain('Task settings');
    expect(html).toContain('tasker/AVIA-42/recovery');
    expect(html).toContain('Full operator brief');
    expect(html).toContain('Close');
    expect(html).not.toContain('Start task');
  });
});
