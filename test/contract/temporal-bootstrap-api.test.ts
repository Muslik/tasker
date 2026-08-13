import { afterEach, describe, expect, it } from 'vitest';

import { BlockReceiptStore } from '../../src/blocks/index.js';
import { buildOperatorApi, createOperatorWorkflowService } from '../../src/control-plane/index.js';
import { PlanReviewStore } from '../../src/control-plane/plan-review.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { err, ok, type Outcome } from '../../src/shared/outcome.js';
import {
  BootstrapWorkflowInputSchema,
  BootstrapWorkflowPublicStateSchema,
  type BootstrapWorkflowInput,
  type ResolveBootstrapWaitCommand,
  type TaskRunLifecycle,
  type TaskRunError,
  type TaskRunPublicState,
  type TaskRunService,
} from '../../src/temporal/index.js';

const resources: SqliteLedger[] = [];

afterEach(() => {
  for (const ledger of resources.splice(0)) ledger.close();
});

const waitingRun = (input: BootstrapWorkflowInput, runId: string): TaskRunPublicState =>
  BootstrapWorkflowPublicStateSchema.parse({
    runtime: 'bootstrap',
    schemaVersion: 3,
    taskReference: input.taskReference,
    workflowId: `tasker:v3:${input.taskReference}`,
    runId,
    workflowHash: null,
    settings: input.settings,
    phase: 'plan_review',
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
    wait: { nodeId: 'plan_review', waitKind: 'plan.approved@1' },
    outcome: null,
  });

class ContractTaskRunService implements TaskRunService {
  public readonly starts: BootstrapWorkflowInput[] = [];
  public readonly resolutions: ResolveBootstrapWaitCommand[] = [];
  private current: TaskRunPublicState | null = null;
  private sequence = 0;

  public start(inputValue: BootstrapWorkflowInput) {
    const input = BootstrapWorkflowInputSchema.parse(inputValue);
    this.sequence += 1;
    this.starts.push(input);
    this.current = waitingRun(input, `run-${String(this.sequence)}`);
    return Promise.resolve(ok(this.current));
  }

  public read() {
    return Promise.resolve(ok(this.current));
  }

  public readLifecycle() {
    const lifecycle: TaskRunLifecycle | null =
      this.current?.runtime === 'bootstrap' ? { bootstrap: this.current, execution: null } : null;
    return Promise.resolve(ok(lifecycle));
  }

  public restart(
    taskReference: string,
    expectedRunId: string,
  ): Promise<Outcome<TaskRunPublicState, TaskRunError>> {
    if (this.current === null || this.current.taskReference !== taskReference) {
      return Promise.resolve(err({ kind: 'run_not_found' as const, taskReference }));
    }
    if (this.current.runId !== expectedRunId) {
      return Promise.resolve(
        err({
          kind: 'stale_run' as const,
          taskReference,
          providedRunId: expectedRunId,
          activeRunId: this.current.runId,
        }),
      );
    }
    if (this.current.runtime !== 'bootstrap') {
      return Promise.resolve(err({ kind: 'run_not_restartable' as const, taskReference }));
    }
    const settings = this.current.settings;
    this.sequence += 1;
    this.current = waitingRun(
      BootstrapWorkflowInputSchema.parse({ schemaVersion: 3, taskReference, settings }),
      `run-${String(this.sequence)}`,
    );
    return Promise.resolve(ok(this.current));
  }

  public resolveWait(
    taskReference: string,
    command: ResolveBootstrapWaitCommand,
  ): Promise<Outcome<TaskRunPublicState, TaskRunError>> {
    if (this.current === null || this.current.taskReference !== taskReference) {
      return Promise.resolve(err({ kind: 'run_not_found' as const, taskReference }));
    }
    if (this.current.runId !== command.runId) {
      return Promise.resolve(
        err({
          kind: 'stale_run' as const,
          taskReference,
          providedRunId: command.runId,
          activeRunId: this.current.runId,
        }),
      );
    }
    this.resolutions.push(command);
    return Promise.resolve(ok(this.current));
  }
}

const setup = () => {
  const clock = makeAdjustableClock('2026-08-09T00:00:00.000Z');
  const ledger = openSqliteLedger({ filename: ':memory:', clock });
  resources.push(ledger);
  const runs = new ContractTaskRunService();
  const api = buildOperatorApi({
    service: createOperatorWorkflowService(ledger.repository, clock),
    temporalRunService: runs,
    blockReceipts: new BlockReceiptStore(ledger.repository, clock),
    planReviews: new PlanReviewStore(ledger.repository, clock),
  });
  return { api, runs };
};

describe('Temporal bootstrap HTTP contract', () => {
  it('starts a durable run from a neutral task reference', async () => {
    const { api, runs } = setup();
    const response = await api.inject({
      method: 'POST',
      url: '/api/workflows/jira:AVIA-12045/generate',
      payload: { settings: { planReview: 'automatic', planningStrategy: 'fast' } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ taskReference: 'jira:AVIA-12045', runId: 'run-1' });
    expect(runs.starts).toHaveLength(1);
    await api.close();
  });

  it('rejects restart commands for an obsolete run', async () => {
    const { api } = setup();
    await api.inject({ method: 'POST', url: '/api/workflows/jira:AVIA-12045/generate' });
    const stale = await api.inject({
      method: 'POST',
      url: '/api/workflows/jira:AVIA-12045/restart',
      payload: { expectedRunId: 'old-run', confirmation: 'restart_from_scratch' },
    });
    const current = await api.inject({
      method: 'POST',
      url: '/api/workflows/jira:AVIA-12045/restart',
      payload: { expectedRunId: 'run-1', confirmation: 'restart_from_scratch' },
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'stale_run' });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ runId: 'run-2' });
    await api.close();
  });
});
