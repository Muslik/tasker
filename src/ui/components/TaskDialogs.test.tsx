import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { JiraTaskLaunchDialog, repositorySelectionForProduct } from './TaskDialogs.js';
import { RemoveTaskDialog } from './RemoveTaskDialog.js';

describe('task dialogs', () => {
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
