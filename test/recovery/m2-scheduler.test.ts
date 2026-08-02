import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createM1WorkflowService } from '../../src/control-plane/m1-service.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { DeterministicStubRunService, DurableStubScheduler } from '../../src/runner/index.js';
import { makeAdjustableClock, type AdjustableClock } from '../../src/shared/clock.js';

interface TestRuntime {
  readonly clock: AdjustableClock;
  readonly filename: string;
  readonly ledger: SqliteLedger;
  readonly runner: DeterministicStubRunService;
}

const directories: string[] = [];
const ledgers: SqliteLedger[] = [];

const makeRuntime = (): TestRuntime => {
  const directory = mkdtempSync(join(tmpdir(), 'tasker-m2-scheduler-'));
  directories.push(directory);
  const clock = makeAdjustableClock('2026-08-02T03:00:00.000Z');
  const filename = join(directory, 'ledger.sqlite');
  const ledger = openSqliteLedger({ filename, clock });
  ledgers.push(ledger);
  const workflows = createM1WorkflowService(ledger.repository, clock);
  for (const fixtureId of ['avia-13236-short-bug', 'avia-12536-feature-review']) {
    const generated = workflows.generate(fixtureId);
    if (!generated.ok) throw new Error(`Could not generate ${fixtureId}`);
  }
  return {
    clock,
    filename,
    ledger,
    runner: new DeterministicStubRunService(ledger.repository, workflows, clock),
  };
};

const makeScheduler = (runtime: TestRuntime, capacity: number, ownerId: string) =>
  new DurableStubScheduler(runtime.runner, runtime.ledger.repository, runtime.clock, {
    capacity,
    ownerId,
    leaseTimeoutMs: 1_000,
    pollIntervalMs: 10,
  });

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('M2 configurable scheduler', () => {
  it('claims independent tasks in parallel up to configured capacity', () => {
    const runtime = makeRuntime();
    const scheduler = makeScheduler(runtime, 2, 'runner-parallel');
    scheduler.enqueue('avia-13236-short-bug');
    scheduler.enqueue('avia-12536-feature-review');

    const result = scheduler.tick({ maxNodeTransitionsPerRun: 1 });

    expect(result).toEqual({
      ok: true,
      value: {
        capacity: 2,
        queued: [],
        executing: ['avia-12536-feature-review', 'avia-13236-short-bug'],
        waiting: [],
        completed: [],
      },
    });
    const activeRuns = runtime.runner.list();
    expect(activeRuns.ok).toBe(true);
    if (!activeRuns.ok) return;
    expect(activeRuns.value).toHaveLength(2);
    expect(activeRuns.value.every((run) => run.status === 'executing')).toBe(true);
    expect(
      activeRuns.value.map((run) => (run.status === 'executing' ? run.lease.fenceToken : null)),
    ).toEqual([1, 1]);
  });

  it('reuses capacity immediately when a run opens a slot-releasing wait', () => {
    const runtime = makeRuntime();
    const scheduler = makeScheduler(runtime, 1, 'runner-serial');
    scheduler.enqueue('avia-13236-short-bug');
    scheduler.enqueue('avia-12536-feature-review');

    const result = scheduler.tick();

    expect(result).toEqual({
      ok: true,
      value: {
        capacity: 1,
        queued: [],
        executing: [],
        waiting: ['avia-12536-feature-review', 'avia-13236-short-bug'],
        completed: [],
      },
    });
    const leases = ['avia-13236-short-bug', 'avia-12536-feature-review'].map((taskReference) =>
      runtime.ledger.repository.readLease(`runner/run:${taskReference}`),
    );
    expect(leases.map((lease) => lease?.status)).toEqual(['released', 'released']);
  });

  it('rejects writes from a runner after its expired lease is replaced', () => {
    const runtime = makeRuntime();
    const firstScheduler = makeScheduler(runtime, 1, 'runner-old');
    firstScheduler.enqueue('avia-13236-short-bug');
    firstScheduler.tick({ maxNodeTransitionsPerRun: 1 });
    const oldRun = runtime.runner.read('avia-13236-short-bug');
    if (!oldRun.ok || oldRun.value?.status !== 'executing') {
      throw new Error('Expected the first runner to hold an executing lease');
    }
    runtime.clock.advance(1_000);
    const replacementScheduler = makeScheduler(runtime, 1, 'runner-new');
    const replacement = replacementScheduler.tick({ maxNodeTransitionsPerRun: 1 });
    if (!replacement.ok) throw new Error('Expected replacement runner to claim the run');

    const staleWrite = runtime.runner.advanceClaimed(oldRun.value, {
      maxNodeTransitions: 1,
    });

    expect(staleWrite).toMatchObject({
      ok: false,
      error: {
        kind: 'ledger_conflict',
        conflict: {
          kind: 'stale_fence',
          expectedFenceToken: 1,
          actualFenceToken: 2,
          actualOwnerId: 'runner-new',
        },
      },
    });
    expect(runtime.runner.read('avia-13236-short-bug')).toMatchObject({
      ok: true,
      value: {
        status: 'executing',
        cursor: 2,
        lease: { ownerId: 'runner-new', fenceToken: 2 },
      },
    });
  });

  it('recovers an executing run through a new scheduler process without replaying receipts', () => {
    const runtime = makeRuntime();
    const firstScheduler = makeScheduler(runtime, 1, 'runner-before-restart');
    firstScheduler.enqueue('avia-13236-short-bug');
    firstScheduler.tick({ maxNodeTransitionsPerRun: 2 });
    const beforeRestart = runtime.runner.read('avia-13236-short-bug');
    if (!beforeRestart.ok || beforeRestart.value?.status !== 'executing') {
      throw new Error('Expected an executing run before restart');
    }

    ledgers.splice(ledgers.indexOf(runtime.ledger), 1);
    runtime.ledger.close();
    runtime.clock.advance(1_000);

    const reopenedLedger = openSqliteLedger({ filename: runtime.filename, clock: runtime.clock });
    ledgers.push(reopenedLedger);
    const reopenedWorkflows = createM1WorkflowService(reopenedLedger.repository, runtime.clock);
    const reopenedRunner = new DeterministicStubRunService(
      reopenedLedger.repository,
      reopenedWorkflows,
      runtime.clock,
    );
    const restartedScheduler = new DurableStubScheduler(
      reopenedRunner,
      reopenedLedger.repository,
      runtime.clock,
      {
        capacity: 1,
        ownerId: 'runner-after-restart',
        leaseTimeoutMs: 1_000,
        pollIntervalMs: 10,
      },
    );

    const recovered = restartedScheduler.tick();

    expect(recovered).toMatchObject({
      ok: true,
      value: { waiting: ['avia-13236-short-bug'], executing: [] },
    });
    const afterRestart = reopenedRunner.read('avia-13236-short-bug');
    if (!afterRestart.ok || afterRestart.value === null) {
      throw new Error('Expected the run after scheduler restart');
    }
    expect(afterRestart.value.status).toBe('waiting');
    expect(afterRestart.value.effects.map((effect) => effect.effectKey)).toEqual([
      ...new Set(afterRestart.value.effects.map((effect) => effect.effectKey)),
    ]);
    expect(afterRestart.value.effects.slice(0, beforeRestart.value.effects.length)).toEqual(
      beforeRestart.value.effects,
    );
    expect(reopenedLedger.repository.readLease(beforeRestart.value.lease.leaseKey)).toMatchObject({
      ownerId: 'runner-after-restart',
      fenceToken: 2,
      status: 'released',
    });
  });
});
