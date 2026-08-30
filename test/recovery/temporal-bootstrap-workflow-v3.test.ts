import { fileURLToPath } from 'node:url';

import { ApplicationFailure } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  BootstrapWorkflowActivities,
  BootstrapWorkflowInput,
} from '../../src/temporal/bootstrap-kernel/contracts.js';
import { ImplementationPlanningRecordSchema } from '../../src/control-plane/implementation-planning-contracts.js';
import {
  createPlanningActivity,
  type TemporalImplementationPlanningCoordinator,
} from '../../src/temporal/activities/planning-activity.js';
import { TemporalTaskRunService } from '../../src/temporal/client.js';
import type { TaskRunPublicState } from '../../src/temporal/public-state.js';
import { err, ok } from '../../src/shared/outcome.js';
import { testTemporalActivities } from '../helpers/temporal-activities.js';

const workflowsPath = fileURLToPath(
  new URL('../../src/temporal/workflows/index.ts', import.meta.url),
);

const inputFor = (
  taskReference: string,
  planReview: 'required' | 'automatic',
): BootstrapWorkflowInput => ({
  schemaVersion: 3,
  taskReference,
  settings: { planReview, planningStrategy: 'fast', trackerStatusUpdates: 'enabled' },
});

describe('Bootstrap Workflow v3 recovery', () => {
  let environment: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRun: Promise<void>;
  let runs: TemporalTaskRunService;
  const taskQueue = `tasker-bootstrap-v3-${String(process.pid)}`;

  const startWorker = async (): Promise<void> => {
    worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: testTemporalActivities,
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
        settings: {
          planReview: 'automatic',
          planningStrategy: 'fast',
          trackerStatusUpdates: 'enabled',
        },
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
        runId: planReview.runId,
        nodeId: 'plan_review',
        waitKind: 'plan.approved@1',
        resolution: { decision: 'approve' },
      }),
    ).toMatchObject({ ok: true });
    await waitFor('fixture:reviewed', 'code_review@1');

    expect(
      await runs.resolveWait('fixture:automatic', {
        runId: automaticReview.runId,
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

  it('starts execution immediately after the workflow is frozen', async () => {
    const taskReference = 'fixture:automatic-execution-start';
    expect(await runs.start(inputFor(taskReference, 'automatic'))).toMatchObject({ ok: true });

    const waiting = await waitFor(taskReference, 'code_review@1');

    expect(waiting).toMatchObject({
      runtime: 'execution',
      status: 'waiting',
      wait: { waitKind: 'code_review@1' },
    });
  });

  it('restarts unfinished work in a new run and workspace without deleting old history', async () => {
    const taskReference = 'fixture:restart-from-scratch';
    expect(await runs.start(inputFor(taskReference, 'required'))).toMatchObject({ ok: true });
    const original = await waitFor(taskReference, 'plan.approved@1');
    if (original.runtime !== 'bootstrap' || original.workspaceContext === null) {
      throw new Error('Expected the original bootstrap workspace');
    }

    const restarted = await runs.restart(taskReference, original.runId);
    if (!restarted.ok) throw new Error(JSON.stringify(restarted.error));
    const fresh = await waitFor(taskReference, 'plan.approved@1');
    if (fresh.runtime !== 'bootstrap' || fresh.workspaceContext === null) {
      throw new Error('Expected the fresh bootstrap workspace');
    }
    const oldHistory = await environment.client.workflow
      .getHandle(original.workflowId, original.runId)
      .fetchHistory();

    expect(fresh.runId).not.toBe(original.runId);
    expect(fresh.workspaceContext.workspace.workspaceId).not.toBe(
      original.workspaceContext.workspace.workspaceId,
    );
    expect(fresh.settings).toEqual(original.settings);
    expect(
      oldHistory.events?.some(
        (event) => event.workflowExecutionTerminatedEventAttributes !== undefined,
      ),
    ).toBe(true);
  });
});

describe('Bootstrap Jira admission recovery', () => {
  it('resumes the same run and workspace after a Jira prerequisite is fixed', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const taskQueue = `tasker-bootstrap-admission-${String(process.pid)}`;
    const runs = new TemporalTaskRunService(environment.client, {
      address: 'test-server',
      namespace: 'default',
      taskQueue,
      queryTimeoutMs: 5_000,
      updateTimeoutMs: 5_000,
    });
    const attempts: Array<{
      readonly workflowRunId: string;
      readonly workspaceId: string;
      readonly waitResolution: unknown;
    }> = [];
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: {
        ...testTemporalActivities,
        admitTaskExecution: (input) => {
          attempts.push({
            workflowRunId: input.workflowRunId,
            workspaceId: input.workspace.workspaceId,
            waitResolution: input.waitResolution,
          });
          return Promise.resolve(
            attempts.length === 1
              ? {
                  status: 'needs_input' as const,
                  waitKind: 'jira.start-work@1.invalid_request@1',
                  summary: 'Jira requires the Development estimate before transition',
                }
              : {
                  status: 'completed' as const,
                  summary: 'Jira task admitted after the missing field was filled',
                },
          );
        },
      } satisfies BootstrapWorkflowActivities,
      maxCachedWorkflows: 0,
    });
    const workerRun = worker.run();
    const taskReference = 'fixture:jira-admission-recovery';

    try {
      expect(await runs.start(inputFor(taskReference, 'automatic'))).toMatchObject({ ok: true });
      await expect
        .poll(
          async () => {
            const state = await runs.read(taskReference);
            return state.ok && state.value?.status === 'waiting'
              ? state.value.wait.waitKind
              : 'running';
          },
          { interval: 50, timeout: 20_000 },
        )
        .toBe('jira.start-work@1.invalid_request@1');
      const waiting = await runs.read(taskReference);
      if (!waiting.ok || waiting.value?.runtime !== 'bootstrap') {
        throw new Error('Expected bootstrap admission wait');
      }
      expect(
        await runs.resolveWait(taskReference, {
          runId: waiting.value.runId,
          nodeId: 'admission',
          waitKind: 'jira.start-work@1.invalid_request@1',
          resolution: { guidance: 'Development estimate is now filled in Jira' },
        }),
      ).toMatchObject({ ok: true });
      await expect
        .poll(
          async () => {
            const state = await runs.read(taskReference);
            return state.ok && state.value?.status === 'waiting'
              ? state.value.wait.waitKind
              : 'running';
          },
          { interval: 50, timeout: 20_000 },
        )
        .toBe('code_review@1');

      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toMatchObject({
        workflowRunId: attempts[0]?.workflowRunId,
        workspaceId: attempts[0]?.workspaceId,
        waitResolution: { guidance: 'Development estimate is now filled in Jira' },
      });
    } finally {
      worker.shutdown();
      await workerRun;
      await environment.teardown();
    }
  }, 60_000);
});

