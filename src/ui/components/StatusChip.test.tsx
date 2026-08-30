import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { StatusChip, getStatusChipPresentation } from './StatusChip.js';

describe('StatusChip', () => {
  it('renders the operator status label', () => {
    const html = renderToStaticMarkup(createElement(StatusChip, { status: 'needs_attention' }));

    expect(html).toContain('Needs attention');
    expect(html).toContain('data-status="needs_attention"');
  });

  it('exposes stable presentation metadata', () => {
    const presentation = getStatusChipPresentation('running');

    expect(presentation.label).toBe('Running');
    expect(presentation.className).toContain('sky');
  });
});
