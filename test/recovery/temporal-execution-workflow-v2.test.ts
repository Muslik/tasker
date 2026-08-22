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
    { kind: 'workspace', reference: `workspace:${taskReference}`, hash: 'c'.repeat(64) },
    { kind: 'planning_snapshot', reference: `planning:${taskReference}`, hash: 'd'.repeat(64) },
    { kind: 'block-snapshot', reference: `blocks:${taskReference}`, hash: 'b'.repeat(64) },
  ],
  graph: {
    metadata: {
      compilerVersion: 4,
      irVersion: 'workflow-ir-v1',
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
    if (
      input.taskReference === 'fixture:continuation' &&
      input.nodeId === 'inspect' &&
      input.blockRun === 1
    ) {
      return Promise.resolve({
        status: 'continuation_required',
        summary: 'Execution discovered a task-scoped workflow change',
        waitKind: 'fixture.inspect@1.continuation-required@1',
        requestReference: 'artifact:continuation-request',
        receiptReference: 'receipt:inspect:1',
      });
    }
    return Promise.resolve({
      status: 'completed',
      summary: `${input.uses} completed`,
      predicateFacts:
        input.uses === 'fixture.inspect@1'
          ? { 'investigation.ready@1': true }
          : input.uses === 'fixture.implement-change@1'
            ? { 'investigation.ready@1': true }
            : { 'repair.done@1': input.blockRun >= 2 },
      receiptReference: `receipt:${input.nodeId}:${String(input.blockRun)}`,
    });
  },
  planExecutionContinuation: (input) => {
    const prefix = `continuation-${String(input.attempt)}--`;
    return Promise.resolve({
      status: 'ready',
      continuationId: `${input.workflowRunId}:continuation-${String(input.attempt)}`,
      attempt: input.attempt,
      parentNodeId: input.parentNodeId,
      requestReference: input.requestReference,
      reason: 'Add the execution work discovered after the frozen graph started',
      evidenceBundle: {
        artifactId: `evidence:${input.workflowRunId}:${String(input.attempt)}`,
        checksum: 'a'.repeat(64),
        revision: input.attempt,
      },
      transcriptOperationId: `${input.workflowRunId}:continuation-${String(input.attempt)}:planner`,
      analyzerReceiptReference: `receipt:${input.workflowRunId}:${String(input.attempt)}`,
      usage: {
        provider: 'codex',
        profile: 'test',
        profileSha256: 'b'.repeat(64),
        model: 'test-model',
        effort: 'low',
        serviceTier: 'fast',
        sessionId: `session-${String(input.attempt)}`,
        durationMs: 10,
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
        apiCost: { source: 'unrated' },
      },
      semanticHash: String(input.attempt).repeat(64),
      workflowHash: input.attempt === 1 ? 'e'.repeat(64) : 'f'.repeat(64),
      graph: {
        metadata: {
          compilerVersion: 4,
          irVersion: 'workflow-ir-v1',
          references: {
            predicates: [],
            stepTypes: ['fixture.implement-change@1'],
            waits: [],
          },
          workflowId: `${input.workflowRunId}:continuation-${String(input.attempt)}`,
          workflowVersion: 1,
        },
        root: {
          kind: 'sequence',
          id: `${prefix}delivery`,
          children: [
            {
              kind: 'step',
              id: `${prefix}implement`,
              uses: 'fixture.implement-change@1',
              activityDelivery: { kind: 'workspace_reconciled' },
              with: {},
            },
            { kind: 'finalize', id: `${prefix}finished`, outcome: 'continued' },
          ],
        },
      },
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
  const workflowIdFor = (taskReference: string): string =>
    `tasker:execution:v2:${taskReference}:test-run`;

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
    workflowId = workflowIdFor(taskReference),
  ): Promise<ExecutionWorkflowPublicState> => {
    await expect
      .poll(
        async () => {
          const result = await runs.read(workflowId);
          if (!result.ok || result.value === null) return 'missing';
          const state = result.value;
          return state.status === 'waiting' ? state.wait.waitKind : state.status;
        },
        { interval: 100, timeout: 10_000 },
      )
      .toBe(waitKind);
    const result = await runs.read(workflowId);
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
    expect(
      await runs.start(workflowIdFor('fixture:first'), workflowInput('fixture:first')),
    ).toMatchObject({ ok: true });
    expect(
      await runs.start(workflowIdFor('fixture:second'), workflowInput('fixture:second')),
    ).toMatchObject({ ok: true });
    expect(
      await runs.start(workflowIdFor('fixture:first'), workflowInput('fixture:first')),
    ).toMatchObject({ ok: true });
    expect(
      await runs.start(workflowIdFor('fixture:first'), {
        ...workflowInput('fixture:first'),
        workflowHash: 'c'.repeat(64),
      }),
    ).toEqual({
      ok: false,
      error: { kind: 'run_input_conflict', workflowId: workflowIdFor('fixture:first') },
    });
    const first = environment.client.workflow.getHandle<typeof executionWorkflowV2>(
      workflowIdFor('fixture:first'),
    );
    const second = environment.client.workflow.getHandle<typeof executionWorkflowV2>(
      workflowIdFor('fixture:second'),
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
      await runs.resolveWait(workflowIdFor('fixture:first'), {
        runId: firstApproval.runId,
        nodeId: 'approval',
        waitKind: 'review.accepted@1',
        resolution: { approved: true },
      }),
    ).toMatchObject({ ok: true });
    await waitFor('fixture:first', 'human.review@1');
    expect(await runs.read(workflowIdFor('fixture:second'))).toMatchObject({
      ok: true,
      value: {
        status: 'waiting',
        wait: { nodeId: 'approval', waitKind: 'review.accepted@1' },
      },
    });

    expect(
      await runs.resolveWait(workflowIdFor('fixture:second'), {
        runId: secondApproval.runId,
        nodeId: 'approval',
        waitKind: 'review.accepted@1',
        resolution: { approved: true },
      }),
    ).toMatchObject({ ok: true });
    await waitFor('fixture:second', 'human.review@1');

    expect(
      await runs.resolveWait(workflowIdFor('fixture:first'), {
        runId: firstApproval.runId,
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

    expect(await runs.read(workflowIdFor('fixture:second'))).toMatchObject({
      ok: true,
      value: {
        status: 'waiting',
        wait: { nodeId: 'human-review', waitKind: 'human.review@1' },
      },
    });
    await secondAfterRestart.cancel();
  }, 30_000);

  it('keeps two execution runs of the same task isolated by workflow identity', async () => {
    const taskReference = 'fixture:same-task';
    const firstWorkflowId = `${workflowIdFor(taskReference)}:run-a`;
    const secondWorkflowId = `${workflowIdFor(taskReference)}:run-b`;
    const input = workflowInput(taskReference);

    expect(await runs.start(firstWorkflowId, input)).toMatchObject({ ok: true });
    expect(await runs.start(secondWorkflowId, input)).toMatchObject({ ok: true });
    const [firstApproval] = await Promise.all([
      waitFor(taskReference, 'review.accepted@1', firstWorkflowId),
      waitFor(taskReference, 'review.accepted@1', secondWorkflowId),
    ]);

    expect(
      await runs.resolveWait(firstWorkflowId, {
        runId: firstApproval.runId,
        nodeId: 'approval',
        waitKind: 'review.accepted@1',
        resolution: { approved: true },
      }),
    ).toMatchObject({ ok: true });
    await waitFor(taskReference, 'human.review@1', firstWorkflowId);
    expect(await runs.read(secondWorkflowId)).toMatchObject({
      ok: true,
      value: {
        status: 'waiting',
        wait: { nodeId: 'approval', waitKind: 'review.accepted@1' },
      },
    });

    await Promise.all([
      environment.client.workflow.getHandle(firstWorkflowId).cancel(),
      environment.client.workflow.getHandle(secondWorkflowId).cancel(),
    ]);
  });

  it('turns an exhausted Activity failure into a resumable operator wait', async () => {
    const taskReference = 'fixture:activity-failure';
    expect(
      await runs.start(workflowIdFor(taskReference), workflowInput(taskReference)),
    ).toMatchObject({ ok: true });

    const failed = await waitFor(taskReference, 'fixture.inspect@1.activity-failed@1');
    expect(failed).toMatchObject({
      status: 'waiting',
      currentNodeId: 'inspect',
      blockRuns: { inspect: 1 },
    });

    expect(
      await runs.resolveWait(workflowIdFor(taskReference), {
        runId: failed.runId,
        nodeId: 'inspect',
        waitKind: 'fixture.inspect@1.activity-failed@1',
        resolution: { decision: 'resume', guidance: 'Retry the preserved execution.' },
      }),
    ).toMatchObject({ ok: true });

    expect(await waitFor(taskReference, 'review.accepted@1')).toMatchObject({
      status: 'waiting',
      blockRuns: { inspect: 2 },
    });
    await environment.client.workflow.getHandle(workflowIdFor(taskReference)).cancel();
  }, 30_000);

  it('replans and accepts a continuation in the same durable run without replaying its parent', async () => {
    const taskReference = 'fixture:continuation';
    const workflowId = workflowIdFor(taskReference);
    expect(await runs.start(workflowId, workflowInput(taskReference))).toMatchObject({ ok: true });

    const firstReview = await waitFor(taskReference, 'workflow_change.review@1');
    expect(firstReview).toMatchObject({
      status: 'waiting',
      blockRuns: { inspect: 1 },
      continuations: [
        {
          attempt: 1,
          parentNodeId: 'inspect',
          status: 'awaiting_review',
        },
      ],
    });
    const firstCandidate = firstReview.continuations[0];
    if (firstCandidate === undefined) throw new Error('First continuation is missing');
    expect(
      await runs.resolveWait(workflowId, {
        runId: firstReview.runId,
        nodeId: 'inspect',
        waitKind: 'workflow_change.review@1',
        resolution: {
          decision: 'reject',
          continuationId: firstCandidate.continuationId,
          guidance: 'Keep the suffix scoped to the discovered implementation change.',
        },
      }),
    ).toMatchObject({ ok: true });

    const secondReview = await waitFor(taskReference, 'workflow_change.review@1');
    expect(secondReview.runId).toBe(firstReview.runId);
    expect(secondReview).toMatchObject({
      blockRuns: { inspect: 1 },
      continuations: [
        { attempt: 1, status: 'rejected' },
        { attempt: 2, status: 'awaiting_review' },
      ],
    });

    worker.shutdown();
    await workerRun;
    await startWorker();
    const secondCandidate = secondReview.continuations[1];
    if (secondCandidate === undefined) throw new Error('Second continuation is missing');
    expect(
      await runs.resolveWait(workflowId, {
        runId: secondReview.runId,
        nodeId: 'inspect',
        waitKind: 'workflow_change.review@1',
        resolution: { decision: 'accept', continuationId: secondCandidate.continuationId },
      }),
    ).toMatchObject({ ok: true });

    const resumed = await waitFor(taskReference, 'review.accepted@1');
    expect(resumed.runId).toBe(firstReview.runId);
    expect(resumed).toMatchObject({
      blockRuns: {
        inspect: 1,
        'continuation-2--implement': 1,
      },
      continuations: [
        { attempt: 1, status: 'rejected' },
        { attempt: 2, status: 'completed' },
      ],
    });
    await environment.client.workflow.getHandle(workflowId).cancel();
  }, 30_000);
});
