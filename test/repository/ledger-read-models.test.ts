import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteLedger } from '../../src/store/index.js';

const FIXED_NOW = '2026-08-01T12:00:00.000Z';
const directories: string[] = [];

const databasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'tasker-read-models-'));
  directories.push(directory);
  return join(directory, 'ledger.sqlite');
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('LedgerRepository read models', () => {
  it('reads projections, snapshots, and artifacts through typed repository methods', () => {
    const ledger = openSqliteLedger({
      filename: databasePath(),
      clock: { now: () => FIXED_NOW },
    });

    const committed = ledger.repository.transact({
      aggregate: {
        aggregateId: 'intake-fixture-1',
        expectedVersion: 0,
        events: [
          {
            eventId: 'event-fixture-1',
            eventType: 'WorkflowProposed',
            eventSchemaVersion: 1,
            payload: { fixtureId: 'fixture-1' },
          },
        ],
      },
      projections: [
        {
          kind: 'upsert',
          projectionType: 'task',
          projectionId: 'task-fixture-1',
          payload: { status: 'planned' },
        },
        {
          kind: 'upsert',
          projectionType: 'workflow',
          projectionId: 'fixture-1',
          payload: { graphHash: 'sha256' },
        },
      ],
      snapshots: [
        {
          snapshotId: 'snapshot-fixture-1',
          aggregateId: 'intake-fixture-1',
          aggregateVersion: 1,
          snapshotSchemaVersion: 1,
          payload: { graphHash: 'sha256' },
        },
      ],
      artifacts: [
        {
          artifactId: 'proposal-fixture-1',
          artifactKind: 'workflow_proposal',
          storageUri: 'ledger://artifacts/proposal-fixture-1',
          payload: { analyzerVersion: 'workflow-analyzer@2' },
          metadata: { source: 'test_analyzer' },
        },
      ],
    });

    expect(committed.ok).toBe(true);
    expect(ledger.repository.listProjections('workflow')).toMatchObject([
      {
        projectionType: 'workflow',
        projectionId: 'fixture-1',
        payload: { graphHash: 'sha256' },
      },
    ]);
    expect(ledger.repository.readSnapshot('snapshot-fixture-1')).toMatchObject({
      aggregateId: 'intake-fixture-1',
      aggregateVersion: 1,
      payload: { graphHash: 'sha256' },
    });
    expect(ledger.repository.readArtifact('proposal-fixture-1')).toMatchObject({
      artifactKind: 'workflow_proposal',
      payload: { analyzerVersion: 'workflow-analyzer@2' },
      metadata: { source: 'test_analyzer' },
      parentArtifactId: null,
    });

    ledger.close();
  });
});
