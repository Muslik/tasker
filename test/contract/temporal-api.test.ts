import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildM1Api,
  createM1WorkflowService,
  OperatorTaskListResponseSchema,
  WorkflowResponseSchema,
} from '../../src/control-plane/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { err, ok } from '../../src/shared/outcome.js';
import {
  type ResolveTaskWaitCommand,
  type StartTaskWorkflowInput,
  type TaskTemporalRunService,
  type TaskWorkflowPublicState,
} from '../../src/temporal/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';

const resources: { readonly directory: string; readonly ledger: SqliteLedger }[] = [];

class ContractTemporalRunService implements TaskTemporalRunService {
  private readonly runs = new Map<string, TaskWorkflowPublicState>();

  public start(input: StartTaskWorkflowInput) {
    const existing = this.runs.get(input.taskReference);
    if (existing !== undefined) return Promise.resolve(ok(existing));

    const wait =
      input.settings.planApproval === 'required'
        ? { nodeId: 'review-plan', waitKind: 'plan.approved@1' }
        : { nodeId: 'wait-for-code-review', waitKind: 'code_review@1' };
    const state: TaskWorkflowPublicState = {
      schemaVersion: 1,
      taskReference: input.taskReference,
      workflowId: `tasker:${input.taskReference}`,
      runId: `run:${input.taskReference}`,
      workflowHash: input.workflowHash,
      settings: input.settings,
      status: 'waiting',
      currentNodeId: wait.nodeId,
      wait,
      outcome: null,
      nodeStates: { [wait.nodeId]: 'waiting' },
      attempts: {},
    };
    this.runs.set(input.taskReference, state);
    return Promise.resolve(ok(state));
  }

  public read(taskReference: string) {
    return Promise.resolve(ok(this.runs.get(taskReference) ?? null));
  }

  public resolveWait(taskReference: string, command: ResolveTaskWaitCommand) {
    const current = this.runs.get(taskReference);
    if (current === undefined) {
      return Promise.resolve(err({ kind: 'run_not_found' as const, taskReference }));
    }
    if (current.status !== 'waiting') {
      return Promise.resolve(
        err({ kind: 'runtime_unavailable' as const, message: 'Workflow is not waiting' }),
      );
    }
    if (current.wait.nodeId !== command.nodeId || current.wait.waitKind !== command.waitKind) {
      return Promise.resolve(
        err({ kind: 'runtime_unavailable' as const, message: 'Wait command does not match' }),
      );
    }

    const state: TaskWorkflowPublicState =
      current.wait.waitKind === 'plan.approved@1'
        ? {
            ...current,
            status: 'waiting',
            currentNodeId: 'wait-for-code-review',
            wait: { nodeId: 'wait-for-code-review', waitKind: 'code_review@1' },
            outcome: null,
            nodeStates: {
              ...current.nodeStates,
              [current.wait.nodeId]: 'succeeded',
              'wait-for-code-review': 'waiting',
            },
          }
        : {
            ...current,
            status: 'completed',
            currentNodeId: null,
            wait: null,
            outcome: 'waiting_for_review',
            nodeStates: {
              ...current.nodeStates,
              [current.wait.nodeId]: 'succeeded',
            },
          };
    this.runs.set(taskReference, state);
    return Promise.resolve(ok(state));
  }
}

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.ledger.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe('Temporal HTTP boundary', () => {
  it('projects and advances only the selected Temporal task', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-temporal-api-'));
    const clock = makeAdjustableClock('2026-08-03T10:00:00.000Z');
    const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
    resources.push({ directory, ledger });
    const workflows = createM1WorkflowService(ledger.repository, clock);
    workflows.generate('avia-13236-short-bug');
    workflows.generate('avia-12536-feature-review');
    const api = buildM1Api({
      service: workflows,
      temporalRunService: new ContractTemporalRunService(),
    });

    const featureStart = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-12536-feature-review/start',
      payload: { settings: { planApproval: 'required', planningStrategy: 'auto' } },
    });
    const bugStart = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/start',
      payload: { settings: { planApproval: 'automatic', planningStrategy: 'auto' } },
    });

    expect(featureStart.json()).toMatchObject({
      status: 'waiting',
      wait: { waitKind: 'plan.approved@1' },
    });
    expect(bugStart.json()).toMatchObject({
      status: 'waiting',
      wait: { waitKind: 'code_review@1' },
    });

    const tasks = OperatorTaskListResponseSchema.parse(
      (await api.inject({ method: 'GET', url: '/api/operator/tasks' })).json(),
    );
    expect(tasks.tasks.find((task) => task.id === 'avia-12536-feature-review')).toMatchObject({
      status: 'plan_review',
    });
    expect(tasks.tasks.find((task) => task.id === 'avia-13236-short-bug')).toMatchObject({
      status: 'code_review',
    });

    const workflow = WorkflowResponseSchema.parse(
      (
        await api.inject({
          method: 'GET',
          url: '/api/workflows/avia-12536-feature-review',
        })
      ).json(),
    );
    const reviewPlan = workflow.view.workflow.tree?.children.find(
      (node) => node.id === 'review-plan',
    );
    expect(reviewPlan?.status).toBe('waiting');

    const approved = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-12536-feature-review/plan-review',
      payload: { decision: 'approve' },
    });
    expect(approved.json()).toMatchObject({
      status: 'waiting',
      wait: { waitKind: 'code_review@1' },
    });

    const completedBug = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/resume',
    });
    expect(completedBug.json()).toMatchObject({ status: 'completed' });

    const featureRun = await api.inject({
      method: 'GET',
      url: '/api/workflows/avia-12536-feature-review/run',
    });
    expect(featureRun.json()).toMatchObject({
      status: 'waiting',
      wait: { waitKind: 'code_review@1' },
    });

    await api.close();
  });
});
