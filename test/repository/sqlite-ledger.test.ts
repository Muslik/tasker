import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  openSqliteLedger,
  readLedgerMigrations,
  defaultMigrationsDirectory,
} from '../../src/store/index.js';

const FIXED_NOW = '2026-08-01T12:00:00.000Z';

const createdPaths: string[] = [];

const makeTempDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'tasker-ledger-'));
  createdPaths.push(directory);
  return directory;
};

const withDatabasePath = (): string => {
  const directory = makeTempDirectory();
  return join(directory, 'ledger.sqlite');
};

afterEach(() => {
  while (createdPaths.length > 0) {
    const path = createdPaths.pop();
    if (path !== undefined) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe('openSqliteLedger', () => {
  it('applies migrations idempotently and configures canonical pragmas', () => {
    const filename = withDatabasePath();
    const first = openSqliteLedger({
      filename,
      busyTimeoutMs: 1_234,
      clock: { now: () => FIXED_NOW },
    });

    expect(first.appliedMigrations).toHaveLength(2);
    expect(first.database.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(first.database.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(first.database.pragma('busy_timeout', { simple: true })).toBe(1_234);
    expect(first.database.pragma('synchronous', { simple: true })).toBe(2);

    first.close();

    const second = openSqliteLedger({
      filename,
      busyTimeoutMs: 1_234,
      clock: { now: () => FIXED_NOW },
    });

    expect(readLedgerMigrations(second.database)).toEqual(first.appliedMigrations);
    expect(
      second.database
        .prepare<[string], { value: string }>('SELECT value FROM schema_metadata WHERE key = ?')
        .get('schema_family'),
    ).toEqual({ value: 'tasker' });
    expect(
      second.database
        .prepare<[string], { value: string }>('SELECT value FROM schema_metadata WHERE key = ?')
        .get('schema_baseline'),
    ).toEqual({ value: 'product-store-v1' });

    second.close();
  });

  it('rejects a changed migration checksum', () => {
    const filename = withDatabasePath();
    const migrationsDirectory = join(makeTempDirectory(), 'migrations');
    mkdirSync(migrationsDirectory, { recursive: true });
    cpSync(defaultMigrationsDirectory, migrationsDirectory, { recursive: true });

    const first = openSqliteLedger({
      filename,
      migrationsDirectory,
      clock: { now: () => FIXED_NOW },
    });
    first.close();

    const migrationPath = join(migrationsDirectory, '0001_tasker_baseline.sql');
    writeFileSync(
      migrationPath,
      `${readFileSync(migrationPath, 'utf8')}\n-- checksum changed\n`,
      'utf8',
    );

    expect(() =>
      openSqliteLedger({
        filename,
        migrationsDirectory,
        clock: { now: () => FIXED_NOW },
      }),
    ).toThrow(/Migration checksum mismatch/);
  });

  it('fails closed when an applied migration source is missing or renamed', () => {
    const missingFilename = withDatabasePath();
    const missingDirectory = join(makeTempDirectory(), 'migrations-missing');
    mkdirSync(missingDirectory, { recursive: true });
    cpSync(defaultMigrationsDirectory, missingDirectory, { recursive: true });

    const seededMissing = openSqliteLedger({
      filename: missingFilename,
      migrationsDirectory: missingDirectory,
      clock: { now: () => FIXED_NOW },
    });
    seededMissing.close();

    rmSync(join(missingDirectory, '0001_tasker_baseline.sql'));

    expect(() =>
      openSqliteLedger({
        filename: missingFilename,
        migrationsDirectory: missingDirectory,
        clock: { now: () => FIXED_NOW },
      }),
    ).toThrow(/missing from source definitions/);

    const renamedFilename = withDatabasePath();
    const renamedDirectory = join(makeTempDirectory(), 'migrations-renamed');
    mkdirSync(renamedDirectory, { recursive: true });
    cpSync(defaultMigrationsDirectory, renamedDirectory, { recursive: true });

    const seededRenamed = openSqliteLedger({
      filename: renamedFilename,
      migrationsDirectory: renamedDirectory,
      clock: { now: () => FIXED_NOW },
    });
    seededRenamed.close();

    const originalPath = join(renamedDirectory, '0001_tasker_baseline.sql');
    const renamedPath = join(renamedDirectory, '0001_renamed.sql');
    writeFileSync(renamedPath, readFileSync(originalPath, 'utf8'), 'utf8');
    rmSync(originalPath);

    expect(() =>
      openSqliteLedger({
        filename: renamedFilename,
        migrationsDirectory: renamedDirectory,
        clock: { now: () => FIXED_NOW },
      }),
    ).toThrow(/name mismatch/);
  });
});

describe('LedgerRepository', () => {
  it('quarantines unsupported event and snapshot schema versions without a partial write', () => {
    const ledger = openSqliteLedger({
      filename: withDatabasePath(),
      clock: { now: () => FIXED_NOW },
    });

    const unsupportedEvent = ledger.repository.transact({
      aggregate: {
        aggregateId: 'run-versioned',
        expectedVersion: 0,
        events: [
          {
            eventId: 'event-unsupported',
            eventType: 'RunCreated',
            eventSchemaVersion: 2,
            payload: {},
          },
        ],
      },
    });
    const unsupportedSnapshot = ledger.repository.transact({
      snapshots: [
        {
          snapshotId: 'snapshot-unsupported',
          aggregateId: 'run-versioned',
          aggregateVersion: 0,
          snapshotSchemaVersion: 2,
          payload: {},
        },
      ],
    });
    const snapshotCount = ledger.database
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM snapshots')
      .get()?.count;

    expect(unsupportedEvent).toEqual({
      ok: false,
      error: {
        kind: 'unsupported_schema_version',
        schemaKind: 'event',
        receivedVersion: 2,
        supportedVersion: 1,
        recovery: 'quarantine',
      },
    });
    expect(unsupportedSnapshot).toEqual({
      ok: false,
      error: {
        kind: 'unsupported_schema_version',
        schemaKind: 'snapshot',
        receivedVersion: 2,
        supportedVersion: 1,
        recovery: 'quarantine',
      },
    });
    expect(ledger.repository.listEvents()).toEqual([]);
    expect(snapshotCount).toBe(0);

    ledger.close();
  });

  it('persists artifact metadata instead of dropping it at the ledger boundary', () => {
    const ledger = openSqliteLedger({
      filename: withDatabasePath(),
      clock: { now: () => FIXED_NOW },
    });

    const result = ledger.repository.transact({
      artifacts: [
        {
          artifactId: 'artifact-1',
          artifactKind: 'debug_bundle',
          storageUri: 'file:///tmp/debug-bundle.json',
          payload: { safe: true },
          metadata: { redactionStatus: 'clean' },
        },
      ],
    });
    const row = ledger.database
      .prepare<[], { metadata_json: string }>(
        "SELECT metadata_json FROM artifacts WHERE artifact_id = 'artifact-1'",
      )
      .get();

    expect(result.ok).toBe(true);
    expect(row).toEqual({ metadata_json: '{"redactionStatus":"clean"}' });

    ledger.close();
  });

  it('rolls back the full transaction when an artifact insert fails', () => {
    const ledger = openSqliteLedger({
      filename: withDatabasePath(),
      clock: { now: () => FIXED_NOW },
    });

    expect(() =>
      ledger.repository.transact({
        aggregate: {
          aggregateId: 'task-1',
          expectedVersion: 0,
          events: [
            {
              eventId: 'evt-1',
              eventType: 'TaskCreated',
              eventSchemaVersion: 1,
              payload: { taskId: 'task-1' },
            },
          ],
        },
        projections: [
          {
            kind: 'upsert',
            projectionType: 'task',
            projectionId: 'task-1',
            payload: { status: 'ready' },
          },
        ],
        artifacts: [
          {
            artifactId: 'artifact-with-missing-parent',
            artifactKind: 'debug_bundle',
            storageUri: 'file:///tmp/debug-bundle.json',
            payload: {},
            parentArtifactId: 'missing-parent',
          },
        ],
      }),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(ledger.repository.readAggregateHead('task-1')).toBeNull();
    expect(ledger.repository.listEvents('task-1')).toEqual([]);
    expect(ledger.repository.readProjection('task', 'task-1')).toBeNull();
    expect(ledger.repository.readArtifact('artifact-with-missing-parent')).toBeNull();

    ledger.close();
  });

  it('reports CAS conflicts without partial writes', () => {
    const ledger = openSqliteLedger({
      filename: withDatabasePath(),
      clock: { now: () => FIXED_NOW },
    });

    const seeded = ledger.repository.transact({
      aggregate: {
        aggregateId: 'task-2',
        expectedVersion: 0,
        events: [
          {
            eventId: 'evt-seed',
            eventType: 'TaskCreated',
            eventSchemaVersion: 1,
            payload: { taskId: 'task-2' },
          },
        ],
      },
    });

    expect(seeded.ok).toBe(true);

    const result = ledger.repository.transact({
      aggregate: {
        aggregateId: 'task-2',
        expectedVersion: 0,
        events: [
          {
            eventId: 'evt-cas',
            eventType: 'TaskUpdated',
            eventSchemaVersion: 1,
            payload: { taskId: 'task-2', status: 'conflicted' },
          },
        ],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'version_conflict',
        aggregateId: 'task-2',
        expectedVersion: 0,
        actualVersion: 1,
      },
    });
    expect(ledger.repository.listEvents('task-2')).toHaveLength(1);

    ledger.close();
  });

  it('commits event and projection state atomically', () => {
    const ledger = openSqliteLedger({
      filename: withDatabasePath(),
      clock: { now: () => FIXED_NOW },
    });

    const result = ledger.repository.transact({
      aggregate: {
        aggregateId: 'task-3',
        expectedVersion: 0,
        events: [
          {
            eventId: 'evt-3',
            eventType: 'TaskCreated',
            eventSchemaVersion: 1,
            payload: { taskId: 'task-3' },
          },
        ],
      },
      projections: [
        {
          kind: 'upsert',
          projectionType: 'task',
          projectionId: 'task-3',
          payload: { status: 'leased' },
          lastEventSequence: 1,
        },
      ],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        aggregateId: 'task-3',
        aggregateVersion: 1,
        appendedEventCount: 1,
        lastEventSequence: 1,
      },
    });
    const projection = ledger.repository.readProjection('task', 'task-3');
    expect(projection).not.toBeNull();
    expect(projection?.projectionType).toBe('task');
    expect(projection?.projectionId).toBe('task-3');
    expect(projection?.payload).toEqual({ status: 'leased' });
    expect(typeof projection?.checksum).toBe('string');
    expect(projection?.updatedAt).toBe(FIXED_NOW);
    expect(projection?.lastEventSequence).toBe(1);
    ledger.close();
  });
});
