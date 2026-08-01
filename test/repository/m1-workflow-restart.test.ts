import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createM1WorkflowService } from '../../src/control-plane/index.js';
import { openSqliteLedger } from '../../src/ledger/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';

const directories: string[] = [];

const databasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'tasker-m1-restart-'));
  directories.push(directory);
  return join(directory, 'ledger.sqlite');
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('M1 persisted workflow', () => {
  it('restores the same graph hash and template diff after a process restart', () => {
    const filename = databasePath();
    const clock = makeAdjustableClock('2026-08-01T12:00:00.000Z');
    const firstLedger = openSqliteLedger({ filename, clock });
    const firstService = createM1WorkflowService(firstLedger.repository, clock);

    const generated = firstService.generate('avia-14001-translation-component');
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;

    const originalHash = generated.value.view.workflow.graphHash;
    const originalDiff = generated.value.view.workflow.diff;
    expect(originalHash).not.toBeNull();
    expect(originalDiff.length).toBeGreaterThan(0);
    expect(firstLedger.repository.listOutbox()).toEqual([]);
    firstLedger.close();

    clock.advance(60_000);
    const restartedLedger = openSqliteLedger({ filename, clock });
    const restartedService = createM1WorkflowService(restartedLedger.repository, clock);
    const restored = restartedService.read('avia-14001-translation-component');

    expect(restored.ok).toBe(true);
    if (!restored.ok || restored.value === null) return;
    expect(restored.value.view.workflow.graphHash).toBe(originalHash);
    expect(restored.value.view.workflow.diff).toEqual(originalDiff);
    expect(restored.value.view.persistedAt).toBe('2026-08-01T12:00:00.000Z');
    expect(
      restartedLedger.repository.readSnapshot('snapshot:avia-14001-translation-component'),
    ).not.toBeNull();
    expect(
      restartedLedger.repository.readArtifact('proposal:avia-14001-translation-component'),
    ).not.toBeNull();
    expect(
      restartedLedger.repository.readArtifact('graph:avia-14001-translation-component'),
    ).not.toBeNull();
    expect(restartedLedger.repository.listOutbox()).toEqual([]);

    restartedLedger.close();
  });

  it('persists a rejected proposal without a graph or executable command', () => {
    const clock = makeAdjustableClock('2026-08-01T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: databasePath(), clock });
    const service = createM1WorkflowService(ledger.repository, clock);

    const generated = service.generate('invalid-unknown-step');

    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(generated.value.status).toBe('rejected');
    expect(generated.value.view.task.status).toBe('workflow_rejected');
    expect(generated.value.view.workflow.graph).toBeNull();
    expect(generated.value.view.workflow.tree).toBeNull();
    expect(generated.value.view.workflow.validatorReport.issues).toMatchObject([
      { code: 'unknown_reference' },
    ]);
    expect(ledger.repository.listOutbox()).toEqual([]);
    expect(ledger.repository.readArtifact('graph:invalid-unknown-step')).toBeNull();

    ledger.close();
  });
});
