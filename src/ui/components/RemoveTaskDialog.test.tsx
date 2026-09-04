import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { RemoveTaskDialog } from './RemoveTaskDialog.js';

vi.mock('./ui/dialog.js', async () => {
  const React = await import('react');
  return {
    Dialog: ({ children }: { readonly children: React.ReactNode }) =>
      createElement(React.Fragment, null, children),
    DialogContent: ({ children }: { readonly children: React.ReactNode }) =>
      createElement('div', null, children),
    DialogDescription: ({ children }: { readonly children: React.ReactNode }) =>
      createElement('p', null, children),
    DialogFooter: ({ children }: { readonly children: React.ReactNode }) =>
      createElement('div', null, children),
    DialogHeader: ({ children }: { readonly children: React.ReactNode }) =>
      createElement('div', null, children),
    DialogTitle: ({ children }: { readonly children: React.ReactNode }) =>
      createElement('h2', null, children),
  };
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
  expect(html).toContain('Active workflow');
  expect(html).toContain('managed containers, volumes, worktree, and local branch');
  expect(html).toContain('disabled');
});

it('renders pending removal feedback at the action site', () => {
  const html = renderToStaticMarkup(
    createElement(RemoveTaskDialog, {
      task: { taskId: 'FC-2244', status: 'queued' },
      pending: true,
      error: 'Removal failed',
      onClose: vi.fn(),
      onConfirm: vi.fn(),
    }),
  );

  expect(html).toContain('Action failed');
  expect(html).toContain('Removing…');
  expect(html).toContain('animate-spin');
  expect(html).toContain('Active workflow');
});
