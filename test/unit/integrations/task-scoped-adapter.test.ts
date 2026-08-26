import { describe, expect, it } from 'vitest';

import { loadHarnessPack } from '../../../src/harness/index.js';
import {
  loadExternalEffectTaskAuthorization,
  TaskScopedIntegrationAdapter,
  type IntegrationStepAdapter,
  type IntegrationStepExecutionRequest,
  type IntegrationStepExecutionResult,
} from '../../../src/integrations/index.js';
import { makePlanningTaskSnapshot } from '../../support/planning.js';

const task = makePlanningTaskSnapshot('avia-12536-feature-review');

const requestFor = (taskReference: string): IntegrationStepExecutionRequest => ({
  operationId: `tasker:test:${taskReference}:publish`,
  nodeId: 'deliver-change',
  stepReference: 'pr.prepare@1',
  taskReference,
  task,
  taskSnapshot: task,
  stepInput: { objective: task.title, repository: task.repository, taskId: task.taskId },
  workspace: {
    schemaVersion: 1,
    workspaceId: 'a'.repeat(24),
    taskReference,
    workflowId: `tasker:${taskReference}`,
    workflowRunId: 'run-1',
    repository: {
      reference: task.repository,
      sourcePath: '/repositories/front-avia',
      baseBranch: 'master',
      baseCommit: 'c'.repeat(40),
    },
    runnerId: 'test',
    path: '/worktrees/front-avia',
    branch: 'tasker/pilot/run-1',
    preparedAt: '2026-08-05T00:00:00.000Z',
  },
  operatorGuidance: null,
  waitResolution: null,
  evidence: { acceptedPlan: null, completedSteps: [], reviewInputs: [] },
  policies: loadHarnessPack().policies,
  project: null,
  trackerStatusUpdates: 'enabled',
  runtime: {
    attempt: 1,
    cancellationSignal: new AbortController().signal,
    heartbeat: () => {},
  },
});

class RecordingAdapter implements IntegrationStepAdapter {
  public readonly id = 'remote.publish@1';
  public calls = 0;

  public execute(): Promise<IntegrationStepExecutionResult> {
    this.calls += 1;
    return Promise.resolve({
      status: 'completed',
      summary: 'Published',
      output: { published: true },
      artifactIds: [],
    });
  }
}

describe('task-scoped integration adapter', () => {
  it('requires an explicit task allowlist when external effects are enabled', () => {
    expect(() => loadExternalEffectTaskAuthorization(true, {})).toThrow(
      'TASKER_EXTERNAL_EFFECT_TASKS',
    );
  });

  it('lets an authorized task reach the external adapter', async () => {
    const delegate = new RecordingAdapter();
    const adapter = new TaskScopedIntegrationAdapter(delegate, new Set(['jira:AVIA-12045']));

    const result = await adapter.execute(requestFor('jira:AVIA-12045'));

    expect(result).toMatchObject({ status: 'completed' });
    expect(delegate.calls).toBe(1);
  });

  it('blocks an unauthorized task before the external adapter', async () => {
    const delegate = new RecordingAdapter();
    const adapter = new TaskScopedIntegrationAdapter(delegate, new Set(['jira:AVIA-12045']));

    const result = await adapter.execute(requestFor('jira:AVIA-12329'));

    expect(result).toMatchObject({
      status: 'blocked',
      kind: 'configuration',
      details: {
        kind: 'task_not_authorized',
        adapter: delegate.id,
        taskReference: 'jira:AVIA-12329',
      },
    });
    expect(delegate.calls).toBe(0);
  });
});
