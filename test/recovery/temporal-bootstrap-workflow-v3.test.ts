import { fileURLToPath } from 'node:url';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  BootstrapWorkflowActivities,
  BootstrapWorkflowInput,
} from '../../src/temporal/bootstrap-kernel/contracts.js';
import { TemporalTaskRunService } from '../../src/temporal/client.js';
import type { TaskRunPublicState } from '../../src/temporal/public-state.js';
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
  settings: { planReview, planningStrategy: 'fast', executionStart: 'automatic' },
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
          executionStart: 'automatic',
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

describe('Bootstrap investigation recovery', () => {
  it('retries an activity failure with the same logical block run', async () => {
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
          commandId: ready.commandId,
          transcriptId: ready.transcriptId,
          attempt: ready.attempt,
          artifactId: ready.artifactId,
          evidenceBundle: ready.evidenceBundle,
          requestedStrategy: ready.requestedStrategy,
          selectedStrategy: ready.selectedStrategy,
          receipt: ready.receipt,
        };
        return {
          ...base,
          status: 'investigation_required' as const,
          request: {
            reason: 'Ground the reported defect before planning.',
            steps: [
              {
                id: 'reproduce-payment-spacing',
                uses: 'bug.investigate@1',
                with: { objective: 'Reproduce the payment spacing defect.' },
              },
            ],
          },
        };
      },
      runBootstrapInvestigation: (input) => {
        observedBlockRuns.push(input.blockRun);
        investigationCalls += 1;
        if (investigationCalls <= 3) {
          return Promise.reject(new Error('Response adapter failed after receipt persistence'));
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
            executionStart: 'manual',
          },
        }),
      ).toMatchObject({ ok: true });
      const waitingForRetry = await (async () => {
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
          .toBe('investigation.retry@1');
        const result = await runs.read('fixture:investigation-retry');
        if (!result.ok || result.value?.status !== 'waiting') {
          throw new Error('Investigation retry wait is unavailable');
        }
        return result.value;
      })();

      expect(
        await runs.resolveWait('fixture:investigation-retry', {
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
        .toBe('execution.start@1');

      expect(observedBlockRuns).toEqual([1, 1, 1, 1]);
      const recovered = await runs.read('fixture:investigation-retry');
      expect(recovered).toMatchObject({
        ok: true,
        value: { attempts: { 'investigation:reproduce-payment-spacing': 1 } },
      });
    } finally {
      worker.shutdown();
      await workerRun;
      await environment.teardown();
    }
  }, 60_000);
});