describe('Bootstrap infrastructure failure visibility', () => {
  it('surfaces the exhausted workspace activity cause in the durable operator wait', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const taskQueue = `tasker-bootstrap-workspace-failure-${String(process.pid)}`;
    const runs = new TemporalTaskRunService(environment.client, {
      address: 'test-server',
      namespace: 'default',
      taskQueue,
      queryTimeoutMs: 5_000,
      updateTimeoutMs: 5_000,
    });
    const failure =
      'Task workspace Docker runtime failed: bootstrap_failed [command: mise install]: No space left on device';
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: {
        ...testTemporalActivities,
        prepareTaskWorkspace: () => Promise.reject(new Error(failure)),
      } satisfies BootstrapWorkflowActivities,
      maxCachedWorkflows: 0,
    });
    const workerRun = worker.run();

    try {
      expect(
        await runs.start({
          ...inputFor('fixture:workspace-failure', 'automatic'),
          settings: {
            planReview: 'automatic',
            planningStrategy: 'fast',
            trackerStatusUpdates: 'enabled',
          },
        }),
      ).toMatchObject({ ok: true });
      await expect
        .poll(
          async () => {
            const result = await runs.read('fixture:workspace-failure');
            return result.ok && result.value?.status === 'waiting'
              ? result.value.wait.reason
              : 'running';
          },
          { interval: 50, timeout: 20_000 },
        )
        .toBe(`Workspace preparation failed: ${failure}`);
    } finally {
      worker.shutdown();
      await workerRun;
      await environment.teardown();
    }
  }, 60_000);
});

