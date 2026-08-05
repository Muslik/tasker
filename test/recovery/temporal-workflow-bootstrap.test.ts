import { fileURLToPath } from 'node:url';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createM1WorkflowService } from '../../src/control-plane/m1-service.js';
import { TemporalWorkflowGenerator } from '../../src/control-plane/temporal-workflow-generator.js';
import type { WorkflowGenerator } from '../../src/control-plane/workflow-generator.js';
import { openSqliteLedger } from '../../src/ledger/index.js';
import { findTaskFixture } from '../../src/planning/index.js';
import { err } from '../../src/shared/outcome.js';
import { createWorkflowAssemblyActivity } from '../../src/temporal/index.js';

const workflowsPath = fileURLToPath(
  new URL('../../src/temporal/workflows/task-workflow.ts', import.meta.url),
);

describe('Temporal workflow bootstrap', () => {
  let environment: TestWorkflowEnvironment;
  let worker: Worker;
  let workerRun: Promise<void>;
  let delegate: WorkflowGenerator;
  const taskQueue = `tasker-bootstrap-test-${String(process.pid)}`;
  const configuration = {
    address: 'test-server',
    namespace: 'default',
    taskQueue,
    queryTimeoutMs: 5_000,
    updateTimeoutMs: 5_000,
  } as const;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: createWorkflowAssemblyActivity({
        generate: (taskReference) => delegate.generate(taskReference),
      }),
    });
    workerRun = worker.run();
  }, 120_000);

  afterAll(async () => {
    worker.shutdown();
    await workerRun;
    await environment.teardown();
  });

  it('returns the persisted draft without starting another bootstrap run', async () => {
    const fixture = findTaskFixture('avia-13236-short-bug');
    if (fixture === undefined) throw new Error('Missing bootstrap fixture');
    const ledger = openSqliteLedger({ filename: ':memory:' });
    try {
      const workflows = createM1WorkflowService(ledger.repository, {
        now: () => '2026-08-05T00:00:00.000Z',
      });
      let invocations = 0;
      delegate = {
        generate: (taskReference) => {
          invocations += 1;
          return Promise.resolve(
            taskReference === fixture.fixtureId
              ? workflows.generateTask(fixture)
              : err({ kind: 'task_not_found' as const, taskReference }),
          );
        },
      };
      const generator = new TemporalWorkflowGenerator(environment.client, configuration, workflows);

      const first = await generator.generate(fixture.fixtureId);
      const second = await generator.generate(fixture.fixtureId);

      if (!first.ok) throw new Error(JSON.stringify(first.error));
      if (!second.ok) throw new Error(JSON.stringify(second.error));
      expect(first).toMatchObject({ ok: true });
      expect(second).toMatchObject({ ok: true });
      expect(invocations).toBe(1);
      expect(workflows.read(fixture.fixtureId)).toMatchObject({
        ok: true,
        value: { status: 'ready' },
      });
    } finally {
      ledger.close();
    }
  });

  it('can resume the same bootstrap after its retry budget is exhausted', async () => {
    const fixture = findTaskFixture('avia-12536-feature-review');
    if (fixture === undefined) throw new Error('Missing bootstrap fixture');
    const ledger = openSqliteLedger({ filename: ':memory:' });
    try {
      const workflows = createM1WorkflowService(ledger.repository, {
        now: () => '2026-08-05T00:00:00.000Z',
      });
      let invocations = 0;
      let infrastructureReady = false;
      delegate = {
        generate: (taskReference) => {
          invocations += 1;
          if (!infrastructureReady) {
            return Promise.resolve(
              err({
                kind: 'generation_runtime_unavailable' as const,
                message: 'simulated recoverable worker-side failure',
              }),
            );
          }
          return Promise.resolve(
            taskReference === fixture.fixtureId
              ? workflows.generateTask(fixture)
              : err({ kind: 'task_not_found' as const, taskReference }),
          );
        },
      };
      const generator = new TemporalWorkflowGenerator(environment.client, configuration, workflows);

      const failed = await generator.generate(fixture.fixtureId);
      expect(failed).toMatchObject({
        ok: false,
        error: { kind: 'generation_runtime_unavailable' },
      });
      expect(invocations).toBe(3);

      infrastructureReady = true;
      const generated = await generator.generate(fixture.fixtureId);

      expect(generated).toMatchObject({ ok: true, value: { status: 'ready' } });
      expect(invocations).toBe(4);
    } finally {
      ledger.close();
    }
  });

  it('surfaces a safe provider reason after the retry budget is exhausted', async () => {
    const fixture = findTaskFixture('avia-14002-inline-copy');
    if (fixture === undefined) throw new Error('Missing bootstrap fixture');
    const ledger = openSqliteLedger({ filename: ':memory:' });
    try {
      const workflows = createM1WorkflowService(ledger.repository, {
        now: () => '2026-08-05T00:00:00.000Z',
      });
      delegate = {
        generate: () =>
          Promise.resolve(
            err({
              kind: 'provider_failure' as const,
              provider: 'codex_cli' as const,
              failure: {
                kind: 'provider_failed' as const,
                exitCode: 1,
                message: 'subscription capacity is temporarily unavailable',
                stderr: 'credential-bearing diagnostic must stay private',
              },
            }),
          ),
      };
      const generator = new TemporalWorkflowGenerator(environment.client, configuration, workflows);

      const failed = await generator.generate(fixture.fixtureId);

      expect(failed).toMatchObject({
        ok: false,
        error: {
          kind: 'generation_runtime_unavailable',
        },
      });
      if (failed.ok) throw new Error('Expected bootstrap failure');
      if (failed.error.kind !== 'generation_runtime_unavailable') {
        throw new Error(`Expected runtime failure, received ${failed.error.kind}`);
      }
      expect(failed.error.message).toContain('subscription capacity is temporarily unavailable');
      expect(failed.error.message).not.toContain('credential-bearing diagnostic');
    } finally {
      ledger.close();
    }
  });
});
