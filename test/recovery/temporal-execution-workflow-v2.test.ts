import { fileURLToPath } from 'node:url';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  ExecutionWorkflowActivities,
  ExecutionWorkflowInput,
  ExecutionWorkflowPublicState,
} from '../../src/temporal/execution-kernel/contracts.js';
import { TemporalExecutionRunService } from '../../src/temporal/execution-kernel/client.js';
import type { executionWorkflowV2 } from '../../src/temporal/workflows/execution-workflow-v2.js';

const workflowsPath = fileURLToPath(
  new URL('../../src/temporal/workflows/execution-workflow-v2.ts', import.meta.url),
);

const workflowInput = (taskReference: string): ExecutionWorkflowInput => ({
  schemaVersion: 2,
  taskReference,
  workflowHash: 'a'.repeat(64),
  contextReferences: [
    { kind: 'block-snapshot', reference: `blocks:${taskReference}`, hash: 'b'.repeat(64) },
  ],
  graph: {
    metadata: {
      compilerVersion: 4,
      irVersion: 'm2',
      references: {
        predicates: ['investigation.ready@1', 'repair.done@1', 'review.accepted@1'],
        stepTypes: ['fixture.inspect@1', 'fixture.repair@1'],
        waits: ['human.review@1'],
      },
      workflowId: 'execution-kernel-fixture',
      workflowVersion: 1,
    },
    root: {
      kind: 'sequence',
      id: 'delivery',
      children: [
        {
          kind: 'step',
          id: 'inspect',
          uses: 'fixture.inspect@1',
          activityDelivery: { kind: 'read_only' },
          with: {},
        },
        {
          kind: 'bounded_loop',
          id: 'repair-loop',
          maxAttempts: 3,
          until: 'repair.done@1',
          checkBefore: false,
          body: {
            kind: 'step',
            id: 'repair',
            uses: 'fixture.repair@1',
            activityDelivery: { kind: 'workspace_reconciled' },
            with: {},
          },
        },
        {
          kind: 'branch',
          id: 'admission',
          when: 'investigation.ready@1',
          then: {
            kind: 'sequence',
            id: 'review-path',
            children: [
              {
                kind: 'gate',
                id: 'approval',
                reason: 'Operator approval is required by this fixture',
                resumeWhen: 'review.accepted@1',
              },
              {
                kind: 'wait',
                id: 'human-review',
                for: 'human.review@1',
                resolutionMapping: {
                  discriminator: 'decision',
                  cases: { approved: { 'review.accepted@1': true } },
                },
              },
            ],
          },
          otherwise: { kind: 'finalize', id: 'rejected', outcome: 'rejected' },
        },
        { kind: 'finalize', id: 'accepted', outcome: 'accepted' },
      ],
    },
  },
});

const activities: ExecutionWorkflowActivities = {
  runExecutionBlock: (input) => {
    if (
      input.taskReference === 'fixture:activity-failure' &&
      input.nodeId === 'inspect' &&
      input.blockRun === 1
    ) {
      return Promise.reject(new Error('receipt persistence failed'));
    }
    return Promise.resolve({
      status: 'completed',
      summary: `${input.uses} completed`,
      predicateFacts:
        input.uses === 'fixture.inspect@1'
          ? { 'investigation.ready@1': true }
          : { 'repair.done@1': input.blockRun >= 2 },
      receiptReference: `receipt:${input.nodeId}:${String(input.blockRun)}`,
    });
  },
  evaluateExecutionPredicate: (input) => Promise.resolve(input.facts[input.reference] ?? false),
};

