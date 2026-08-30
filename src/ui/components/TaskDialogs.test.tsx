import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { JiraTaskLaunchDialog } from './TaskDialogs.js';
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
        onSubmit: vi.fn(),
      }),
    );
    expect(html).toContain('Add Jira task');
    expect(html).toContain('Start immediately');
    expect(html).not.toContain('aria-label="Branch name"');
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
