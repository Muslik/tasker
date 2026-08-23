import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { systemClock } from '../../src/shared/clock.js';
import { TaskStepEvidenceStore } from '../../src/temporal/activities/task-step-evidence.js';
import { TaskStepFilesystemStore } from '../../src/temporal/activities/task-step-filesystem.js';
import { TaskStepIntegrationEvidenceSink } from '../../src/temporal/activities/integration-evidence-sink.js';

describe('integration evidence sink', () => {
  let root: string | null = null;
  let ledger: SqliteLedger | null = null;

  afterEach(async () => {
    ledger?.close();
    ledger = null;
    if (root !== null) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it('persists provider evidence for read-only mounting into the next agent step', async () => {
    root = await mkdtemp(join(tmpdir(), 'tasker-integration-evidence-'));
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const filesystem = new TaskStepFilesystemStore(root);
    const evidence = new TaskStepEvidenceStore(ledger.repository, systemClock);
    const sink = new TaskStepIntegrationEvidenceSink(filesystem, evidence);

    const persisted = await sink.persist('delivery:attempt-1', [
      {
        relativePath: 'jenkins/build-1/flight-card-actual.png',
        bytes: new TextEncoder().encode('actual-image'),
      },
    ]);

    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;
    const materialized = await evidence.materializeInputs(
      persisted.artifactIds,
      join(root, 'mounted-inputs'),
    );
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    expect(materialized.value).toMatchObject([
      {
        relativePath: 'jenkins/build-1/flight-card-actual.png',
        mimeType: 'image/png',
        source: 'evidence',
      },
    ]);
    expect(await readFile(materialized.value[0]?.path ?? '', 'utf8')).toBe('actual-image');
  });
});