describe('Execution Workflow v2 recovery', () => {
  let environment: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRun: Promise<void>;
  let runs: TemporalExecutionRunService;
  const taskQueue = `tasker-execution-v2-${String(process.pid)}`;

  const startWorker = async (): Promise<void> => {
    worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      activities,
      maxCachedWorkflows: 0,
    });
    workerRun = worker.run();
  };

  const waitFor = async (
    taskReference: string,
    waitKind: string,
  ): Promise<ExecutionWorkflowPublicState> => {
    await expect
      .poll(
        async () => {
          const result = await runs.read(taskReference);
          if (!result.ok || result.value === null) return 'missing';
          const state = result.value;
          return state.status === 'waiting' ? state.wait.waitKind : state.status;
        },
        { interval: 100, timeout: 10_000 },
      )
      .toBe(waitKind);
    const result = await runs.read(taskReference);
    if (!result.ok || result.value === null) throw new Error('Execution run is unavailable');
    return result.value;
  };

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    runs = new TemporalExecutionRunService(environment.client, {
      taskQueue,
      queryTimeoutMs: 2_000,
      updateTimeoutMs: 10_000,
    });
    await startWorker();
  }, 120_000);

  afterAll(async () => {
    worker.shutdown();
    await workerRun;
    await environment.teardown();
  });

  it('keeps frozen graph progress and two waits independent across worker replacement', async () => {
    expect(await runs.start(workflowInput('fixture:first'))).toMatchObject({ ok: true });
    expect(await runs.start(workflowInput('fixture:second'))).toMatchObject({ ok: true });
    expect(await runs.start(workflowInput('fixture:first'))).toMatchObject({ ok: true });
    expect(
      await runs.start({ ...workflowInput('fixture:first'), workflowHash: 'c'.repeat(64) }),
    ).toEqual({
      ok: false,
      error: { kind: 'run_input_conflict', taskReference: 'fixture:first' },
    });
    const first = environment.client.workflow.getHandle<typeof executionWorkflowV2>(
      'tasker:execution:v2:fixture:first',
    );
    const second = environment.client.workflow.getHandle<typeof executionWorkflowV2>(
      'tasker:execution:v2:fixture:second',
    );
    const [firstApproval, secondApproval] = await Promise.all([
      waitFor('fixture:first', 'review.accepted@1'),
      waitFor('fixture:second', 'review.accepted@1'),
    ]);
    expect(firstApproval).toMatchObject({
      status: 'waiting',
      loopIterations: { 'repair-loop': 2 },
      blockRuns: { repair: 2 },
    });
    expect(secondApproval).toMatchObject({ status: 'waiting' });

    worker.shutdown();
    await workerRun;
    await startWorker();
    const firstAfterRestart = environment.client.workflow.getHandle(first.workflowId);
    const secondAfterRestart = environment.client.workflow.getHandle(second.workflowId);

    expect(
      await runs.resolveWait('fixture:first', {
        nodeId: 'approval',
        waitKind: 'review.accepted@1',
        resolution: { approved: true },
      }),
    ).toMatchObject({ ok: true });
    await waitFor('fixture:first', 'human.review@1');
    expect(await runs.read('fixture:second')).toMatchObject({
      ok: true,
      value: {
        status: 'waiting',
        wait: { nodeId: 'approval', waitKind: 'review.accepted@1' },
      },
    });

    expect(
      await runs.resolveWait('fixture:second', {
        nodeId: 'approval',
        waitKind: 'review.accepted@1',
        resolution: { approved: true },
      }),
    ).toMatchObject({ ok: true });
    await waitFor('fixture:second', 'human.review@1');

    expect(
      await runs.resolveWait('fixture:first', {
        nodeId: 'human-review',
        waitKind: 'human.review@1',
        resolution: { decision: 'approved' },
      }),
    ).toMatchObject({ ok: true });
    await expect(firstAfterRestart.result()).resolves.toEqual({
      taskReference: 'fixture:first',
      workflowHash: 'a'.repeat(64),
      outcome: 'accepted',
    });

    expect(await runs.read('fixture:second')).toMatchObject({
      ok: true,
      value: {
        status: 'waiting',
        wait: { nodeId: 'human-review', waitKind: 'human.review@1' },
      },
    });
    await secondAfterRestart.cancel();
  }, 30_000);

  it('turns an exhausted Activity failure into a resumable operator wait', async () => {
    const taskReference = 'fixture:activity-failure';
    expect(await runs.start(workflowInput(taskReference))).toMatchObject({ ok: true });

    expect(await waitFor(taskReference, 'fixture.inspect@1.activity-failed@1')).toMatchObject({
      status: 'waiting',
      currentNodeId: 'inspect',
      blockRuns: { inspect: 1 },
    });

    expect(
      await runs.resolveWait(taskReference, {
        nodeId: 'inspect',
        waitKind: 'fixture.inspect@1.activity-failed@1',
        resolution: { decision: 'resume', guidance: 'Retry the preserved execution.' },
      }),
    ).toMatchObject({ ok: true });

    expect(await waitFor(taskReference, 'review.accepted@1')).toMatchObject({
      status: 'waiting',
      blockRuns: { inspect: 2 },
    });
    await environment.client.workflow
      .getHandle('tasker:execution:v2:fixture:activity-failure')
      .cancel();
  }, 30_000);
});
