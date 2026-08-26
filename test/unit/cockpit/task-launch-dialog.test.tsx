import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { JiraTaskLaunchDialog } from '../../../src/cockpit/App.js';
import { makeJiraSnapshot } from '../../helpers/jira.js';

const repositories = [
  {
    repositoryId: 'front-core-packages',
    remoteUrl: 'ssh://bitbucket.example/front-core-packages.git',
    checkout: { runnerId: 'local', path: '/projects/front-core-packages' },
    checkoutPaths: ['/projects/front-core-packages'],
    aliases: ['front-core-packages', 'onetwotrip/front-core-packages'],
  },
];

const callbacks = {
  onClose: vi.fn(),
  onResolveIssue: vi.fn(() => Promise.reject(new Error('not called during SSR'))),
  onSubmit: vi.fn(() => Promise.resolve()),
};

describe('Jira task launch dialog', () => {
  it('adds a Jira task without exposing start settings by default', () => {
    const html = renderToStaticMarkup(
      createElement(JiraTaskLaunchDialog, {
        open: true,
        repositories,
        pending: false,
        error: null,
        ...callbacks,
      }),
    );

    expect(html).toContain('Add Jira task');
    expect(html).toContain('aria-label="Jira task"');
    expect(html).toContain('Start immediately');
    expect(html).toContain('Working repository');
    expect(html).not.toContain('aria-label="Branch name"');
  });

  it('opens the same modal with the Jira task locked for backlog settings', () => {
    const html = renderToStaticMarkup(
      createElement(JiraTaskLaunchDialog, {
        open: true,
        mode: 'start',
        initialIssue: makeJiraSnapshot({
          issueKey: 'FC-2244',
          summary: 'Fix limiter interceptor',
        }),
        initialRepository: 'front-core-packages',
        repositories,
        pending: false,
        error: null,
        ...callbacks,
      }),
    );

    expect(html).toContain('Task settings');
    expect(html).toContain('disabled="" value="FC-2244"');
    expect(html).toContain('aria-label="Branch name"');
    expect(html).toContain('front-core-packages');
    expect(html).toContain('Update Jira statuses');
    expect(html).toContain('Failure never blocks implementation, evidence, or comments.');
  });
});
