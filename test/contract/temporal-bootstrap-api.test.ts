import { afterEach, describe, expect, it } from 'vitest';

import {
  buildM1Api,
  createM1WorkflowService,
  ExecutionRunViewSchema,
} from '../../src/control-plane/index.js';
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

  public resolveWait(taskReference: string, command: ResolveBootstrapWaitCommand) {
    if (this.current === null || this.current.taskReference !== taskReference) {
      return Promise.resolve(err({ kind: 'run_not_found' as const, taskReference }));
    }
    this.resolutions.push(command);
    return Promise.resolve(ok(this.current));
  }
}

const setup = () => {
  const ledger = openSqliteLedger({
    filename: ':memory:',
    clock: makeAdjustableClock('2026-08-09T00:00:00.000Z'),
  });
  resources.push(ledger);
  const service = createM1WorkflowService(
    ledger.repository,
    makeAdjustableClock('2026-08-09T00:00:00.000Z'),
  );
  const runs = new ContractTaskRunService();
  const api = buildM1Api({ service, temporalRunService: runs });
  return { api, runs };
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
          executionStart: 'manual',
        },
      },
    });
    await api.close();

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
        executionStart: 'manual',
      },
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
          executionStart: 'manual',
        },
      },
    });

    const response = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/plan-review',
      payload: { decision: 'approve' },
    });
    await api.close();

    expect(response.statusCode).toBe(200);
    expect(runs.resolutions).toEqual([
      {
        nodeId: 'plan_review',
        waitKind: 'plan.approved@1',
        resolution: { decision: 'approve' },
      },
    ]);
  });
});
