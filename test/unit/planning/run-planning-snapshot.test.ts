import { describe, expect, it } from 'vitest';

import { loadHarnessPack } from '../../../src/harness/index.js';
import { RunPlanningSnapshotSchema } from '../../../src/planning/run-planning-snapshot.js';

const snapshot = () => {
  const pack = loadHarnessPack();
  return {
    schemaVersion: 5,
    taskReference: 'jira:AVIA-12045',
    workflowHash: 'a'.repeat(64),
    task: {
      origin: 'jira',
      fixtureId: 'jira:AVIA-12045',
      taskId: 'AVIA-12045',
      title: 'Payment button spacing',
      description: 'Reproduce and repair the spacing regression.',
      repository: 'onetwotrip/front-avia',
      translationIntent: 'none',
      family: 'short_bugfix',
      reproduction: 'required',
      verification: 'targeted',
      expected: 'accepted',
      proposalVariant: 'valid',
    },
    taskSnapshot: {},
    workflow: {},
    evidenceBundle: {
      artifactId: 'evidence-bundle:jira:AVIA-12045:r1',
      checksum: 'b'.repeat(64),
      revision: 1,
    },
    repository: {
      workspaceId: 'c'.repeat(24),
      reference: 'onetwotrip/front-avia',
      path: '/workspace',
    },
    harness: {
      company: pack.company,
      project: null,
      implementationPlanner: {
        prompt: pack.prompts.implementationPlanner,
        skills: ['jira'],
      },
      policies: [],
      steps: [],
    },
    createdAt: '2026-08-05T13:01:24.687Z',
  };
};

describe('run planning snapshot', () => {
  it('requires the current Docker runtime policy', () => {
    const current = snapshot();
    const company = Object.fromEntries(
      Object.entries(current.harness.company).filter(([key]) => key !== 'workspaceRuntime'),
    );

    expect(
      RunPlanningSnapshotSchema.safeParse({
        ...current,
        harness: { ...current.harness, company },
      }).success,
    ).toBe(false);
  });

  it('rejects snapshots from deleted runtime versions', () => {
    expect(
      RunPlanningSnapshotSchema.safeParse({
        ...snapshot(),
        schemaVersion: 4,
      }).success,
    ).toBe(false);
  });
});
