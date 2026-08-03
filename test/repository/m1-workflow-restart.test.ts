import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createM1WorkflowService } from '../../src/control-plane/index.js';
import { openSqliteLedger } from '../../src/ledger/index.js';
import {
  analyzeTaskFixture,
  findTaskFixture,
  WorkflowAnalyzerOutputSchema,
} from '../../src/planning/index.js';
import { WorkflowAnalyzerReceiptSchema } from '../../src/providers/contracts.js';
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
  it('restores the same task-specific graph after a process restart', () => {
    const filename = databasePath();
    const clock = makeAdjustableClock('2026-08-01T12:00:00.000Z');
    const firstLedger = openSqliteLedger({ filename, clock });
    const firstService = createM1WorkflowService(firstLedger.repository, clock);

    const generated = firstService.generate('avia-14001-translation-component');
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;

    const originalHash = generated.value.view.workflow.graphHash;
    expect(originalHash).not.toBeNull();
    expect(firstLedger.repository.listOutbox()).toEqual([]);
    firstLedger.close();

    clock.advance(60_000);
    const restartedLedger = openSqliteLedger({ filename, clock });
    const restartedService = createM1WorkflowService(restartedLedger.repository, clock);
    const restored = restartedService.read('avia-14001-translation-component');

    expect(restored.ok).toBe(true);
    if (!restored.ok || restored.value === null) return;
    expect(restored.value.view.workflow.graphHash).toBe(originalHash);
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

  it('restores provider provenance without re-planning an existing workflow', () => {
    const filename = databasePath();
    const clock = makeAdjustableClock('2026-08-01T12:00:00.000Z');
    const fixture = findTaskFixture('avia-13236-short-bug');
    if (fixture === undefined) throw new Error('Expected workflow fixture');
    const analyzed = analyzeTaskFixture(fixture);
    if (!analyzed.ok) throw new Error('Expected deterministic proposal fixture');

    const output = WorkflowAnalyzerOutputSchema.parse({
      assemblyDecisions: analyzed.value.assemblyDecisions,
      source: analyzed.value.source,
      verificationPlan: analyzed.value.verificationPlan,
    });
    const receipt = WorkflowAnalyzerReceiptSchema.parse({
      status: 'completed',
      provider: 'codex_cli',
      analyzerVersion: 'codex-cli@1',
      cliVersion: 'codex-cli 0.120.0',
      model: 'gpt-5.4',
      serviceTier: 'fast',
      sessionId: 'thread-first',
      promptHash: 'a'.repeat(64),
      durationMs: 1250,
      usage: {
        inputTokens: 1200,
        cachedInputTokens: 800,
        outputTokens: 240,
        reasoningOutputTokens: 40,
      },
      hypotheticalApiCostUsd: null,
    });
    const firstLedger = openSqliteLedger({ filename, clock });
    const firstService = createM1WorkflowService(firstLedger.repository, clock);

    const generated = firstService.generateFromAnalyzerOutput(fixture.fixtureId, output, receipt);
    expect(generated.ok).toBe(true);
    expect(firstLedger.repository.listEvents(`intake:${fixture.fixtureId}`)).toHaveLength(4);
    expect(
      firstLedger.repository.readArtifact(`analyzer-receipt:${fixture.fixtureId}`),
    ).not.toBeNull();
    firstLedger.close();

    const restartedLedger = openSqliteLedger({ filename, clock });
    const restartedService = createM1WorkflowService(restartedLedger.repository, clock);
    const activity = restartedService.readActivity(fixture.fixtureId);
    const duplicate = restartedService.generateFromAnalyzerOutput(fixture.fixtureId, output, {
      ...receipt,
      sessionId: 'thread-second',
      promptHash: 'b'.repeat(64),
    });

    expect(activity).toMatchObject({
      ok: true,
      value: { providerSession: { sessionId: 'thread-first' } },
    });
    if (!activity.ok) return;
    expect(activity.value.entries).toHaveLength(4);
    expect(activity.value.entries[2]).toMatchObject({
      source: 'agent',
      title: 'Task and repository analyzed',
    });
    expect(duplicate).toEqual(generated);
    expect(
      restartedLedger.repository.readProjection('m1_analyzer', fixture.fixtureId)?.payload,
    ).toMatchObject({ sessionId: 'thread-first' });
    expect(restartedLedger.repository.listEvents(`intake:${fixture.fixtureId}`)).toHaveLength(4);

    restartedLedger.close();
  });
});
