import { describe, expect, it } from 'vitest';

import {
  loadHarnessPack,
  resolveImplementationPlannerProfile,
} from '../../../src/harness/index.js';
import { RunPlanningSnapshotSchema } from '../../../src/planning/run-planning-snapshot.js';

const baseSnapshot = () => {
  const pack = loadHarnessPack();
  return {
    schemaVersion: 10 as const,
    taskReference: 'jira:AVIA-12045',
    workflowRunId: 'run-test',
    task: {
      schemaVersion: 1 as const,
      origin: 'jira',
      reference: 'jira:AVIA-12045',
      taskId: 'AVIA-12045',
      title: 'Payment button spacing',
      description: 'Reproduce and repair the spacing regression.',
      repository: 'onetwotrip/front-avia',
      kind: 'bug' as const,
      labels: ['frontend'],
    },
    taskSnapshot: {},
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
        profiles: {
          fast: resolveImplementationPlannerProfile(pack.company, null, 'fast'),
          ralplan: resolveImplementationPlannerProfile(pack.company, null, 'ralplan'),
        },
      },
      policies: [],
      steps: [],
    },
    harnessHash: 'c'.repeat(64),
    createdAt: '2026-08-05T13:01:24.687Z',
  };
};

describe('run planning snapshot', () => {
  it('separates graph-free planning context from the frozen execution snapshot', () => {
    const context = RunPlanningSnapshotSchema.parse({
      ...baseSnapshot(),
      kind: 'planning_context',
      contextHash: 'a'.repeat(64),
    });
    const execution = RunPlanningSnapshotSchema.parse({
      ...baseSnapshot(),
      kind: 'execution',
      executionStrategy: 'simple',
      semanticHash: 'd'.repeat(64),
      semanticSource: {
        schemaVersion: 1,
        id: 'payment-spacing-workflow',
        version: 1,
        root: {
          kind: 'sequence',
          id: 'task-work',
          children: [
            {
              kind: 'step',
              id: 'verify-change',
              uses: 'verify.acceptance@1',
              with: {},
            },
          ],
        },
      },
      compilerVersion: 'semantic-workflow-v1',
      workflowHash: 'a'.repeat(64),
      workflow: {},
      acceptedPlan: null,
      evidenceBundle: {
        artifactId: 'evidence-bundle:jira:AVIA-12045:r1',
        checksum: 'b'.repeat(64),
        revision: 1,
      },
    });

    expect(context.kind).toBe('planning_context');
    expect('workflow' in context).toBe(false);
    expect(execution.kind).toBe('execution');
    if (execution.kind !== 'execution') throw new Error('Expected execution snapshot');
    expect(execution.workflowHash).toBe('a'.repeat(64));
  });

  it('requires the current Docker runtime policy', () => {
    const current = baseSnapshot();
    const company = Object.fromEntries(
      Object.entries(current.harness.company).filter(([key]) => key !== 'workspaceRuntime'),
    );

    expect(
      RunPlanningSnapshotSchema.safeParse({
        ...current,
        kind: 'planning_context',
        contextHash: 'a'.repeat(64),
        harness: { ...current.harness, company },
      }).success,
    ).toBe(false);
  });

  it('rejects the deleted schema v7 shape', () => {
    expect(
      RunPlanningSnapshotSchema.safeParse({
        ...baseSnapshot(),
        schemaVersion: 7,
        workflowHash: 'a'.repeat(64),
        workflow: {},
      }).success,
    ).toBe(false);
  });
});
