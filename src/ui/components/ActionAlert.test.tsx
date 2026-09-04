import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/http.js';
import { ActionAlert } from './ActionAlert.js';

describe('ActionAlert', () => {
  it('renders nothing when there is no action error', () => {
    expect(renderToStaticMarkup(createElement(ActionAlert, { error: null }))).toBe('');
  });

  it('renders mapped copy for known API error codes', () => {
    const html = renderToStaticMarkup(
      createElement(ActionAlert, {
        error: new ApiError(409, 'stale_run', 'Refresh first'),
        known: {
          stale_run: {
            title: 'Task changed',
            message: 'Reload the task before trying this action again.',
          },
        },
      }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('Task changed');
    expect(html).toContain('Reload the task before trying this action again.');
    expect(html).toContain('Код: stale_run');
    expect(html).toContain('data-error-code="stale_run"');
    expect(html).toContain('data-error-status="409"');
  });

  it('renders the fallback title with a generic client error message', () => {
    const html = renderToStaticMarkup(
      createElement(ActionAlert, {
        error: new Error('The server could not be reached'),
      }),
    );

    expect(html).toContain('Action failed');
    expect(html).toContain('The server could not be reached');
  });

  it('shows the server code alongside unknown API error details', () => {
    const html = renderToStaticMarkup(
      createElement(ActionAlert, {
        error: new ApiError(409, 'unknown_action_code', 'The action is no longer valid'),
      }),
    );

    expect(html).toContain('Код: unknown_action_code');
    expect(html).toContain('The action is no longer valid');
  });
});