describe('Bootstrap investigation recovery', () => {
  it('resumes an activity failure with the same logical block run', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const taskQueue = `tasker-bootstrap-investigation-${String(process.pid)}`;
    const runs = new TemporalTaskRunService(environment.client, {
      address: 'test-server',
      namespace: 'default',
      taskQueue,
      queryTimeoutMs: 5_000,
      updateTimeoutMs: 5_000,
    });
    const observedBlockRuns: number[] = [];
    let investigationCalls = 0;
    const activities: BootstrapWorkflowActivities = {
      ...testTemporalActivities,
      planTaskImplementation: async (input) => {
        const ready = await testTemporalActivities.planTaskImplementation(input);
        if (input.command.kind !== 'initial') return ready;
        const base = {
          planningEpisodeId: ready.planningEpisodeId,
          commandId: ready.commandId,
          transcriptId: ready.transcriptId,
          attempt: ready.attempt,
          artifactId: ready.artifactId,
          evidenceBundle: ready.evidenceBundle,
          requestedStrategy: ready.requestedStrategy,
          selectedStrategy: ready.selectedStrategy,
        };
        return {
          ...base,
          status: 'investigation_required' as const,
          request: {
            reason: 'Ground the reported defect before planning.',
            steps: [
              {
                id: 'reproduce-payment-spacing',
                uses: 'runtime.observe@1',
                with: {
                  objective: 'Reproduce the payment spacing defect.',
                  claim: 'The payment spacing defect is visible in the reported state.',
                  scenario: 'Open the reported payment state and inspect the affected spacing.',
                  requestedEvidence: ['image'],
                },
              },
            ],
          },
        };
      },
      runBootstrapInvestigation: (input) => {
        observedBlockRuns.push(input.blockRun);
        investigationCalls += 1;
        if (investigationCalls === 1) {
          return Promise.reject(
            ApplicationFailure.nonRetryable('Response adapter failed after receipt persistence'),
          );
        }
        return Promise.resolve({
          status: 'completed' as const,
          summary: 'The payment spacing defect was reproduced.',
          evidenceBundle: {
            artifactId: `evidence-bundle:${input.taskReference}:r2:investigation`,
            checksum: '0'.repeat(64),
            revision: 2,
          },
        });
      },
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      activities,
      maxCachedWorkflows: 0,
    });
    const workerRun = worker.run();

    try {
      expect(
        await runs.start({
          ...inputFor('fixture:investigation-retry', 'automatic'),
          settings: {
            planReview: 'automatic',
            planningStrategy: 'fast',
            trackerStatusUpdates: 'enabled',
          },
        }),
      ).toMatchObject({ ok: true });
      const waitingForRetry = await (async () => {
        await expect
          .poll(
            async () => {
              const result = await runs.read('fixture:investigation-retry');
              return result.ok
                ? result.value?.status === 'waiting'
                  ? result.value.wait.waitKind
                  : `${result.value?.status ?? 'missing'}:${result.value?.currentNodeId ?? 'none'}`
                : `error:${result.error.kind}`;
            },
            { interval: 50, timeout: 10_000 },
          )
          .toBe('investigation.retry@1');
        const result = await runs.read('fixture:investigation-retry');
        if (!result.ok || result.value?.status !== 'waiting') {
          throw new Error('Investigation retry wait is unavailable');
        }
        return result.value;
      })();

      expect(
        await runs.resolveWait('fixture:investigation-retry', {
          runId: waitingForRetry.runId,
          nodeId: waitingForRetry.wait.nodeId,
          waitKind: waitingForRetry.wait.waitKind,
          resolution: { decision: 'resume' },
        }),
      ).toMatchObject({ ok: true });
      await expect
        .poll(
          async () => {
            const result = await runs.read('fixture:investigation-retry');
            return result.ok && result.value?.status === 'waiting'
              ? result.value.wait.waitKind
              : 'running';
          },
          { interval: 50, timeout: 20_000 },
        )
        .toBe('code_review@1');

      expect(observedBlockRuns).toEqual([1, 2]);
      const recovered = await runs.readLifecycle('fixture:investigation-retry');
      expect(recovered).toMatchObject({
        ok: true,
        value: {
          bootstrap: { attempts: { 'investigation:reproduce-payment-spacing': 2 } },
          execution: { status: 'waiting', wait: { waitKind: 'code_review@1' } },
        },
      });
    } finally {
      worker.shutdown();
      await workerRun;
      await environment.teardown();
    }
  }, 60_000);
});

