import { afterEach, describe, expect, it } from 'vitest';

import { BlockReceiptStore } from '../../src/blocks/index.js';
import {
  buildM1Api,
  createM1WorkflowService,
  ExecutionRunViewSchema,
  OperatorTaskListResponseSchema,
} from '../../src/control-plane/index.js';
import { PlanReviewStore } from '../../src/control-plane/plan-review.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { err, ok } from '../../src/shared/outcome.js';
import {
  BootstrapWorkflowInputSchema,
  BootstrapWorkflowPublicStateSchema,
  type BootstrapWorkflowInput,
  type ResolveBootstrapWaitCommand,
  type TaskRunPublicState,
  type TaskRunService,
} from '../../src/temporal/index.js';

const resources: SqliteLedger[] = [];

afterEach(() => {
  for (const ledger of resources.splice(0)) ledger.close();
});

const bootstrapWait = (
  input: BootstrapWorkflowInput,
  waitKind = 'plan.approved@1',
): TaskRunPublicState =>
  BootstrapWorkflowPublicStateSchema.parse({
    runtime: 'bootstrap',
    schemaVersion: 3,
    taskReference: input.taskReference,
    workflowId: `tasker:v3:${input.taskReference}`,
    runId: `run:${input.taskReference}`,
    workflowHash: null,
    settings: input.settings,
    phase: waitKind === 'plan.approved@1' ? 'plan_review' : 'planning',
    workspaceContext: null,
    context: null,
    draft: null,
    planning: null,
    freezeReceipt: null,
    executionWorkflowId: null,
    nodeStates: { plan_review: 'waiting' },
    attempts: { planning: 1 },
    status: 'waiting',
    currentNodeId: 'plan_review',
    wait: { nodeId: 'plan_review', waitKind },
    outcome: null,
  });

class ContractTaskRunService implements TaskRunService {
  public readonly starts: BootstrapWorkflowInput[] = [];
  public readonly restarts: string[] = [];
  public readonly resolutions: ResolveBootstrapWaitCommand[] = [];
  private current: TaskRunPublicState | null = null;

  public start(inputValue: BootstrapWorkflowInput) {
    const input = BootstrapWorkflowInputSchema.parse(inputValue);
    this.starts.push(input);
    this.current = bootstrapWait(input);
    return Promise.resolve(ok(this.current));
  }

  public read() {
    return Promise.resolve(ok(this.current));
  }

  public readLifecycle() {
    return Promise.resolve(
      ok(
        this.current?.runtime === 'bootstrap' ? { bootstrap: this.current, execution: null } : null,
      ),
    );
  }

  public restart(taskReference: string) {
    if (this.current === null || this.current.taskReference !== taskReference) {
      return Promise.resolve(err({ kind: 'run_not_found' as const, taskReference }));
    }
    if (this.current.runtime !== 'bootstrap') {
      return Promise.resolve(err({ kind: 'run_not_restartable' as const, taskReference }));
    }
    this.restarts.push(taskReference);
    const input = BootstrapWorkflowInputSchema.parse({
      schemaVersion: 3,
      taskReference,
      settings: this.current.settings,
    });
    this.current = BootstrapWorkflowPublicStateSchema.parse({
      ...bootstrapWait(input),
      runId: `restarted:${taskReference}`,
    });
    return Promise.resolve(ok(this.current));
  }

  public resolveWait(taskReference: string, command: ResolveBootstrapWaitCommand) {
    if (this.current === null || this.current.taskReference !== taskReference) {
      return Promise.resolve(err({ kind: 'run_not_found' as const, taskReference }));
    }
    this.resolutions.push(command);
    return Promise.resolve(ok(this.current));
  }
}

const setup = () => {
  const clock = makeAdjustableClock('2026-08-09T00:00:00.000Z');
  const ledger = openSqliteLedger({
    filename: ':memory:',
    clock,
  });
  resources.push(ledger);
  const service = createM1WorkflowService(ledger.repository, clock);
  const runs = new ContractTaskRunService();
  const api = buildM1Api({
    service,
    temporalRunService: runs,
    blockReceipts: new BlockReceiptStore(ledger.repository, clock),
    planReviews: new PlanReviewStore(ledger.repository, clock),
  });
  return { api, runs, service };
};

