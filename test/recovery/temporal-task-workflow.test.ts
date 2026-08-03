import { fileURLToPath } from 'node:url';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findTaskFixture, planTaskWorkflow } from '../../src/planning/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import {
  LedgerTemporalRunRegistry,
  TemporalTaskRunService,
  type TaskWorkflowActivities,
  type TaskWorkflowPublicState,
} from '../../src/temporal/index.js';

const workflowsPath = fileURLToPath(
  new URL('../../src/temporal/workflows/task-workflow.ts', import.meta.url),
);

const workflowInput = (
  fixtureId: string,
  taskReference: string,
  planApproval: 'automatic' | 'required',
) => {
  const fixture = findTaskFixture(fixtureId);
  if (fixture === undefined) throw new Error(`Missing fixture ${fixtureId}`);
  const planned = planTaskWorkflow(fixture);
  if (!planned.ok) throw new Error(`Fixture ${fixtureId} did not compile`);

  return {
    taskReference,
    workflowHash: planned.value.compiled.hash,
    graph: planned.value.compiled.graph,
    settings: { planApproval },
  } as const;
};

const requireState = async (
  service: TemporalTaskRunService,
  taskReference: string,
): Promise<TaskWorkflowPublicState> => {
  const result = await service.read(taskReference);
  if (!result.ok) {
    throw new Error(
      result.error.kind === 'runtime_unavailable'
        ? result.error.message
        : `${result.error.kind}: ${result.error.taskReference}`,
    );
  }
  if (result.value === null) throw new Error(`Missing run ${taskReference}`);
  return result.value;
};

const waitForWait = async (
  service: TemporalTaskRunService,
  taskReference: string,
  waitKind: string,
): Promise<TaskWorkflowPublicState> => {
  await expect
    .poll(async () => {
      const state = await requireState(service, taskReference);
      return state.status === 'waiting' ? state.wait.waitKind : state.status;
    })
    .toBe(waitKind);

  return requireState(service, taskReference);
};

describe('Temporal task workflow', () => {
  let environment: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRun: Promise<void>;
  let service: TemporalTaskRunService;
  let ledger: SqliteLedger;
  let runRegistry: LedgerTemporalRunRegistry;
  const taskQueue = `tasker-test-${String(process.pid)}`;

  const startWorker = async (activities: TaskWorkflowActivities): Promise<void> => {
    worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      activities,
      // The time-skipping test server does not advance sticky-queue timers while
      // the client waits. Disabling the cache exercises replay on every task and
      // lets this test prove recovery without depending on wall-clock fallback.
      maxCachedWorkflows: 0,
    });
    workerRun = worker.run();
  };

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    ledger = openSqliteLedger({ filename: ':memory:' });
    runRegistry = new LedgerTemporalRunRegistry(ledger.repository);
    service = new TemporalTaskRunService(
      environment.client,
      {
        address: 'test-server',
        namespace: 'default',
        taskQueue,
        queryTimeoutMs: 5_000,
        updateTimeoutMs: 5_000,
      },
      runRegistry,
    );
    await startWorker({
      executeStep: (input) =>
        Promise.resolve({
          summary: `${input.uses} completed`,
          predicateResults: { 'attempt.succeeded@1': true },
          artifactIds: [],
        }),
      evaluatePredicate: (input) => Promise.resolve(input.facts[input.reference] ?? true),
    });
  }, 120_000);

  afterAll(async () => {
    worker.shutdown();
    await workerRun;
    await environment.teardown();
    ledger.close();
  });

  it('keeps two task waits independent across a worker replacement', async () => {
    const automaticTask = `automatic-${String(Date.now())}`;
    const reviewedTask = `reviewed-${String(Date.now())}`;

    const [automatic, reviewed] = await Promise.all([
      service.start(workflowInput('avia-13236-short-bug', automaticTask, 'automatic')),
      service.start(workflowInput('avia-12536-feature-review', reviewedTask, 'required')),
    ]);

    expect(automatic.ok).toBe(true);
    expect(reviewed.ok).toBe(true);
    expect(runRegistry.read(automaticTask)).toMatchObject({
      taskReference: automaticTask,
      workflowId: `tasker:${automaticTask}`,
    });
    expect(runRegistry.read(reviewedTask)).toMatchObject({
      taskReference: reviewedTask,
      workflowId: `tasker:${reviewedTask}`,
    });
    const automaticWait = await waitForWait(service, automaticTask, 'code_review@1');
    const planWait = await waitForWait(service, reviewedTask, 'plan.approved@1');
    expect(automaticWait.status).toBe('waiting');
    expect(planWait.status).toBe('waiting');

    worker.shutdown();
    await workerRun;
    await startWorker({
      executeStep: (input) =>
        Promise.resolve({
          summary: `${input.uses} completed after worker replacement`,
          predicateResults: { 'attempt.succeeded@1': true },
          artifactIds: [],
        }),
      evaluatePredicate: (input) => Promise.resolve(input.facts[input.reference] ?? true),
    });

    const approved = await service.resolveWait(reviewedTask, {
      nodeId: 'review-plan',
      waitKind: 'plan.approved@1',
      resolution: { decision: 'approve' },
    });
    expect(approved.ok).toBe(true);
    await waitForWait(service, reviewedTask, 'code_review@1');
    const duplicateApproval = await service.resolveWait(reviewedTask, {
      nodeId: 'review-plan',
      waitKind: 'plan.approved@1',
      resolution: { decision: 'approve' },
    });
    expect(duplicateApproval.ok).toBe(false);

    const completedAutomatic = await service.resolveWait(automaticTask, {
      nodeId: 'wait-for-code-review',
      waitKind: 'code_review@1',
      resolution: { decision: 'done' },
    });
    expect(completedAutomatic.ok).toBe(true);
    await expect
      .poll(async () => (await requireState(service, automaticTask)).status)
      .toBe('completed');

    const stillWaiting = await requireState(service, reviewedTask);
    expect(stillWaiting).toMatchObject({
      status: 'waiting',
      wait: { nodeId: 'wait-for-code-review', waitKind: 'code_review@1' },
    });

    const completedReviewed = await service.resolveWait(reviewedTask, {
      nodeId: 'wait-for-code-review',
      waitKind: 'code_review@1',
      resolution: { decision: 'done' },
    });
    expect(completedReviewed.ok).toBe(true);
    await expect
      .poll(async () => (await requireState(service, reviewedTask)).status)
      .toBe('completed');
  }, 30_000);

  it('retries only the failing Activity boundary', async () => {
    const taskReference = `retry-${String(Date.now())}`;
    let analyzeAttempts = 0;
    worker.shutdown();
    await workerRun;
    await startWorker({
      executeStep: (input) => {
        if (input.nodeId === 'analyze-task') {
          analyzeAttempts += 1;
          if (analyzeAttempts === 1) throw new Error('transient provider failure');
        }
        return Promise.resolve({
          summary: `${input.uses} completed`,
          predicateResults: { 'attempt.succeeded@1': true },
          artifactIds: [],
        });
      },
      evaluatePredicate: (input) => Promise.resolve(input.facts[input.reference] ?? true),
    });

    const started = await service.start(
      workflowInput('avia-13236-short-bug', taskReference, 'automatic'),
    );

    expect(started.ok).toBe(true);
    await waitForWait(service, taskReference, 'code_review@1');
    expect(analyzeAttempts).toBe(2);

    const completed = await service.resolveWait(taskReference, {
      nodeId: 'wait-for-code-review',
      waitKind: 'code_review@1',
      resolution: { decision: 'done' },
    });
    expect(completed.ok).toBe(true);
  }, 30_000);
});
