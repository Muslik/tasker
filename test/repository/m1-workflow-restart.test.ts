import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createM1WorkflowService,
  M1_WORKFLOW_OPERATION_PROJECTION,
  WorkflowGenerationSubjectSource,
} from '../../src/control-plane/index.js';
import { openSqliteLedger } from '../../src/ledger/index.js';
import {
  analyzeTaskFixture,
  findTaskFixture,
  WorkflowAnalyzerOutputSchema,
  type TaskFixture,
  type WorkflowAnalyzerOutput,
} from '../../src/planning/index.js';
import {
  WorkflowAnalyzerReceiptSchema,
  type WorkflowAnalyzerReceipt,
} from '../../src/providers/contracts.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';

const directories: string[] = [];

const databasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'tasker-m1-restart-'));
  directories.push(directory);
  return join(directory, 'ledger.sqlite');
};

const workflowFixture = (): {
  readonly fixture: TaskFixture;
  readonly output: WorkflowAnalyzerOutput;
} => {
  const fixture = findTaskFixture('avia-13236-short-bug');
  if (fixture === undefined) throw new Error('Expected workflow fixture');
  const analyzed = analyzeTaskFixture(fixture);
  if (!analyzed.ok) throw new Error('Expected deterministic proposal fixture');
  return {
    fixture,
    output: WorkflowAnalyzerOutputSchema.parse({
      assemblyDecisions: analyzed.value.assemblyDecisions,
      source: analyzed.value.source,
      verificationPlan: analyzed.value.verificationPlan,
    }),
  };
};

