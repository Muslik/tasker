import { describe, expect, it } from 'vitest';

import { loadHarnessPack } from '../../../src/harness/index.js';
import { RunPlanningSnapshotSchema } from '../../../src/planning/run-planning-snapshot.js';

const snapshot = (schemaVersion: 4 | 5) => {
  const pack = loadHarnessPack();
  return {
    schemaVersion,
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

describe('run planning snapshot compatibility', () => {
  it('reads a version 4 snapshot captured before Docker runtime policy existed', () => {
    const historical = snapshot(4);
    const company = Object.fromEntries(
      Object.entries(historical.harness.company).filter(([key]) => key !== 'workspaceRuntime'),
    );

    expect(
      RunPlanningSnapshotSchema.parse({
        ...historical,
        harness: { ...historical.harness, company },
      }).schemaVersion,
    ).toBe(4);
  });

  it('requires Docker runtime policy in a version 5 snapshot', () => {
    const current = snapshot(5);
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
});
