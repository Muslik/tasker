import { fileURLToPath } from 'node:url';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findTaskFixture, planTaskWorkflow } from '../../src/planning/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import {
  LedgerTemporalRunRegistry,
  stubTaskWorkflowActivities,
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
    settings: { planApproval, planningStrategy: 'auto' },
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
    .poll(
      async () => {
        const state = await requireState(service, taskReference);
        return state.status === 'waiting' ? state.wait.waitKind : state.status;
      },
      { timeout: 5_000, interval: 50 },
    )
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

  const startWorker = async (activities: Partial<TaskWorkflowActivities> = {}): Promise<void> => {
    worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: { ...stubTaskWorkflowActivities, ...activities },
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
      planTaskImplementation: (input) => {
        analyzeAttempts += 1;
        if (analyzeAttempts === 1) throw new Error('transient provider failure');
        return stubTaskWorkflowActivities.planTaskImplementation(input);
      },
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

  it('keeps the run waiting until workspace preparation can resume', async () => {
    const taskReference = `workspace-retry-${String(Date.now())}`;
    let preparationAttempts = 0;
    worker.shutdown();
    await workerRun;
    await startWorker({
      prepareTaskWorkspace: () => {
        preparationAttempts += 1;
        throw new Error('managed repository is temporarily unavailable');
      },
    });

    const started = await service.start(
      workflowInput('avia-13236-short-bug', taskReference, 'automatic'),
    );
    expect(started.ok).toBe(true);
    const blocked = await waitForWait(service, taskReference, 'workspace.retry@1');
    if (blocked.status !== 'waiting') throw new Error('Expected workspace retry wait');
    expect(preparationAttempts).toBe(3);

    worker.shutdown();
    await workerRun;
    await startWorker();
    const resumed = await service.resolveWait(taskReference, {
      nodeId: blocked.wait.nodeId,
      waitKind: 'workspace.retry@1',
      resolution: { decision: 'resume' },
    });
    expect(resumed.ok).toBe(true);
    const review = await waitForWait(service, taskReference, 'code_review@1');

    expect(review.runId).toBe(blocked.runId);
    expect(review.executionContext).toMatchObject({
      status: 'ready',
      workspace: { taskReference, workflowRunId: blocked.runId },
    });
  }, 30_000);

  it('restores planning questions and plan revisions in the same run', async () => {
    const taskReference = `planning-${String(Date.now())}`;
    const commands: {
      readonly commandId: string;
      readonly kind: string;
      readonly snapshotChecksum: string;
    }[] = [];
    const planTaskImplementation: TaskWorkflowActivities['planTaskImplementation'] = async (
      input,
    ) => {
      commands.push({
        commandId: input.commandId,
        kind: input.command.kind,
        snapshotChecksum: input.planningSnapshot.checksum,
      });
      const stub = await stubTaskWorkflowActivities.planTaskImplementation(input);
      const common = {
        commandId: stub.commandId,
        transcriptId: stub.transcriptId,
        attempt: stub.attempt,
        artifactId: stub.artifactId,
        requestedStrategy: stub.requestedStrategy,
        selectedStrategy: stub.selectedStrategy,
        receipt: stub.receipt,
      };
      if (input.command.kind === 'initial') {
        return {
          ...common,
          status: 'needs_clarification',
          questions: [
            {
              id: 'target-browser',
              question: 'Which browsers must be verified?',
              reason: 'The task snapshot does not define the supported browser set.',
            },
          ],
        };
      }
      return {
        ...common,
        status: 'ready',
        attempt: input.command.kind === 'clarification' ? 2 : 3,
        artifactId: `plan:${input.taskReference}:${input.command.kind}`,
      };
    };

    worker.shutdown();
    await workerRun;
    await startWorker({ planTaskImplementation });
    const started = await service.start(
      workflowInput('avia-12536-feature-review', taskReference, 'required'),
    );
    expect(started.ok).toBe(true);

    const clarification = await waitForWait(service, taskReference, 'human_clarification');
    expect(clarification).toMatchObject({
      planning: {
        status: 'needs_clarification',
        attempt: 1,
        questions: [{ id: 'target-browser' }],
      },
    });

    worker.shutdown();
    await workerRun;
    await startWorker({ planTaskImplementation });
    const answered = await service.resolveWait(taskReference, {
      nodeId: 'analyze-task',
      waitKind: 'human_clarification',
      resolution: {
        answers: [{ questionId: 'target-browser', answer: 'Chrome and Safari' }],
      },
    });
    expect(answered.ok).toBe(true);

    const firstReview = await waitForWait(service, taskReference, 'plan.approved@1');
    expect(firstReview.planning).toMatchObject({ status: 'ready', attempt: 2 });
    const revised = await service.resolveWait(taskReference, {
      nodeId: 'review-plan',
      waitKind: 'plan.approved@1',
      resolution: { decision: 'request_changes', guidance: 'Add an explicit rollback check.' },
    });
    expect(revised.ok).toBe(true);

    const secondReview = await waitForWait(service, taskReference, 'plan.approved@1');
    expect(secondReview.planning).toMatchObject({ status: 'ready', attempt: 3 });
    const approved = await service.resolveWait(taskReference, {
      nodeId: 'review-plan',
      waitKind: 'plan.approved@1',
      resolution: { decision: 'approve' },
    });
    expect(approved.ok).toBe(true);
    await waitForWait(service, taskReference, 'code_review@1');

    expect(commands.map((command) => command.kind)).toEqual([
      'initial',
      'clarification',
      'revision',
    ]);
    expect(new Set(commands.map((command) => command.commandId))).toHaveLength(3);
    expect(new Set(commands.map((command) => command.snapshotChecksum))).toEqual(
      new Set(['0'.repeat(64)]),
    );
  }, 30_000);
});
