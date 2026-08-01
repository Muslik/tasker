import { describe, expect, it } from 'vitest';

import {
  JiraDescriptionRepositoryReferenceSource,
  resolveJiraRepositoryBinding,
} from '../../src/integrations/jira/repository-reference.js';
import { makeJiraSnapshot } from '../helpers/jira.js';
import { makeRepositoryCatalog } from '../helpers/repositories.js';

const resolve = (description: string, intakeFallback?: string) =>
  resolveJiraRepositoryBinding({
    issue: makeJiraSnapshot({ description }),
    intakeFallback,
    previousBinding: null,
    recordedAt: '2026-08-02T00:00:00.000Z',
    catalog: makeRepositoryCatalog(),
    referenceSource: new JiraDescriptionRepositoryReferenceSource(),
  });

describe('Jira repository reference', () => {
  it('uses the Jira description directive before an intake fallback', () => {
    const binding = resolve('h3. Context\nrepo:ui-kit', 'front-avia');

    expect(binding).toMatchObject({
      status: 'resolved',
      source: 'jira_description',
      reference: 'ui-kit',
      repository: { repositoryId: 'ui-kit' },
    });
  });

  it('uses the optional intake repository when Jira has no directive', () => {
    const binding = resolve('h3. Context\nNo repository metadata', 'front-avia');

    expect(binding).toMatchObject({
      status: 'resolved',
      source: 'intake_fallback',
      reference: 'front-avia',
      repository: { repositoryId: 'front-avia' },
    });
  });

  it('stops without guessing when neither source names a repository', () => {
    const binding = resolve('h3. Context\nNo repository metadata');

    expect(binding).toMatchObject({ status: 'missing' });
  });

  it('rejects conflicting Jira directives instead of choosing one', () => {
    const binding = resolve('repo:front-avia\nrepo:ui-kit');

    expect(binding).toMatchObject({
      status: 'invalid',
      source: 'jira_description',
      references: ['front-avia', 'ui-kit'],
    });
  });
});
