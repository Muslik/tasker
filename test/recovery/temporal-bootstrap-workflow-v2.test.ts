import { fileURLToPath } from 'node:url';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BootstrapWorkflowInput } from '../../src/temporal/bootstrap-kernel/contracts.js';
import { TemporalTaskRunService, type TaskRunPublicState } from '../../src/temporal/client.js';
import { testTemporalV2Activities } from '../helpers/temporal-v2-activities.js';

const workflowsPath = fileURLToPath(
  new URL('../../src/temporal/workflows/index.ts', import.meta.url),
);

const inputFor = (
  taskReference: string,
  planReview: 'required' | 'automatic',
): BootstrapWorkflowInput => ({
  schemaVersion: 2,
  taskReference,
  workflowHash: 'a'.repeat(64),
  settings: { planReview, planningStrategy: 'fast' },
  graph: {
    metadata: {
      compilerVersion: 4,
      irVersion: 'm2',
      workflowId: 'bootstrap-v2-fixture',
      workflowVersion: 1,
      references: {
        predicates: ['review.completed@1'],
        stepTypes: ['fixture.implement@1'],
        waits: ['code_review@1'],
      },
    },
    root: {
      kind: 'sequence',
      id: 'delivery',
      children: [
        {
          kind: 'step',
          id: 'implement',
          uses: 'fixture.implement@1',
          activityDelivery: { kind: 'workspace_reconciled' },
          with: {},
        },
        {
          kind: 'wait',
          id: 'code-review',
          for: 'code_review@1',
          resolutionMapping: {
            discriminator: 'decision',
            cases: { approved: { 'review.completed@1': true } },
          },
        },
        { kind: 'finalize', id: 'accepted', outcome: 'accepted' },
      ],
    },
  },
});

describe('Bootstrap Workflow v2 recovery', () => {
  let environment: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRun: Promise<void>;
  let runs: TemporalTaskRunService;
  const taskQueue = `tasker-bootstrap-v2-${String(process.pid)}`;

  const startWorker = async (): Promise<void> => {
    worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: testTemporalV2Activities,
      maxCachedWorkflows: 0,
    });
    workerRun = worker.run();
  };

  const waitFor = async (taskReference: string, waitKind: string): Promise<TaskRunPublicState> => {
    await expect
      .poll(
        async () => {
          const result = await runs.read(taskReference);
          if (!result.ok || result.value === null) return 'missing';
          return result.value.status === 'waiting'
            ? result.value.wait.waitKind
            : result.value.status;
        },
        { interval: 50, timeout: 20_000 },
      )
      .toBe(waitKind);
    const result = await runs.read(taskReference);
    if (!result.ok || result.value === null) throw new Error('Run is unavailable');
    return result.value;
  };

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    runs = new TemporalTaskRunService(environment.client, {
      address: 'test-server',
      namespace: 'default',
      taskQueue,
      queryTimeoutMs: 5_000,
      updateTimeoutMs: 5_000,
    });
    await startWorker();
  }, 120_000);

  afterAll(async () => {
    worker.shutdown();
    await workerRun;
    await environment.teardown();
  });

  it('keeps bootstrap review and execution review durable across worker replacement', async () => {
    const duplicate = await runs.start(inputFor('fixture:reviewed', 'required'));
    if (!duplicate.ok) throw new Error(JSON.stringify(duplicate.error));
    expect(await runs.start(inputFor('fixture:automatic', 'automatic'))).toMatchObject({
      ok: true,
    });
    const idempotent = await runs.start(inputFor('fixture:reviewed', 'required'));
    if (!idempotent.ok) throw new Error(JSON.stringify(idempotent.error));
    expect(
      await runs.start({
        ...inputFor('fixture:reviewed', 'required'),
        settings: { planReview: 'automatic', planningStrategy: 'fast' },
      }),
    ).toEqual({
      ok: false,
      error: { kind: 'run_input_conflict', taskReference: 'fixture:reviewed' },
    });

    const planReview = await waitFor('fixture:reviewed', 'plan.approved@1');
    expect(planReview.runtime).toBe('bootstrap');
    const automaticReview = await waitFor('fixture:automatic', 'code_review@1');
    expect(automaticReview.runtime).toBe('execution');

    worker.shutdown();
    await workerRun;
    await startWorker();

    expect(
      await runs.resolveWait('fixture:reviewed', {
        nodeId: 'plan_review',
        waitKind: 'plan.approved@1',
        resolution: { decision: 'approve' },
      }),
    ).toMatchObject({ ok: true });
    await waitFor('fixture:reviewed', 'code_review@1');

    expect(
      await runs.resolveWait('fixture:automatic', {
        nodeId: 'code-review',
        waitKind: 'code_review@1',
        resolution: { decision: 'approved' },
      }),
    ).toMatchObject({ ok: true });
    await expect
      .poll(
        async () => {
          const result = await runs.read('fixture:automatic');
          return result.ok && result.value !== null ? result.value.status : 'missing';
        },
        { interval: 50, timeout: 20_000 },
      )
      .toBe('completed');
  }, 60_000);
});
