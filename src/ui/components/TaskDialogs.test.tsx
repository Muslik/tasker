import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { JiraTaskLaunchDialog, repositorySelectionForProduct } from './TaskDialogs.js';
import { RemoveTaskDialog } from './RemoveTaskDialog.js';
import type { ExecutionRunView } from '../../server/operator-contracts.js';

describe('task dialogs', () => {
  it('renders an existing run as a read-only settings summary', () => {
    const html = renderToStaticMarkup(
      createElement(JiraTaskLaunchDialog, {
        open: true,
        mode: 'start',
        task: {
          taskId: 'AVIA-42',
          title: 'Stabilize checkout recovery',
          origin: {
            repositoryBinding: { status: 'resolved', reference: 'front-avia' },
          },
        } as never,
        run: {
          settings: {
            branchName: 'tasker/AVIA-42/recovery',
            planningStrategy: 'ralplan',
            planReview: 'required',
            trackerStatusUpdates: 'enabled',
            operatorBrief: 'Keep the retry bounded.\nPreserve the evidence trail.',
          },
        } as ExecutionRunView,
        repositories: [],
        pending: false,
        error: null,
        productTitle: 'Avia',
        onClose: vi.fn(),
        onResolveIssue: vi.fn(),
        onResolveProduct: vi.fn(),
        onSubmit: vi.fn(),
      }),
    );

    expect(html).toContain('front-avia');
    expect(html).toContain('Avia');
    expect(html).toContain('Keep the retry bounded.');
    expect(html).not.toContain('Start task');
    expect(html).not.toContain('aria-label="Jira task"');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<select');
  });

  it('keeps start settings hidden until immediate start is selected', () => {
    const html = renderToStaticMarkup(
      createElement(JiraTaskLaunchDialog, {
        open: true,
        repositories: [],
        pending: false,
        error: null,
        onClose: vi.fn(),
        onResolveIssue: vi.fn(),
        onResolveProduct: vi.fn(),
        onSubmit: vi.fn(),
      }),
    );
    expect(html).toContain('Add Jira task');
    expect(html).toContain('Start immediately');
    expect(html).toContain('Бриф оператора');
    expect(html).toContain('aria-label="Бриф оператора"');
    expect(html).not.toContain('aria-label="Branch name"');
  });

  it('preselects a mapped product primary repository without replacing an operator override', () => {
    expect(repositorySelectionForProduct('', 'front-railways', false)).toEqual({
      repository: 'front-railways',
      autoSelected: true,
    });
    expect(repositorySelectionForProduct('front-components', 'front-railways', false)).toEqual({
      repository: 'front-components',
      autoSelected: false,
    });
  });

  it('requires the exact task key before removal', () => {
    const html = renderToStaticMarkup(
      createElement(RemoveTaskDialog, {
        task: { taskId: 'FC-2244', status: 'running' },
        pending: false,
        error: null,
        onClose: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );
    expect(html).toContain('Type FC-2244 to confirm');
    expect(html).toContain('managed containers, volumes, worktree, and local branch');
    expect(html).toContain('disabled');
  });
});
