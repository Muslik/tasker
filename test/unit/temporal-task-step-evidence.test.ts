import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openSqliteLedger } from '../../src/store/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import {
  TaskStepEvidenceStore,
  normalizeTaskStepEvidencePaths,
} from '../../src/steps/activities/task-step-evidence.js';
import { TemporalTaskStepTraceStore } from '../../src/steps/activities/block-execution.js';
import { TaskStepEvidenceArtifactSchema } from '../../src/steps/task-step-evidence-contracts.js';

describe('task step evidence store', () => {
  it('normalizes only absolute evidence paths inside the owned artifact root', () => {
    const normalized = normalizeTaskStepEvidencePaths(
      {
        status: 'completed',
        output: {
          evidence: [
            { path: '/tasker/artifacts/run-1/screenshots/before.png' },
            { path: '/workspace/product.png' },
          ],
        },
      },
      '/tasker/artifacts/run-1',
    );

    expect(normalized).toEqual({
      status: 'completed',
      output: {
        evidence: [{ path: 'screenshots/before.png' }, { path: '/workspace/product.png' }],
      },
    });
  });

  it('registers stable logical artifacts without putting absolute paths in payloads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tasker-evidence-'));
    const nested = join(root, 'screenshots');
    mkdirSync(nested);
    writeFileSync(join(nested, 'before.png'), 'image bytes', 'utf8');
    const clock = makeAdjustableClock('2026-08-22T00:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    const store = new TaskStepEvidenceStore(ledger.repository, clock);

    try {
      const first = await store.register('workflow:run:investigate:attempt-1', root);
      const redelivered = await store.register('workflow:run:investigate:attempt-1', root);

      expect(first.ok).toBe(true);
      expect(redelivered).toEqual(first);
      if (!first.ok) return;
      expect(first.value).toHaveLength(1);
      const artifactId = first.value[0];
      if (artifactId === undefined) throw new Error('Expected registered evidence');
      const artifact = ledger.repository.readArtifact(artifactId);
      expect(artifact?.artifactKind).toBe('task_step_evidence');
      const payload = TaskStepEvidenceArtifactSchema.parse(artifact?.payload);
      expect(payload).toMatchObject({
        operationId: 'workflow:run:investigate:attempt-1',
        relativePath: 'screenshots/before.png',
        mimeType: 'image/png',
      });
      expect(JSON.stringify(payload)).not.toContain(root);
      expect(artifact?.storageUri).toMatch(/^file:/u);
    } finally {
      ledger.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects symbolic links instead of importing files outside the artifact root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tasker-evidence-'));
    const outside = join(root, '..', `tasker-outside-${String(process.pid)}.txt`);
    writeFileSync(outside, 'outside', 'utf8');
    symlinkSync(outside, join(root, 'escape.txt'));
    const clock = makeAdjustableClock('2026-08-22T00:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    const store = new TaskStepEvidenceStore(ledger.repository, clock);

    try {
      const result = await store.register('workflow:run:investigate:attempt-1', root);

      expect(result).toEqual({
        ok: false,
        error: { kind: 'invalid_entry', relativePath: 'escape.txt' },
      });
    } finally {
      ledger.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });

  it('materializes a bounded immutable receipt for downstream review', async () => {
    const inputsPath = mkdtempSync(join(tmpdir(), 'tasker-evidence-inputs-'));
    const clock = makeAdjustableClock('2026-08-22T00:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, clock);
    const store = new TaskStepEvidenceStore(ledger.repository, clock);

    try {
      const persisted = traces.persistOutputArtifact({
        operationId: 'workflow:verify:attempt-1',
        workflowId: 'workflow',
        workflowRunId: 'run',
        nodeId: 'verify',
        stepReference: 'verify.acceptance@1',
        stepAttempt: 1,
        runner: 'agent',
        command: 'codex',
        args: [],
        cwd: '/workspace',
        exitCode: 0,
        status: 'completed',
        stdout: `${'discarded-prefix'.repeat(1_000)}\nstylelint passed\n`,
        stderr: '',
        details: { output: { summary: 'Verification accepted' } },
        result: {
          status: 'completed',
          summary: 'Verification accepted',
          artifactIds: [],
          transcriptId: 'transcript:verify',
        },
      });
      if (!persisted.ok) throw new Error('Receipt fixture was not persisted');

      const materialized = await store.materializeInputs([persisted.value.artifactId], inputsPath);
      expect(materialized.ok).toBe(true);
      if (!materialized.ok || materialized.value[0] === undefined) return;
      const input = materialized.value[0];
      expect(input).toMatchObject({
        artifactId: persisted.value.artifactId,
        mimeType: 'application/json',
        source: 'receipt',
      });
      const receipt = JSON.parse(readFileSync(input.path, 'utf8')) as {
        readonly details: unknown;
        readonly stdoutTail: string;
      };
      expect(receipt.details).toEqual({ output: { summary: 'Verification accepted' } });
      expect(receipt.stdoutTail).toContain('stylelint passed');
      expect(receipt.stdoutTail.length).toBeLessThanOrEqual(8_000);
    } finally {
      ledger.close();
      rmSync(inputsPath, { recursive: true, force: true });
    }
  });
});
