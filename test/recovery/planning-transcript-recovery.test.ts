import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openSqliteLedger } from '../../src/store/index.js';
import { PlanningTranscriptStore } from '../../src/server/planning-transcript.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';

describe('planning transcript recovery', () => {
  it('continues the same bounded transcript after a worker-side store restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-planning-transcript-'));
    const databasePath = join(directory, 'ledger.sqlite');
    const clock = makeAdjustableClock('2026-08-03T12:00:00.000Z');
    const operationId = 'tasker:avia-13236-short-bug:planning:1';
    const firstLedger = openSqliteLedger({ filename: databasePath, clock });
    const firstStore = new PlanningTranscriptStore(firstLedger.repository, clock, {
      maxBytes: 80,
      chunkBytes: 16,
    });

    expect(
      firstStore.append(operationId, 1, 'stdout', 'first provider output\n', 'jira:AVIA-13236').ok,
    ).toBe(true);
    expect(firstStore.append(operationId, 1, 'stderr', 'warning\n', 'jira:AVIA-13236').ok).toBe(
      true,
    );
    firstLedger.close();

    const restartedLedger = openSqliteLedger({ filename: databasePath, clock });
    try {
      const restartedStore = new PlanningTranscriptStore(restartedLedger.repository, clock, {
        maxBytes: 80,
        chunkBytes: 16,
      });
      expect(
        restartedStore.append(
          operationId,
          2,
          'stdout',
          'second provider attempt has enough output to cross the configured transcript limit',
          'jira:AVIA-13236',
        ).ok,
      ).toBe(true);

      const transcript = restartedStore.read(operationId);
      expect(transcript.ok).toBe(true);
      if (!transcript.ok) return;
      expect(transcript.value.transcriptId).toBe(`planning-transcript:${operationId}`);
      expect(transcript.value.chunks.map((chunk) => chunk.sequence)).toEqual(
        transcript.value.chunks.map((_, index) => index + 1),
      );
      expect(transcript.value.chunks.some((chunk) => chunk.providerAttempt === 1)).toBe(true);
      expect(transcript.value.chunks.some((chunk) => chunk.providerAttempt === 2)).toBe(true);
      expect(transcript.value.totalBytes).toBeLessThanOrEqual(80);
      expect(transcript.value.truncated).toBe(true);
    } finally {
      restartedLedger.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('lists planning transcript operations by prefix and reads each stream in sequence order', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-planning-transcript-range-'));
    const databasePath = join(directory, 'ledger.sqlite');
    const clock = makeAdjustableClock('2026-08-03T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: databasePath, clock });

    try {
      const store = new PlanningTranscriptStore(ledger.repository, clock, {
        maxBytes: 256,
        chunkBytes: 8,
      });
      const prefix = 'tasker:avia-13236-short-bug:planning:';
      const firstOperationId = `${prefix}1`;
      const secondOperationId = `${prefix}2`;

      expect(store.append(firstOperationId, 1, 'stdout', 'abcdefghijk', 'jira:AVIA-13236').ok).toBe(
        true,
      );
      expect(store.append(secondOperationId, 2, 'stderr', 'warning', 'jira:AVIA-13236').ok).toBe(
        true,
      );

      expect(store.listOperationIds('jira:AVIA-13236', prefix)).toEqual([
        firstOperationId,
        secondOperationId,
      ]);
      expect(store.read(firstOperationId)).toMatchObject({
        ok: true,
        value: {
          chunks: [
            { sequence: 1, providerAttempt: 1, content: 'abcdefgh' },
            { sequence: 2, providerAttempt: 1, content: 'ijk' },
          ],
        },
      });
      expect(store.read(secondOperationId)).toMatchObject({
        ok: true,
        value: {
          chunks: [{ sequence: 1, providerAttempt: 2, content: 'warning' }],
        },
      });
    } finally {
      ledger.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
