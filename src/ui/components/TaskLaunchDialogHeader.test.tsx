import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { TaskLaunchDialogHeader } from './TaskLaunchDialogHeader.js';

describe('TaskLaunchDialogHeader', () => {
  it('renders the mode-specific title and close affordance', () => {
    const html = renderToStaticMarkup(
      createElement(TaskLaunchDialogHeader, { mode: 'start', pending: false, onClose: vi.fn() }),
    );

    expect(html).toContain('Task settings');
    expect(html).toContain('Review the workspace and planning settings before starting work.');
    expect(html).toContain('×');
  });
});
