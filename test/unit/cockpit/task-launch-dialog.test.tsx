import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { JiraTaskLaunchDialog } from '../../../src/cockpit/App.js';

describe('Jira task launch dialog', () => {
  it('collects the task, repository, planning, and optional Jira status behavior', () => {
    const html = renderToStaticMarkup(
      createElement(JiraTaskLaunchDialog, {
        open: true,
        repositories: [
          {
            repositoryId: 'front-core-packages',
            remoteUrl: 'ssh://bitbucket.example/front-core-packages.git',
            checkout: { runnerId: 'local', path: '/projects/front-core-packages' },
            checkoutPaths: ['/projects/front-core-packages'],
            aliases: ['front-core-packages', 'onetwotrip/front-core-packages'],
          },
        ],
        pending: false,
        error: null,
        onClose: vi.fn(),
        onSubmit: vi.fn(() => Promise.resolve()),
      }),
    );

    expect(html).toContain('Start Jira task');
    expect(html).toContain('aria-label="Jira task"');
    expect(html).toContain('front-core-packages');
    expect(html).toContain('Update Jira statuses');
    expect(html).toContain('Failure never blocks implementation, evidence, or comments.');
  });
});