describe('Bootstrap planning failure recovery', () => {
  it('surfaces exhausted candidate correction as one typed durable wait', async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    const taskQueue = `tasker-bootstrap-planning-failure-${String(process.pid)}`;
    const runs = new TemporalTaskRunService(environment.client, {
      address: 'test-server',
      namespace: 'default',
      taskQueue,
      queryTimeoutMs: 5_000,
      updateTimeoutMs: 5_000,
    });
    let planningCalls = 0;
    const coordinator: TemporalImplementationPlanningCoordinator = {
      prepare: (
        taskReference,
        requestedStrategy,
        commandId,
        planningEpisodeId,
        planningSnapshot,
        evidenceBundle,
      ) => {
        planningCalls += 1;
        return Promise.resolve(
          ok(
            ImplementationPlanningRecordSchema.parse({
              schemaVersion: 3,
              taskReference,
              planningEpisodeId,
              commandId,
              transcriptId: `planning-transcript:${commandId}`,
              planningSnapshot,
              evidenceBundle,
              evidenceRounds: [],
              attempt: 1,
              requestedStrategy,
              selectedStrategy: requestedStrategy === 'ralplan' ? 'ralplan' : 'fast',
              selectionReason: 'Temporal recovery test.',
              startedAt: '2026-08-09T00:00:00.000Z',
              operatorGuidance: null,
              validationFeedback: ['Workflow has an execution path without a finalize node'],
              validationRevision: 3,
              previousDecision: null,
              status: 'failed',
              completedAt: '2026-08-09T00:00:01.000Z',
              failure: {
                kind: 'invalid_planner_output',
                message: 'Workflow has an execution path without a finalize node',
                retryable: false,
              },
              receipt: null,
            }),
          ),
        );
      },
      answer: () => Promise.resolve(err({ kind: 'unexpected_answer' })),
      draftFor: () => err({ kind: 'unexpected_draft' }),
    };
    const activities: BootstrapWorkflowActivities = {
      ...testTemporalActivities,
      ...createPlanningActivity(coordinator),
    };
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      activities,
      maxCachedWorkflows: 0,
    });
    const workerRun = worker.run();

    try {
      expect(
        await runs.start({
          ...inputFor('fixture:invalid-planner-output', 'automatic'),
          settings: {
            planReview: 'automatic',
            planningStrategy: 'fast',
            trackerStatusUpdates: 'enabled',
          },
        }),
      ).toMatchObject({ ok: true });
      await expect
        .poll(
          async () => {
            const result = await runs.read('fixture:invalid-planner-output');
            return result.ok && result.value?.status === 'waiting'
              ? result.value.wait.waitKind
              : 'running';
          },
          { interval: 50, timeout: 20_000 },
        )
        .toBe('planning.candidate-guidance@1');
      expect(planningCalls).toBe(1);
      const waiting = await runs.read('fixture:invalid-planner-output');
      expect(waiting).toMatchObject({
        ok: true,
        value: {
          status: 'waiting',
          wait: {
            reason:
              'Workflow candidate rejected after automatic correction: Workflow has an execution path without a finalize node',
          },
          planning: {
            status: 'blocked',
            failure: {
              kind: 'invalid_planner_output',
              message: 'Workflow has an execution path without a finalize node',
            },
            validationFeedback: ['Workflow has an execution path without a finalize node'],
          },
        },
      });
    } finally {
      worker.shutdown();
      await workerRun;
      await environment.teardown();
    }
  }, 60_000);
});