describe('Temporal v3 bootstrap HTTP contract', () => {
  it('starts durable bootstrap without requiring a precompiled graph', async () => {
    const { api, runs } = setup();
    const response = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/generate',
      payload: {
        settings: {
          planReview: 'automatic',
          planningStrategy: 'fast',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(ExecutionRunViewSchema.parse(response.json())).toMatchObject({
      runtime: 'bootstrap',
      schemaVersion: 3,
      status: 'waiting',
    });
    expect(runs.starts).toHaveLength(1);
    expect(runs.starts[0]).toMatchObject({
      schemaVersion: 3,
      settings: {
        planReview: 'automatic',
        planningStrategy: 'fast',
        executionStart: 'automatic',
      },
    });
  });

  it('rejects the removed manual execution gate', async () => {
    const { api, runs } = setup();
    const response = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/generate',
      payload: {
        settings: {
          planReview: 'automatic',
          planningStrategy: 'fast',
          executionStart: 'manual',
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(runs.starts).toHaveLength(0);
  });

  it('restarts an unfinished run only after literal operator confirmation', async () => {
    const { api, runs } = setup();
    await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/generate',
      payload: {
        settings: {
          planReview: 'required',
          planningStrategy: 'fast',
        },
      },
    });

    const unconfirmed = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/restart',
      payload: { confirmation: true },
    });
    const restarted = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/restart',
      payload: { confirmation: 'restart_from_scratch' },
    });

    expect(unconfirmed.statusCode).toBe(400);
    expect(runs.restarts).toEqual(['avia-13236-short-bug']);
    expect(restarted.statusCode).toBe(200);
    expect(ExecutionRunViewSchema.parse(restarted.json())).toMatchObject({
      runtime: 'bootstrap',
      runId: 'restarted:avia-13236-short-bug',
      settings: {
        planReview: 'required',
        planningStrategy: 'fast',
        executionStart: 'automatic',
      },
    });
  });

  it('surfaces a materialized workflow without a Temporal run as operator attention', async () => {
    const { api, service } = setup();
    expect(service.generate('avia-13236-short-bug')).toMatchObject({ ok: true });

    const response = await api.inject({ method: 'GET', url: '/api/operator/tasks' });
    expect(response.statusCode).toBe(200);
    const task = OperatorTaskListResponseSchema.parse(response.json()).tasks.find(
      ({ id }) => id === 'avia-13236-short-bug',
    );
    expect(task).toMatchObject({
      status: 'needs_attention',
      attention: 'operator',
      currentStage: 'Workflow has no active Temporal run',
    });
  });

  it('projects bootstrap progress before an execution graph exists', async () => {
    const { api } = setup();
    await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/generate',
      payload: {
        settings: {
          planReview: 'required',
          planningStrategy: 'fast',
        },
      },
    });

    const response = await api.inject({
      method: 'GET',
      url: '/api/operator/tasks/avia-13236-short-bug/projection',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schemaVersion: 4,
      taskReference: 'avia-13236-short-bug',
      status: 'waiting',
      activeRuntime: 'bootstrap',
      graphHash: null,
      stages: [
        { key: 'bootstrap:workspace:1', label: 'Workspace' },
        { key: 'bootstrap:investigation:2', label: 'Investigate' },
        { key: 'bootstrap:planning:3', label: 'Plan', status: 'waiting' },
      ],
    });
  });

  it('routes plan approval to the active bootstrap wait', async () => {
    const { api, runs } = setup();
    await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/generate',
      payload: {
        settings: {
          planReview: 'required',
          planningStrategy: 'auto',
        },
      },
    });

    const response = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/plan-review',
      payload: {
        decision: 'approve',
        reviewId: 'review-1',
        planArtifactId: 'plan:attempt-1',
        planAttempt: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runs.resolutions).toEqual([
      {
        nodeId: 'plan_review',
        waitKind: 'plan.approved@1',
        resolution: { decision: 'approve' },
      },
    ]);

    const history = await api.inject({
      method: 'GET',
      url: '/api/workflows/avia-13236-short-bug/plan-reviews',
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({
      rounds: [
        {
          reviewId: 'review-1',
          decision: 'approve',
          status: 'applied',
        },
      ],
    });
    await api.close();
  });
});
