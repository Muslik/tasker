import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { DependencyWaitSurface, parsePackageNames } from './DependencyWaitSurface.js';

describe('dependency waits', () => {
  it('renders exact package versions and optional provenance', () => {
    const action = {
      kind: 'typed_resolution',
      waitKind: 'dependency.available@1',
      details: {
        kind: 'dependency_available',
        declarationId: 'declaration',
        declarationRevision: 1,
        channel: 'final',
        packages: ['@scope/package'],
        observation: {
          status: 'missing',
          observationId: null,
          observedAt: null,
          provenance: null,
          packages: [],
        },
      },
    };
    const html = renderToStaticMarkup(
      createElement(DependencyWaitSurface, {
        action,
        pending: false,
        error: null,
        onAvailable: vi.fn(),
        onDiscovery: vi.fn(),
      } as never),
    );
    expect(html).toContain('Published versions');
    expect(html).toContain('Loop post ID');
    expect(parsePackageNames('@a/x, @b/y\n@c/z')).toEqual(['@a/x', '@b/y', '@c/z']);
  });
});
