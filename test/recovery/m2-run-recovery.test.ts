import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createM1WorkflowService } from '../../src/control-plane/m1-service.js';
import { openSqliteLedger } from '../../src/ledger/index.js';
import { DeterministicStubRunService } from '../../src/runner/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';

const directories: string[] = [];

const databasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'tasker-m2-recovery-'));
  directories.push(directory);
  return join(directory, 'ledger.sqlite');
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('M2 durable stub execution', () => {
  it('continues from the last committed cursor after restart without repeating effects', () => {
    const filename = databasePath();
    const clock = makeAdjustableClock('2026-08-02T02:00:00.000Z');
    const firstLedger = openSqliteLedger({ filename, clock });
    const firstWorkflows = createM1WorkflowService(firstLedger.repository, clock);
    const firstRunner = new DeterministicStubRunService(
      firstLedger.repository,
      firstWorkflows,
      clock,
    );

    const generated = firstWorkflows.generate('avia-13236-short-bug');
    expect(generated.ok).toBe(true);
    const interrupted = firstRunner.start(
      'avia-13236-short-bug',
      { planApproval: 'automatic' },
      { maxNodeTransitions: 3 },
    );
    expect(interrupted).toMatchObject({
      ok: true,
      value: { status: 'executing', cursor: 3 },
    });
    if (!interrupted.ok) return;
    expect(interrupted.value.effects).toHaveLength(2);
    firstLedger.close();

    clock.advance(60_000);
    const restartedLedger = openSqliteLedger({ filename, clock });
    const restartedWorkflows = createM1WorkflowService(restartedLedger.repository, clock);
    const restartedRunner = new DeterministicStubRunService(
      restartedLedger.repository,
      restartedWorkflows,
      clock,
    );
    const resumed = restartedRunner.start('avia-13236-short-bug', {
      planApproval: 'automatic',
    });

    expect(resumed).toMatchObject({
      ok: true,
      value: {
        status: 'waiting',
        wait: { waitKind: 'code_review@1', slotPolicy: 'release' },
      },
    });
    if (!resumed.ok) return;
    expect(new Set(resumed.value.effects.map((effect) => effect.effectKey)).size).toBe(
      resumed.value.effects.length,
    );
    expect(
      restartedRunner
        .listEvents('avia-13236-short-bug')
        .filter((event) => event.eventType === 'StepStubbed'),
    ).toHaveLength(resumed.value.effects.length);

    const duplicateStart = restartedRunner.start('avia-13236-short-bug', {
      planApproval: 'automatic',
    });
    expect(duplicateStart).toEqual(resumed);
    expect(restartedRunner.listEvents('avia-13236-short-bug')).toHaveLength(
      4 + resumed.value.effects.length,
    );

    const completed = restartedRunner.resume('avia-13236-short-bug', 'review_approved');
    expect(completed).toMatchObject({
      ok: true,
      value: { status: 'completed', completedAt: clock.now() },
    });
    expect(restartedLedger.repository.readProjection('m1_run', resumed.value.runId)).not.toBeNull();
    restartedLedger.close();
  });
});
