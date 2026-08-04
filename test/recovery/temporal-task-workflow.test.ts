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
import { testTaskWorkflowActivities } from '../helpers/temporal-activities.js';
import { JsonValueSchema } from '../../src/workflow/index.js';

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
      activities: { ...testTaskWorkflowActivities, ...activities },
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
          status: 'completed',
          summary: `${input.uses} completed`,
          predicateResults: { 'attempt.succeeded@1': true },
          artifactIds: [],
          transcriptId: null,
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
          status: 'completed',
          summary: `${input.uses} completed after worker replacement`,
          predicateResults: { 'attempt.succeeded@1': true },
          artifactIds: [],
          transcriptId: null,
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
      resolution: { decision: 'approved', reviewId: 'review:automatic:approved' },
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
      resolution: { decision: 'approved', reviewId: 'review:reviewed:approved' },
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
        return testTaskWorkflowActivities.planTaskImplementation(input);
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
      resolution: { decision: 'approved', reviewId: 'review:retry:approved' },
    });
    expect(completed.ok).toBe(true);
  }, 30_000);

  it('redelivers a remote-reconciled step without repeating completed workspace steps', async () => {
    const taskReference = `remote-effect-retry-${String(Date.now())}`;
    const workspaceCalls = new Map<string, number>();
    let pullRequestDeliveries = 0;
    worker.shutdown();
    await workerRun;
    await startWorker({
      executeWorkspaceReconciledStep: (input) => {
        workspaceCalls.set(input.nodeId, (workspaceCalls.get(input.nodeId) ?? 0) + 1);
        return testTaskWorkflowActivities.executeWorkspaceReconciledStep(input);
      },
      executeRemoteReconciledStep: (input) => {
        pullRequestDeliveries += 1;
        if (pullRequestDeliveries === 1) {
          throw new Error('worker stopped after the remote request');
        }
        return testTaskWorkflowActivities.executeRemoteReconciledStep(input);
      },
    });

    const started = await service.start(
      workflowInput('avia-13236-short-bug', taskReference, 'automatic'),
    );

    expect(started.ok).toBe(true);
    await waitForWait(service, taskReference, 'code_review@1');
    expect(pullRequestDeliveries).toBe(2);
    expect([...workspaceCalls.values()]).toEqual([...workspaceCalls.values()].map(() => 1));
    expect([...workspaceCalls.keys()]).toContain('implement-fix');
  }, 30_000);

  it('redelivers a read-only CI observation after Worker failure', async () => {
    const taskReference = `ci-observation-retry-${String(Date.now())}`;
    let ciDeliveries = 0;
    worker.shutdown();
    await workerRun;
    await startWorker({
      executeReadOnlyStep: (input) => {
        ciDeliveries += 1;
        if (ciDeliveries === 1) throw new Error('worker stopped while reading Jenkins');
        return testTaskWorkflowActivities.executeReadOnlyStep(input);
      },
    });

    const started = await service.start(
      workflowInput('avia-13236-short-bug', taskReference, 'automatic'),
    );

    expect(started.ok).toBe(true);
    await waitForWait(service, taskReference, 'code_review@1');
    expect(ciDeliveries).toBe(2);
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
      const stub = await testTaskWorkflowActivities.planTaskImplementation(input);
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

  it('revises from review evidence and asks for guidance after the bounded budget', async () => {
    const taskReference = `review-revision-${String(Date.now())}`;
    const approvedTaskReference = `review-approved-${String(Date.now())}`;
    const executions: { uses: string; operatorGuidance: string | null }[] = [];
    const executeRecorded: TaskWorkflowActivities['executeStep'] = async (input) => {
      executions.push({ uses: input.uses, operatorGuidance: input.operatorGuidance });
      return testTaskWorkflowActivities.executeStep(input);
    };

    worker.shutdown();
    await workerRun;
    await startWorker({
      executeStep: executeRecorded,
      executeReadOnlyStep: executeRecorded,
      executeWorkspaceReconciledStep: executeRecorded,
      executeRemoteReconciledStep: executeRecorded,
    });

    const approvalOnly = await service.start(
      workflowInput('avia-13236-short-bug', approvedTaskReference, 'automatic'),
    );
    expect(approvalOnly.ok).toBe(true);
    const initialApproval = await waitForWait(service, approvedTaskReference, 'code_review@1');
    if (initialApproval.status !== 'waiting') throw new Error('Expected initial review wait');
    const approvalResolution = await service.resolveWait(approvedTaskReference, {
      nodeId: initialApproval.wait.nodeId,
      waitKind: initialApproval.wait.waitKind,
      resolution: { decision: 'approved', reviewId: 'review:approval-only' },
    });
    expect(approvalResolution.ok).toBe(true);
    await expect
      .poll(async () => (await requireState(service, approvedTaskReference)).status)
      .toBe('completed');
    expect(executions.some(({ uses }) => uses === 'review.revise@1')).toBe(false);
    executions.length = 0;

    const started = await service.start(
      workflowInput('avia-13236-short-bug', taskReference, 'automatic'),
    );
    expect(started.ok).toBe(true);

    const resolveReview = async (reviewId: string): Promise<void> => {
      const review = await waitForWait(service, taskReference, 'code_review@1');
      if (review.status !== 'waiting') throw new Error('Expected code review wait');
      const resolved = await service.resolveWait(taskReference, {
        nodeId: review.wait.nodeId,
        waitKind: review.wait.waitKind,
        resolution: { decision: 'changes_requested', reviewId },
      });
      expect(resolved.ok).toBe(true);
    };

    await resolveReview('review:initial');
    await resolveReview('review:revision:1');
    await resolveReview('review:revision:2');
    await resolveReview('review:revision:3');

    const exhausted = await waitForWait(service, taskReference, 'operator_guidance@1');
    expect(executions.filter(({ uses }) => uses === 'review.revise@1')).toHaveLength(3);
    if (exhausted.status !== 'waiting') throw new Error('Expected operator guidance wait');
    const resumed = await service.resolveWait(taskReference, {
      nodeId: exhausted.wait.nodeId,
      waitKind: exhausted.wait.waitKind,
      resolution: {
        decision: 'resume',
        guidance: 'The comments refer to the generated fallback; update that source first.',
      },
    });
    expect(resumed.ok).toBe(true);

    const finalReview = await waitForWait(service, taskReference, 'code_review@1');
    expect(executions.filter(({ uses }) => uses === 'review.revise@1')).toHaveLength(4);
    expect(executions).toContainEqual({
      uses: 'review.revise@1',
      operatorGuidance: 'The comments refer to the generated fallback; update that source first.',
    });
    expect(executions.filter(({ uses }) => uses === 'pr.prepare@1')).toHaveLength(5);
    expect(executions.filter(({ uses }) => uses === 'ci.observe@1')).toHaveLength(5);
    expect(executions.filter(({ uses }) => uses === 'review.acknowledge@1')).toHaveLength(4);

    if (finalReview.status !== 'waiting') throw new Error('Expected final review wait');
    const approved = await service.resolveWait(taskReference, {
      nodeId: finalReview.wait.nodeId,
      waitKind: finalReview.wait.waitKind,
      resolution: { decision: 'approved', reviewId: 'review:final:approved' },
    });
    expect(approved.ok).toBe(true);
    await expect
      .poll(async () => (await requireState(service, taskReference)).status)
      .toBe('completed');
  }, 30_000);

  it('links an accepted workflow change as a recoverable Temporal child workflow', async () => {
    const parentTask = `continuation-parent-${String(Date.now())}`;
    const childTask = `continuation-child-${String(Date.now())}`;
    const childInput = workflowInput('avia-13236-short-bug', childTask, 'automatic');
    const links: { parentTaskReference: string; childTaskReference: string; childRunId: string }[] =
      [];
    const planTaskImplementation: TaskWorkflowActivities['planTaskImplementation'] = async (
      input,
    ) => {
      const stub = await testTaskWorkflowActivities.planTaskImplementation(input);
      return input.taskReference === parentTask && input.command.kind === 'initial'
        ? {
            ...stub,
            status: 'workflow_change_required',
            artifactId: `workflow-change:${parentTask}`,
            request: {
              reason: 'The defect belongs to a shared component repository.',
              discoveredRepositories: ['twiket/ui-kit'],
              requiredCapabilities: ['repository.read', 'workspace.write'],
              evidence: ['reproduction:before'],
            },
          }
        : stub;
    };
    const activities: Partial<TaskWorkflowActivities> = {
      planTaskImplementation,
      linkWorkflowContinuation: (input) => {
        links.push(input);
        return Promise.resolve({ linked: true });
      },
    };

    worker.shutdown();
    await workerRun;
    await startWorker(activities);
    const started = await service.start(
      workflowInput('avia-12536-feature-review', parentTask, 'automatic'),
    );
    expect(started.ok).toBe(true);

    const review = await waitForWait(service, parentTask, 'workflow_change.review@1');
    expect(review.workflowChange).toMatchObject({
      artifactId: `workflow-change:${parentTask}`,
      request: { discoveredRepositories: ['twiket/ui-kit'] },
    });
    const accepted = await service.resolveWait(parentTask, {
      nodeId: review.currentNodeId ?? 'analyze-task',
      waitKind: 'workflow_change.review@1',
      resolution: JsonValueSchema.parse({
        decision: 'accept',
        continuationId: `${review.runId}:continuation-1`,
        taskReference: childTask,
        workflowHash: childInput.workflowHash,
        graph: childInput.graph,
        settings: childInput.settings,
      }),
    });
    expect(accepted.ok).toBe(true);
    await waitForWait(service, childTask, 'code_review@1');
    expect(links).toEqual([
      expect.objectContaining({
        parentTaskReference: parentTask,
        childTaskReference: childTask,
      }),
    ]);

    worker.shutdown();
    await workerRun;
    await startWorker(activities);
    const childReview = await waitForWait(service, childTask, 'code_review@1');
    if (childReview.status !== 'waiting') throw new Error('Expected child code review wait');
    const completedChild = await service.resolveWait(childTask, {
      nodeId: childReview.wait.nodeId,
      waitKind: childReview.wait.waitKind,
      resolution: { decision: 'approved', reviewId: 'review:child:approved' },
    });
    expect(completedChild.ok).toBe(true);
    await expect
      .poll(async () => (await requireState(service, parentTask)).status)
      .toBe('completed');
  }, 30_000);

  it('replays persisted history without carrying accidental vendor payloads', async () => {
    const taskReference = `history-replay-${String(Date.now())}`;
    const forbiddenPayload = 'jira-token-must-not-enter-temporal-history';
    const input = workflowInput('avia-13236-short-bug', taskReference, 'automatic');
    await expect(
      service.start({
        ...input,
        // This models an untyped integration accidentally passing its whole vendor
        // envelope. The client boundary must reject it before writing history.
        vendorPayload: { authorization: forbiddenPayload },
      } as unknown as typeof input),
    ).rejects.toThrow(/vendorPayload/u);

    const started = await service.start(input);
    expect(started.ok).toBe(true);

    const review = await waitForWait(service, taskReference, 'code_review@1');
    if (review.status !== 'waiting') throw new Error('Expected code review wait');
    const completed = await service.resolveWait(taskReference, {
      nodeId: review.wait.nodeId,
      waitKind: review.wait.waitKind,
      resolution: { decision: 'approved', reviewId: 'review:history:approved' },
    });
    expect(completed.ok).toBe(true);
    await expect
      .poll(async () => (await requireState(service, taskReference)).status)
      .toBe('completed');

    const history = await environment.client.workflow
      .getHandle(`tasker:${taskReference}`)
      .fetchHistory();
    const serializedHistory = JSON.stringify(history, (_key, value: unknown) =>
      value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : value,
    );

    expect(serializedHistory).not.toContain(forbiddenPayload);
    await expect(
      Worker.runReplayHistory({ workflowsPath }, history, `tasker:${taskReference}`),
    ).resolves.toBeUndefined();
  }, 30_000);
});
