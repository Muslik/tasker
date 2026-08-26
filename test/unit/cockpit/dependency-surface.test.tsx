import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { DependencyWaitSurface, TaskDependencyPanel } from '../../../src/cockpit/App.js';

describe('dependency cockpit surfaces', () => {
  it('renders the published versions surface for dependency.available@1', () => {
    const html = renderToStaticMarkup(
      createElement(DependencyWaitSurface, {
        details: {
          kind: 'dependency_available',
          declarationId: 'dependency-declaration:runtime-discovery:artifact:1:jira:AVIA-12045',
          declarationRevision: 2,
          channel: 'final',
          packages: ['@ott/fare-card'],
          observation: {
            status: 'missing',
            observationId: null,
            observedAt: null,
            provenance: null,
            packages: [],
          },
        },
        pending: false,
        restartConfirming: false,
        versions: new Map([['@ott/fare-card', '1.2.3']]),
        provenance: { postId: '', url: '' },
        discoveryDraft: {
          producerTaskReference: '',
          producerRepository: '',
          packages: '',
          mode: 'final_only',
          linkId: '',
          linkTypeId: '',
          direction: 'outward',
        },
        onVersionChange: vi.fn(),
        onProvenanceChange: vi.fn(),
        onDiscoveryDraftChange: vi.fn(),
        onSubmit: vi.fn(),
        onRestartRequest: vi.fn(),
        onRestartCancel: vi.fn(),
        onRestartConfirm: vi.fn(),
      }),
    );

    expect(html).toContain('Published versions');
    expect(html).toContain('Loop post ID');
    expect(html).toContain('Verify published versions');
  });

  it('renders the task dependency panel with saved declarations', () => {
    const html = renderToStaticMarkup(
      createElement(TaskDependencyPanel, {
        dependencies: [
          {
            declarationId: 'dependency-declaration:jira-link:118870:jira:AVIA-12045',
            revision: 1,
            producerTaskReference: 'jira:AVIA-11999',
            producerRepository: 'front-core-packages',
            packages: ['@ott/fare-card'],
            mode: 'final_only',
            source: {
              kind: 'jira_link',
              linkId: '118870',
              linkTypeId: '10016',
              direction: 'outward',
            },
            createdAt: '2026-08-25T10:00:00.000Z',
          },
        ],
      }),
    );

    expect(html).toContain('Package dependencies');
    expect(html).toContain('@ott/fare-card from AVIA-11999');
    expect(html).toContain('front-core-packages');
    expect(html).toContain('Exact version');
    expect(html).not.toContain('Release validation');
    expect(html).not.toContain('dependency-declaration:');
    expect(html).not.toContain('Producer task reference');
  });

  it('hides package dependency controls until a declaration exists', () => {
    const html = renderToStaticMarkup(
      createElement(TaskDependencyPanel, {
        dependencies: [],
      }),
    );

    expect(html).toBe('');
  });
});
