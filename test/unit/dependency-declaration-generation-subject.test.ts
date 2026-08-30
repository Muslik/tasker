import { describe, expect, it } from 'vitest';

import { DependencyDeclarationGenerationSubjectResolver } from '../../src/server/dependency-declaration-generation-subject.js';
import { err, ok } from '../../src/shared/outcome.js';
import { makePlanningTaskSnapshot } from '../support/planning.js';

const taskReference = 'jira:AVIA-500';

const baseSubject = {
  schemaVersion: 1 as const,
  repositoryPath: '/managed/front-avia',
  task: makePlanningTaskSnapshot('avia-13236-short-bug', {
    reference: taskReference,
    taskId: 'AVIA-500',
  }),
  taskSnapshot: {
    origin: 'jira',
    issue: {
      issueKey: 'AVIA-500',
    },
  },
};

describe('DependencyDeclarationGenerationSubjectResolver', () => {
  it('adds latest dependency declarations to the task snapshot evidence', () => {
    const resolver = new DependencyDeclarationGenerationSubjectResolver(
      { resolve: () => ok(baseSubject) },
      {
        listLatestByConsumerTask: () =>
          ok([
            {
              schemaVersion: 1,
              declarationId: 'dependency-declaration:jira-link:118870:jira:AVIA-500',
              revision: 2,
              hash: 'a'.repeat(64),
              createdAt: '2026-08-25T08:00:00.000Z',
              consumerTaskReference: taskReference,
              producerTaskReference: 'jira:AVIA-400',
              producerRepository: 'onetwotrip/front-core-packages',
              packages: ['@ott/core-button', '@ott/core-theme'],
              mode: 'validate_dev_then_final',
              source: {
                kind: 'jira_link' as const,
                linkId: '118870',
                linkTypeId: '10016',
                direction: 'outward' as const,
              },
            },
          ]),
      },
    );

    const resolved = resolver.resolve(taskReference);

    expect(resolved).toEqual({
      ok: true,
      value: {
        ...baseSubject,
        taskSnapshot: {
          ...baseSubject.taskSnapshot,
          dependencyDeclarations: [
            {
              declarationId: 'dependency-declaration:jira-link:118870:jira:AVIA-500',
              revision: 2,
              hash: 'a'.repeat(64),
              producerTaskReference: 'jira:AVIA-400',
              producerRepository: 'onetwotrip/front-core-packages',
              packages: ['@ott/core-button', '@ott/core-theme'],
              mode: 'validate_dev_then_final',
              source: {
                kind: 'jira_link',
                linkId: '118870',
                linkTypeId: '10016',
                direction: 'outward',
              },
            },
          ],
        },
      },
    });
  });

  it('preserves the original task snapshot when no declarations exist', () => {
    const resolver = new DependencyDeclarationGenerationSubjectResolver(
      { resolve: () => ok(baseSubject) },
      {
        listLatestByConsumerTask: () => ok([]),
      },
    );

    const resolved = resolver.resolve(taskReference);

    expect(resolved).toEqual({ ok: true, value: baseSubject });
  });

  it('blocks subject generation when declaration lookup fails', () => {
    const resolver = new DependencyDeclarationGenerationSubjectResolver(
      { resolve: () => ok(baseSubject) },
      {
        listLatestByConsumerTask: () =>
          err({
            kind: 'record_corrupt',
            recordId: 'dependency-declaration:broken',
            issues: ['schemaVersion: Invalid input'],
          }),
      },
    );

    const resolved = resolver.resolve(taskReference);

    expect(resolved).toEqual({
      ok: false,
      error: {
        kind: 'generation_blocked',
        taskReference,
        reason: 'Dependency declarations are unavailable: record_corrupt',
      },
    });
  });
});
