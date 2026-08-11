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

const ciWorkflowInput = (taskReference: string): ExecutionWorkflowInput => ({
  schemaVersion: 2,
  taskReference,
  workflowHash: 'c'.repeat(64),
  contextReferences: [
    { kind: 'block-snapshot', reference: `blocks:${taskReference}`, hash: 'd'.repeat(64) },
  ],
  graph: {
    metadata: {
      compilerVersion: 4,
      irVersion: 'm2',
      references: {
        predicates: ['ci.change_failure@1', 'ci.passed@1'],
        stepTypes: ['fixture.ci-observe@1', 'fixture.ci-repair@1'],
        waits: ['ci.manual@1', 'human.review@1', 'operator.guidance@1'],
      },
      workflowId: 'ci-recovery-fixture',
      workflowVersion: 1,
    },
    root: {
      kind: 'sequence',
      id: 'ci-delivery',
      children: [
        {
          kind: 'step',
          id: 'observe-ci',
          uses: 'fixture.ci-observe@1',
          activityDelivery: { kind: 'read_only' },
          with: {},
        },
        {
          kind: 'bounded_loop',
          id: 'ci-recovery-loop',
          maxAttempts: 3,
          until: 'ci.passed@1',
          checkBefore: true,
          exhaustedWait: 'operator.guidance@1',
          body: {
            kind: 'branch',
            id: 'ci-failure-kind',
            when: 'ci.change_failure@1',
            then: {
              kind: 'sequence',
              id: 'repair-ci',
              children: [
                {
                  kind: 'step',
                  id: 'repair-ci-failure',
                  uses: 'fixture.ci-repair@1',
                  activityDelivery: { kind: 'workspace_reconciled' },
                  with: {},
                },
                {
                  kind: 'step',
                  id: 'observe-repaired-ci',
                  uses: 'fixture.ci-observe@1',
                  activityDelivery: { kind: 'read_only' },
                  with: {},
                },
              ],
            },
            otherwise: {
              kind: 'sequence',
              id: 'resume-external-ci',
              children: [
                { kind: 'wait', id: 'wait-for-ci', for: 'ci.manual@1' },
                {
                  kind: 'step',
                  id: 'observe-resumed-ci',
                  uses: 'fixture.ci-observe@1',
                  activityDelivery: { kind: 'read_only' },
                  with: {},
                },
              ],
            },
          },
        },
        { kind: 'wait', id: 'ci-human-review', for: 'human.review@1' },
        { kind: 'finalize', id: 'ci-accepted', outcome: 'accepted' },
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
    if (input.uses === 'fixture.ci-observe@1') {
      const passed = input.taskReference === 'fixture:ci-pass' || input.nodeId !== 'observe-ci';
      return Promise.resolve({
        status: 'completed',
        summary: passed ? 'CI passed' : 'CI failed',
        predicateFacts: {
          'ci.passed@1': passed,
          'ci.change_failure@1': input.taskReference === 'fixture:ci-repair' && !passed,
        },
        receiptReference: `receipt:${input.nodeId}:${String(input.blockRun)}`,
      });
    }
    if (input.uses === 'fixture.ci-repair@1') {
      return Promise.resolve({
        status: 'completed',
        summary: 'CI failure repaired',
        predicateFacts: {},
        receiptReference: `receipt:${input.nodeId}:${String(input.blockRun)}`,
      });
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

  it('skips CI recovery when the first exact-revision observation passes', async () => {
    const taskReference = 'fixture:ci-pass';
    expect(await runs.start(ciWorkflowInput(taskReference))).toMatchObject({ ok: true });

    expect(await waitFor(taskReference, 'human.review@1')).toMatchObject({
      status: 'waiting',
      blockRuns: { 'observe-ci': 1 },
      loopIterations: {},
    });
    await environment.client.workflow.getHandle(`tasker:execution:v2:${taskReference}`).cancel();
  }, 30_000);

  it('repairs task-caused CI failures and re-observes before review', async () => {
    const taskReference = 'fixture:ci-repair';
    expect(await runs.start(ciWorkflowInput(taskReference))).toMatchObject({ ok: true });

    expect(await waitFor(taskReference, 'human.review@1')).toMatchObject({
      status: 'waiting',
      blockRuns: {
        'observe-ci': 1,
        'repair-ci-failure': 1,
        'observe-repaired-ci': 1,
      },
      loopIterations: { 'ci-recovery-loop': 1 },
    });
    await environment.client.workflow.getHandle(`tasker:execution:v2:${taskReference}`).cancel();
  }, 30_000);

  it('durably resumes external CI failures without rerunning completed work', async () => {
    const taskReference = 'fixture:ci-external';
    expect(await runs.start(ciWorkflowInput(taskReference))).toMatchObject({ ok: true });
    expect(await waitFor(taskReference, 'ci.manual@1')).toMatchObject({
      status: 'waiting',
      blockRuns: { 'observe-ci': 1 },
      loopIterations: { 'ci-recovery-loop': 1 },
    });

    expect(
      await runs.resolveWait(taskReference, {
        nodeId: 'wait-for-ci',
        waitKind: 'ci.manual@1',
        resolution: { decision: 'resume' },
      }),
    ).toMatchObject({ ok: true });
    expect(await waitFor(taskReference, 'human.review@1')).toMatchObject({
      status: 'waiting',
      blockRuns: { 'observe-ci': 1, 'observe-resumed-ci': 1 },
    });
    await environment.client.workflow.getHandle(`tasker:execution:v2:${taskReference}`).cancel();
  }, 30_000);
});
