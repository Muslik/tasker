import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { CodeReviewControls } from './CodeReviewControls.js';

it('offers sync and completion controls at the code review wait', () => {
  const html = renderToStaticMarkup(
    createElement(CodeReviewControls, {
      run: { status: 'waiting', wait: { waitKind: 'code_review@1' } },
      notice: null,
      pending: false,
      error: null,
      onSync: vi.fn(),
      onComplete: vi.fn(),
    } as never),
  );
  expect(html).toContain('Sync review');
  expect(html).toContain('Mark done');
});
