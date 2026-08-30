import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { RemoveTaskDialog } from './RemoveTaskDialog.js';

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