const receipt = (sessionId: string): WorkflowAnalyzerReceipt =>
  WorkflowAnalyzerReceiptSchema.parse({
    status: 'completed',
    provider: 'codex_cli',
    analyzerVersion: 'workflow-analyzer@2',
    profile: 'test-analyzer',
    profileSha256: 'b'.repeat(64),
    cliVersion: 'codex-cli 0.120.0',
    model: 'gpt-5.6-terra',
    effort: 'medium',
    serviceTier: 'fast',
    sessionId,
    promptHash: createHash('sha256').update(sessionId).digest('hex'),
    durationMs: 1_250,
    usage: {
      inputTokens: 1_200,
      cachedInputTokens: 800,
      outputTokens: 240,
      reasoningOutputTokens: 40,
    },
    hypotheticalApiCostUsd: null,
  });

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('operation-scoped workflow persistence', () => {
  it('restores only the exact workflow operation after process restart', () => {
    const filename = databasePath();
    const clock = makeAdjustableClock('2026-08-01T12:00:00.000Z');
    const { fixture } = workflowFixture();
    const operationId = 'tasker:v3:fixture:run-a:planning:workflow-candidate:1';
    const firstLedger = openSqliteLedger({ filename, clock });
    const generated = createM1WorkflowService(
      firstLedger.repository,
      clock,
    ).assembleTaskAtOperation(fixture, operationId);
    expect(generated).toMatchObject({ ok: true, value: { status: 'ready' } });
    firstLedger.close();

    const restartedLedger = openSqliteLedger({ filename, clock });
    const restarted = createM1WorkflowService(restartedLedger.repository, clock);
    expect(restarted.readPlanningOperation(fixture.fixtureId, operationId)).toEqual(generated);
    expect(
      restarted.readPlanningOperation(
        fixture.fixtureId,
        'tasker:v3:fixture:run-b:planning:workflow-candidate:1',
      ),
    ).toEqual({ ok: true, value: null });
    expect(restartedLedger.repository.readSnapshot(`snapshot:${operationId}`)).not.toBeNull();
    expect(restartedLedger.repository.readArtifact(`proposal:${operationId}`)).not.toBeNull();
    expect(restartedLedger.repository.readArtifact(`graph:${operationId}`)).not.toBeNull();
    restartedLedger.close();
  });

  it('isolates two runs of the same task including graph and provider session', () => {
    const clock = makeAdjustableClock('2026-08-01T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: databasePath(), clock });
    const service = createM1WorkflowService(ledger.repository, clock);
    const { fixture, output } = workflowFixture();
    const episodeA = 'tasker:v3:fixture:run-a:planning';
    const episodeB = 'tasker:v3:fixture:run-b:planning';
    const operationA = `${episodeA}:workflow-candidate:1`;
    const operationB = `${episodeB}:workflow-candidate:1`;

    const runA = service.assembleFromAnalyzerOutputAtOperation(
      fixture,
      output,
      receipt('session-run-a'),
      operationA,
    );
    expect(runA).toMatchObject({ ok: true, value: { status: 'ready' } });

    if (output.source.root.kind !== 'sequence') throw new Error('Expected sequence proposal');
    const runBOutput = WorkflowAnalyzerOutputSchema.parse({
      ...output,
      source: {
        ...output.source,
        root: {
          ...output.source.root,
          children: [
            { kind: 'step', id: 'unknown-step', uses: 'unknown.step@1', with: {} },
            ...output.source.root.children,
          ],
        },
      },
    });
    const runB = service.assembleFromAnalyzerOutputAtOperation(
      fixture,
      runBOutput,
      receipt('session-run-b'),
      operationB,
    );
    expect(runB).toMatchObject({ ok: true, value: { status: 'rejected' } });

    expect(service.readPlanningOperation(fixture.fixtureId, operationA)).toEqual(runA);
    expect(service.readPlanningOperation(fixture.fixtureId, operationB)).toEqual(runB);
    expect(service.readActivity(fixture.fixtureId, episodeA)).toMatchObject({
      ok: true,
      value: { providerSession: { sessionId: 'session-run-a' } },
    });
    expect(service.readActivity(fixture.fixtureId, episodeB)).toMatchObject({
      ok: true,
      value: { providerSession: { sessionId: 'session-run-b' } },
    });
    expect(
      ledger.repository.readProjection(M1_WORKFLOW_OPERATION_PROJECTION, operationA)?.payload,
    ).toMatchObject({ workflow: { status: 'valid' } });
    expect(
      ledger.repository.readProjection(M1_WORKFLOW_OPERATION_PROJECTION, operationB)?.payload,
    ).toMatchObject({ workflow: { status: 'rejected' } });
    expect(ledger.repository.readProjection('m1_workflow', fixture.fixtureId)).toBeNull();
    expect(ledger.repository.readProjection('m1_analyzer', fixture.fixtureId)).toBeNull();
    ledger.close();
  });

  it('deduplicates an exact operation without accepting another run as its result', () => {
    const clock = makeAdjustableClock('2026-08-01T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: databasePath(), clock });
    const service = createM1WorkflowService(ledger.repository, clock);
    const { fixture, output } = workflowFixture();
    const operationId = 'tasker:v3:fixture:run-provider:planning:workflow-candidate:1';
    const first = service.assembleFromAnalyzerOutputAtOperation(
      fixture,
      output,
      receipt('session-first'),
      operationId,
    );
    const duplicate = service.assembleFromAnalyzerOutputAtOperation(
      fixture,
      output,
      receipt('session-ignored'),
      operationId,
    );
    expect(duplicate).toEqual(first);
    expect(
      service.readActivity(fixture.fixtureId, 'tasker:v3:fixture:run-provider:planning'),
    ).toMatchObject({
      ok: true,
      value: { providerSession: { sessionId: 'session-first' } },
    });
    ledger.close();
  });

  it('restores an immutable dynamic continuation subject after restart', () => {
    const filename = databasePath();
    const clock = makeAdjustableClock('2026-08-03T12:00:00.000Z');
    const { fixture } = workflowFixture();
    const taskReference = 'continuation-avia-13236-short-bug-run-scope-1';
    const subject = {
      schemaVersion: 1 as const,
      repositoryPath: '/managed/twiket-ui-kit',
      task: { ...fixture, fixtureId: taskReference, repository: 'twiket/ui-kit' },
      taskSnapshot: { origin: 'workflow_continuation', parentTaskReference: fixture.fixtureId },
    };
    const firstLedger = openSqliteLedger({ filename, clock });
    const firstService = createM1WorkflowService(firstLedger.repository, clock);
    expect(firstService.saveGenerationSubject(taskReference, subject)).toEqual({
      ok: true,
      value: subject,
    });
    firstLedger.close();

    const restartedLedger = openSqliteLedger({ filename, clock });
    const restartedService = createM1WorkflowService(restartedLedger.repository, clock);
    const source = new WorkflowGenerationSubjectSource(
      '/fixture-repository',
      undefined,
      restartedService,
    );
    expect(source.resolve(taskReference)).toEqual({ ok: true, value: subject });
    expect(
      restartedService.saveGenerationSubject(taskReference, {
        ...subject,
        repositoryPath: '/different-checkout',
      }),
    ).toMatchObject({
      ok: false,
      error: { kind: 'store_failure', error: { kind: 'generation_subject_conflict' } },
    });
    restartedLedger.close();
  });
});
