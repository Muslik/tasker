import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { RemoveTaskDialog } from '../../../src/cockpit/App.js';
import { OperatorTaskSummarySchema } from '../../../src/server/operator-contracts.js';

const task = (status: 'backlog' | 'running') =>
  OperatorTaskSummarySchema.parse({
    id: 'jira:FC-2244',
    taskId: 'FC-2244',
    title: 'Fix limiter interceptor',
    origin: {
      kind: 'jira',
      issueKey: 'FC-2244',
      issueType: 'Bug',
      browseUrl: null,
      syncStatus: 'current',
      repositoryBinding: {
        status: 'missing',
        issueKey: 'FC-2244',
        recordedAt: '2026-08-26T00:00:00.000Z',
      },
    },
    planning: { status: 'available' },
    status,
    attention: status === 'running' ? 'operator' : 'none',
    currentStage: status,
    updatedAt: '2026-08-26T00:00:00.000Z',
  });

describe('remove task dialog', () => {
  it('explains active cleanup and requires the task key', () => {
    const html = renderToStaticMarkup(
      createElement(RemoveTaskDialog, {
        task: task('running'),
        pending: false,
        error: null,
        onClose: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    expect(html).toContain('Stop and remove task');
    expect(html).toContain('managed containers, volumes, worktree, and local branch');
    expect(html).toContain('Type FC-2244 to confirm');
    expect(html).toContain('disabled');
  });
});
