import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  openSqliteLedger,
  readLedgerMigrations,
  defaultMigrationsDirectory,
} from '../../src/ledger/index.js';

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

    expect(first.appliedMigrations).toHaveLength(1);
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

    const migrationPath = join(migrationsDirectory, '0001_m0_baseline.sql');
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

    rmSync(join(missingDirectory, '0001_m0_baseline.sql'));

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

    const originalPath = join(renamedDirectory, '0001_m0_baseline.sql');
    const renamedPath = join(renamedDirectory, '0001_m0_renamed.sql');
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
      outbox: [{ commandId: 'must-not-exist', topic: 'dispatch', payload: {} }],
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
    expect(ledger.repository.listOutbox()).toEqual([]);
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

  it('rolls back the full transaction when outbox insertion conflicts', () => {
    const ledger = openSqliteLedger({
      filename: withDatabasePath(),
      clock: { now: () => FIXED_NOW },
    });

    const first = ledger.repository.transact({
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
      outbox: [
        {
          commandId: 'cmd-1',
          topic: 'dispatch',
          payload: { taskId: 'task-1' },
        },
      ],
    });

    expect(first).toEqual({
      ok: true,
      value: {
        aggregateId: 'task-1',
        aggregateVersion: 1,
        appendedEventCount: 1,
        lastEventSequence: 1,
        outboxCount: 1,
        lease: null,
      },
    });

    const second = ledger.repository.transact({
      aggregate: {
        aggregateId: 'task-1',
        expectedVersion: 1,
        events: [
          {
            eventId: 'evt-2',
            eventType: 'TaskUpdated',
            eventSchemaVersion: 1,
            payload: { taskId: 'task-1', status: 'ready' },
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
      outbox: [
        {
          commandId: 'cmd-1',
          topic: 'dispatch',
          payload: { taskId: 'task-1', status: 'ready' },
        },
      ],
    });

    expect(second).toEqual({
      ok: false,
      error: {
        kind: 'duplicate_outbox_command_id',
        commandId: 'cmd-1',
      },
    });
    expect(ledger.repository.readAggregateHead('task-1')).toEqual({
      aggregateId: 'task-1',
      version: 1,
      updatedAt: FIXED_NOW,
    });
    expect(ledger.repository.listEvents('task-1')).toHaveLength(1);
    expect(ledger.repository.readProjection('task', 'task-1')).toBeNull();
    expect(ledger.repository.listOutbox()).toHaveLength(1);

    ledger.close();
  });

  it('reports CAS conflicts without exposing outbox commands', () => {
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
      outbox: [
        {
          commandId: 'cmd-cas',
          topic: 'dispatch',
          payload: { aggregateId: 'task-2' },
        },
      ],
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
    expect(ledger.repository.listOutbox()).toHaveLength(0);

    ledger.close();
  });

  it('commits event, projection, outbox, and lease state atomically with the new fence token', () => {
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
      outbox: [
        {
          commandId: 'cmd-3',
          topic: 'dispatch',
          payload: { taskId: 'task-3' },
          leaseKey: 'runner/task-3',
        },
      ],
      lease: {
        kind: 'acquire',
        leaseKey: 'runner/task-3',
        ownerId: 'runner-a',
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        aggregateId: 'task-3',
        aggregateVersion: 1,
        appendedEventCount: 1,
        lastEventSequence: 1,
        outboxCount: 1,
        lease: {
          leaseKey: 'runner/task-3',
          ownerId: 'runner-a',
          fenceToken: 1,
          status: 'active',
        },
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
    expect(ledger.repository.listOutbox()).toEqual([
      {
        commandId: 'cmd-3',
        topic: 'dispatch',
        payload: { taskId: 'task-3' },
        headers: {},
        createdAt: FIXED_NOW,
        visibleAt: FIXED_NOW,
        leaseKey: 'runner/task-3',
        leaseFenceToken: 1,
        dispatchedAt: null,
        attempts: 0,
      },
    ]);
    expect(ledger.repository.readLease('runner/task-3')).toEqual({
      leaseKey: 'runner/task-3',
      ownerId: 'runner-a',
      fenceToken: 1,
      status: 'active',
      acquiredAt: FIXED_NOW,
      renewedAt: FIXED_NOW,
      releasedAt: null,
      metadata: {},
    });

    ledger.close();
  });

  it('increments the fence token on replacement and rejects stale completion', () => {
    const ledger = openSqliteLedger({
      filename: withDatabasePath(),
      clock: { now: () => FIXED_NOW },
    });

    const firstAcquire = ledger.repository.transact({
      lease: {
        kind: 'acquire',
        leaseKey: 'runner/task-4',
        ownerId: 'runner-a',
      },
    });
    const secondAcquire = ledger.repository.transact({
      lease: {
        kind: 'acquire',
        leaseKey: 'runner/task-4',
        ownerId: 'runner-b',
      },
    });

    expect(firstAcquire).toEqual({
      ok: true,
      value: {
        aggregateId: null,
        aggregateVersion: null,
        appendedEventCount: 0,
        lastEventSequence: null,
        outboxCount: 0,
        lease: {
          leaseKey: 'runner/task-4',
          ownerId: 'runner-a',
          fenceToken: 1,
          status: 'active',
        },
      },
    });
    expect(secondAcquire).toEqual({
      ok: true,
      value: {
        aggregateId: null,
        aggregateVersion: null,
        appendedEventCount: 0,
        lastEventSequence: null,
        outboxCount: 0,
        lease: {
          leaseKey: 'runner/task-4',
          ownerId: 'runner-b',
          fenceToken: 2,
          status: 'active',
        },
      },
    });

    const staleRelease = ledger.repository.transact({
      lease: {
        kind: 'release',
        leaseKey: 'runner/task-4',
        ownerId: 'runner-a',
        expectedFenceToken: 1,
      },
      outbox: [
        {
          commandId: 'cmd-stale',
          topic: 'complete',
          payload: { leaseKey: 'runner/task-4' },
        },
      ],
    });

    expect(staleRelease).toEqual({
      ok: false,
      error: {
        kind: 'stale_fence',
        leaseKey: 'runner/task-4',
        expectedFenceToken: 1,
        actualFenceToken: 2,
        actualOwnerId: 'runner-b',
        actualStatus: 'active',
      },
    });
    expect(ledger.repository.readLease('runner/task-4')).toEqual({
      leaseKey: 'runner/task-4',
      ownerId: 'runner-b',
      fenceToken: 2,
      status: 'active',
      acquiredAt: FIXED_NOW,
      renewedAt: FIXED_NOW,
      releasedAt: null,
      metadata: {},
    });
    expect(ledger.repository.listOutbox()).toHaveLength(0);

    ledger.close();
  });

  it('rejects a fenced-out runner completion before any durable mutation becomes visible', () => {
    const ledger = openSqliteLedger({
      filename: withDatabasePath(),
      clock: { now: () => FIXED_NOW },
    });

    expect(
      ledger.repository.transact({
        aggregate: {
          aggregateId: 'task-5',
          expectedVersion: 0,
          events: [
            {
              eventId: 'evt-5-seed',
              eventType: 'TaskCreated',
              eventSchemaVersion: 1,
              payload: { taskId: 'task-5' },
            },
          ],
        },
        lease: {
          kind: 'acquire',
          leaseKey: 'runner/task-5',
          ownerId: 'runner-a',
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        aggregateId: 'task-5',
        aggregateVersion: 1,
        appendedEventCount: 1,
        lastEventSequence: 1,
        outboxCount: 0,
        lease: {
          leaseKey: 'runner/task-5',
          ownerId: 'runner-a',
          fenceToken: 1,
          status: 'active',
        },
      },
    });

    expect(
      ledger.repository.transact({
        lease: {
          kind: 'acquire',
          leaseKey: 'runner/task-5',
          ownerId: 'runner-b',
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        aggregateId: null,
        aggregateVersion: null,
        appendedEventCount: 0,
        lastEventSequence: null,
        outboxCount: 0,
        lease: {
          leaseKey: 'runner/task-5',
          ownerId: 'runner-b',
          fenceToken: 2,
          status: 'active',
        },
      },
    });

    const staleCompletion = ledger.repository.transact({
      fenceGuard: {
        leaseKey: 'runner/task-5',
        ownerId: 'runner-a',
        expectedFenceToken: 1,
      },
      aggregate: {
        aggregateId: 'task-5',
        expectedVersion: 1,
        events: [
          {
            eventId: 'evt-5-complete',
            eventType: 'TaskCompleted',
            eventSchemaVersion: 1,
            payload: { taskId: 'task-5' },
          },
        ],
      },
      projections: [
        {
          kind: 'upsert',
          projectionType: 'task',
          projectionId: 'task-5',
          payload: { status: 'completed' },
        },
      ],
      outbox: [
        {
          commandId: 'cmd-5-complete',
          topic: 'complete',
          payload: { taskId: 'task-5' },
          leaseKey: 'runner/task-5',
        },
      ],
    });

    expect(staleCompletion).toEqual({
      ok: false,
      error: {
        kind: 'stale_fence',
        leaseKey: 'runner/task-5',
        expectedFenceToken: 1,
        actualFenceToken: 2,
        actualOwnerId: 'runner-b',
        actualStatus: 'active',
      },
    });
    expect(ledger.repository.readAggregateHead('task-5')).toEqual({
      aggregateId: 'task-5',
      version: 1,
      updatedAt: FIXED_NOW,
    });
    expect(ledger.repository.listEvents('task-5')).toHaveLength(1);
    expect(ledger.repository.readProjection('task', 'task-5')).toBeNull();
    expect(ledger.repository.listOutbox()).toHaveLength(0);
    expect(ledger.repository.readLease('runner/task-5')).toEqual({
      leaseKey: 'runner/task-5',
      ownerId: 'runner-b',
      fenceToken: 2,
      status: 'active',
      acquiredAt: FIXED_NOW,
      renewedAt: FIXED_NOW,
      releasedAt: null,
      metadata: {},
    });

    ledger.close();
  });
});
