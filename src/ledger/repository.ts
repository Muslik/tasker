import type { Database as SqliteDatabase } from 'better-sqlite3';

import { err, ok, type Outcome } from '../shared/outcome.js';
import type { Clock } from '../shared/clock.js';

import { checksumString } from './checksum.js';
import { SUPPORTED_EVENT_SCHEMA_VERSION, SUPPORTED_SNAPSHOT_SCHEMA_VERSION } from './types.js';
import type {
  AggregateHeadRecord,
  ArtifactRecord,
  ArtifactWrite,
  EventRecord,
  JsonValue,
  LedgerCommitResult,
  LedgerConflict,
  LedgerTransaction,
  OutboxRecord,
  ProjectionRecord,
  SnapshotRecord,
  SnapshotWrite,
} from './types.js';

class ConflictSignal extends Error {
  public readonly conflict: LedgerConflict;

  public constructor(conflict: LedgerConflict) {
    super(conflict.kind);
    this.conflict = conflict;
  }
}

const raiseConflict = (conflict: LedgerConflict): never => {
  throw new ConflictSignal(conflict);
};

const toJsonText = (value: JsonValue | undefined, fallback: JsonValue = {}): string =>
  JSON.stringify(value ?? fallback);

const parseJson = (value: string): JsonValue => JSON.parse(value) as JsonValue;

const isSqliteConstraintError = (
  error: unknown,
): error is { readonly code: string; readonly message: string } =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof (error as { readonly code: unknown }).code === 'string' &&
  'message' in error &&
  typeof (error as { readonly message: unknown }).message === 'string' &&
  (error as { readonly code: string }).code.startsWith('SQLITE_CONSTRAINT');

const containsDuplicate = (values: readonly string[]): string | null => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }

    seen.add(value);
  }

  return null;
};

export class LedgerRepository {
  private readonly writeTransaction;

  public constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: Clock,
  ) {
    const transaction = this.database.transaction((input: LedgerTransaction): LedgerCommitResult =>
      this.commitTransaction(input),
    );
    this.writeTransaction = (input: LedgerTransaction): LedgerCommitResult =>
      transaction.immediate(input);
  }

  public transact(transaction: LedgerTransaction): Outcome<LedgerCommitResult, LedgerConflict> {
    try {
      return ok(this.writeTransaction(transaction));
    } catch (error) {
      if (error instanceof ConflictSignal) {
        return err(error.conflict);
      }

      throw error;
    }
  }

  public readAggregateHead(aggregateId: string): AggregateHeadRecord | null {
    const row = this.database
      .prepare<[{ readonly aggregateId: string }], { version: number; updated_at: string }>(
        `
          SELECT version, updated_at
          FROM aggregate_heads
          WHERE aggregate_id = @aggregateId
        `,
      )
      .get({ aggregateId });

    if (row === undefined) {
      return null;
    }

    return {
      aggregateId,
      version: row.version,
      updatedAt: row.updated_at,
    };
  }

  public listEvents(aggregateId?: string): readonly EventRecord[] {
    const rows =
      aggregateId === undefined
        ? this.database
            .prepare<
              [],
              {
                sequence: number;
                event_id: string;
                aggregate_id: string;
                aggregate_version: number;
                event_type: string;
                event_schema_version: number;
                payload_json: string;
                metadata_json: string;
                occurred_at: string;
                causation_id: string | null;
                correlation_id: string | null;
                actor: string | null;
              }
            >(
              `
                SELECT
                  sequence,
                  event_id,
                  aggregate_id,
                  aggregate_version,
                  event_type,
                  event_schema_version,
                  payload_json,
                  metadata_json,
                  occurred_at,
                  causation_id,
                  correlation_id,
                  actor
                FROM events
                ORDER BY sequence ASC
              `,
            )
            .all()
        : this.database
            .prepare<
              [{ readonly aggregateId: string }],
              {
                sequence: number;
                event_id: string;
                aggregate_id: string;
                aggregate_version: number;
                event_type: string;
                event_schema_version: number;
                payload_json: string;
                metadata_json: string;
                occurred_at: string;
                causation_id: string | null;
                correlation_id: string | null;
                actor: string | null;
              }
            >(
              `
                SELECT
                  sequence,
                  event_id,
                  aggregate_id,
                  aggregate_version,
                  event_type,
                  event_schema_version,
                  payload_json,
                  metadata_json,
                  occurred_at,
                  causation_id,
                  correlation_id,
                  actor
                FROM events
                WHERE aggregate_id = @aggregateId
                ORDER BY sequence ASC
              `,
            )
            .all({ aggregateId });

    return rows.map((row) => ({
      sequence: row.sequence,
      eventId: row.event_id,
      aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version,
      eventType: row.event_type,
      eventSchemaVersion: row.event_schema_version,
      payload: parseJson(row.payload_json),
      metadata: parseJson(row.metadata_json),
      occurredAt: row.occurred_at,
      causationId: row.causation_id,
      correlationId: row.correlation_id,
      actor: row.actor,
    }));
  }

  public readProjection(projectionType: string, projectionId: string): ProjectionRecord | null {
    const row = this.database
      .prepare<
        [{ readonly projectionType: string; readonly projectionId: string }],
        {
          payload_json: string;
          checksum: string;
          updated_at: string;
          last_event_sequence: number | null;
        }
      >(
        `
          SELECT payload_json, checksum, updated_at, last_event_sequence
          FROM projections
          WHERE projection_type = @projectionType
            AND projection_id = @projectionId
        `,
      )
      .get({ projectionType, projectionId });

    if (row === undefined) {
      return null;
    }

    return {
      projectionType,
      projectionId,
      payload: parseJson(row.payload_json),
      checksum: row.checksum,
      updatedAt: row.updated_at,
      lastEventSequence: row.last_event_sequence,
    };
  }

  public listProjections(projectionType?: string): readonly ProjectionRecord[] {
    const rows =
      projectionType === undefined
        ? this.database
            .prepare<
              [],
              {
                projection_type: string;
                projection_id: string;
                payload_json: string;
                checksum: string;
                updated_at: string;
                last_event_sequence: number | null;
              }
            >(
              `
                SELECT
                  projection_type,
                  projection_id,
                  payload_json,
                  checksum,
                  updated_at,
                  last_event_sequence
                FROM projections
                ORDER BY projection_type ASC, projection_id ASC
              `,
            )
            .all()
        : this.database
            .prepare<
              [{ readonly projectionType: string }],
              {
                projection_type: string;
                projection_id: string;
                payload_json: string;
                checksum: string;
                updated_at: string;
                last_event_sequence: number | null;
              }
            >(
              `
                SELECT
                  projection_type,
                  projection_id,
                  payload_json,
                  checksum,
                  updated_at,
                  last_event_sequence
                FROM projections
                WHERE projection_type = @projectionType
                ORDER BY projection_id ASC
              `,
            )
            .all({ projectionType });

    return rows.map((row) => ({
      projectionType: row.projection_type,
      projectionId: row.projection_id,
      payload: parseJson(row.payload_json),
      checksum: row.checksum,
      updatedAt: row.updated_at,
      lastEventSequence: row.last_event_sequence,
    }));
  }

  public readSnapshot(snapshotId: string): SnapshotRecord | null {
    const row = this.database
      .prepare<
        [{ readonly snapshotId: string }],
        {
          aggregate_id: string;
          aggregate_version: number;
          snapshot_schema_version: number;
          payload_json: string;
          checksum: string;
          taken_at: string;
        }
      >(
        `
          SELECT
            aggregate_id,
            aggregate_version,
            snapshot_schema_version,
            payload_json,
            checksum,
            taken_at
          FROM snapshots
          WHERE snapshot_id = @snapshotId
        `,
      )
      .get({ snapshotId });

    if (row === undefined) {
      return null;
    }

    return {
      snapshotId,
      aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version,
      snapshotSchemaVersion: row.snapshot_schema_version,
      payload: parseJson(row.payload_json),
      checksum: row.checksum,
      takenAt: row.taken_at,
    };
  }

  public readArtifact(artifactId: string): ArtifactRecord | null {
    const row = this.database
      .prepare<
        [{ readonly artifactId: string }],
        {
          artifact_kind: string;
          storage_uri: string;
          payload_json: string;
          metadata_json: string;
          checksum: string;
          created_at: string;
          parent_artifact_id: string | null;
        }
      >(
        `
          SELECT
            artifact_kind,
            storage_uri,
            payload_json,
            metadata_json,
            checksum,
            created_at,
            parent_artifact_id
          FROM artifacts
          WHERE artifact_id = @artifactId
        `,
      )
      .get({ artifactId });

    if (row === undefined) {
      return null;
    }

    return {
      artifactId,
      artifactKind: row.artifact_kind,
      storageUri: row.storage_uri,
      payload: parseJson(row.payload_json),
      metadata: parseJson(row.metadata_json),
      checksum: row.checksum,
      createdAt: row.created_at,
      parentArtifactId: row.parent_artifact_id,
    };
  }

  public listOutbox(): readonly OutboxRecord[] {
    return this.database
      .prepare<
        [],
        {
          command_id: string;
          topic: string;
          payload_json: string;
          headers_json: string;
          created_at: string;
          visible_at: string;
          dispatched_at: string | null;
          attempts: number;
        }
      >(
        `
          SELECT
            command_id,
            topic,
            payload_json,
            headers_json,
            created_at,
            visible_at,
            dispatched_at,
            attempts
          FROM outbox
          ORDER BY rowid ASC
        `,
      )
      .all()
      .map((row) => ({
        commandId: row.command_id,
        topic: row.topic,
        payload: parseJson(row.payload_json),
        headers: parseJson(row.headers_json),
        createdAt: row.created_at,
        visibleAt: row.visible_at,
        dispatchedAt: row.dispatched_at,
        attempts: row.attempts,
      }));
  }

  private commitTransaction(transaction: LedgerTransaction): LedgerCommitResult {
    const now = transaction.timestamp ?? this.clock.now();
    this.verifySchemaVersions(transaction);
    const eventIds = transaction.aggregate?.events.map((event) => event.eventId) ?? [];
    const duplicateEventId = containsDuplicate(eventIds);
    if (duplicateEventId !== null) {
      raiseConflict({ kind: 'duplicate_event_id', eventId: duplicateEventId });
    }

    const commandIds = transaction.outbox?.map((command) => command.commandId) ?? [];
    const duplicateCommandId = containsDuplicate(commandIds);
    if (duplicateCommandId !== null) {
      raiseConflict({ kind: 'duplicate_outbox_command_id', commandId: duplicateCommandId });
    }

    const aggregate = transaction.aggregate;
    let aggregateVersion: number | null = null;
    let lastEventSequence: number | null = null;
    if (aggregate !== undefined) {
      aggregateVersion = this.readCurrentVersion(aggregate.aggregateId);
      if (aggregateVersion !== aggregate.expectedVersion) {
        raiseConflict({
          kind: 'version_conflict',
          aggregateId: aggregate.aggregateId,
          expectedVersion: aggregate.expectedVersion,
          actualVersion: aggregateVersion,
        });
      }

      let nextVersion = aggregateVersion;
      for (const event of aggregate.events) {
        nextVersion += 1;
        const occurredAt = event.occurredAt ?? now;

        try {
          const result = this.database
            .prepare<
              [
                string,
                string,
                number,
                string,
                number,
                string,
                string,
                string,
                string | null,
                string | null,
                string | null,
              ]
            >(
              `
                INSERT INTO events (
                  event_id,
                  aggregate_id,
                  aggregate_version,
                  event_type,
                  event_schema_version,
                  payload_json,
                  metadata_json,
                  occurred_at,
                  causation_id,
                  correlation_id,
                  actor
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `,
            )
            .run(
              event.eventId,
              aggregate.aggregateId,
              nextVersion,
              event.eventType,
              event.eventSchemaVersion,
              toJsonText(event.payload),
              toJsonText(event.metadata),
              occurredAt,
              event.causationId ?? null,
              event.correlationId ?? null,
              event.actor ?? null,
            );

          lastEventSequence = Number(result.lastInsertRowid);
        } catch (error) {
          this.handleEventInsertError(error, event.eventId, aggregate.aggregateId, nextVersion);
        }
      }

      aggregateVersion = nextVersion;

      if (aggregate.events.length > 0) {
        this.database
          .prepare<[string, number, string]>(
            `
              INSERT INTO aggregate_heads (aggregate_id, version, updated_at)
              VALUES (?, ?, ?)
              ON CONFLICT(aggregate_id)
              DO UPDATE SET
                version = excluded.version,
                updated_at = excluded.updated_at
            `,
          )
          .run(aggregate.aggregateId, aggregateVersion, now);
      }
    }

    this.insertSnapshots(transaction.snapshots ?? [], now);
    this.applyProjectionMutations(transaction.projections ?? [], now);
    this.insertArtifacts(transaction.artifacts ?? [], now);
    this.insertSignals(transaction.signals ?? [], now);

    for (const command of transaction.outbox ?? []) {
      try {
        this.database
          .prepare<[string, string, string, string, string, string]>(
            `
              INSERT INTO outbox (
                command_id,
                topic,
                payload_json,
                headers_json,
                created_at,
                visible_at
              )
              VALUES (?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            command.commandId,
            command.topic,
            toJsonText(command.payload),
            toJsonText(command.headers),
            now,
            command.visibleAt ?? now,
          );
      } catch (error) {
        this.handleOutboxInsertError(error, command.commandId);
      }
    }

    return {
      aggregateId: aggregate?.aggregateId ?? null,
      aggregateVersion,
      appendedEventCount: aggregate?.events.length ?? 0,
      lastEventSequence,
      outboxCount: transaction.outbox?.length ?? 0,
    };
  }

  private verifySchemaVersions(transaction: LedgerTransaction): void {
    for (const event of transaction.aggregate?.events ?? []) {
      if (event.eventSchemaVersion !== SUPPORTED_EVENT_SCHEMA_VERSION) {
        raiseConflict({
          kind: 'unsupported_schema_version',
          schemaKind: 'event',
          receivedVersion: event.eventSchemaVersion,
          supportedVersion: SUPPORTED_EVENT_SCHEMA_VERSION,
          recovery: 'quarantine',
        });
      }
    }

    for (const snapshot of transaction.snapshots ?? []) {
      if (snapshot.snapshotSchemaVersion !== SUPPORTED_SNAPSHOT_SCHEMA_VERSION) {
        raiseConflict({
          kind: 'unsupported_schema_version',
          schemaKind: 'snapshot',
          receivedVersion: snapshot.snapshotSchemaVersion,
          supportedVersion: SUPPORTED_SNAPSHOT_SCHEMA_VERSION,
          recovery: 'quarantine',
        });
      }
    }
  }

  private readCurrentVersion(aggregateId: string): number {
    const row = this.database
      .prepare<[{ readonly aggregateId: string }], { version: number }>(
        `
          SELECT version
          FROM aggregate_heads
          WHERE aggregate_id = @aggregateId
        `,
      )
      .get({ aggregateId });

    return row?.version ?? 0;
  }

  private insertSnapshots(snapshots: readonly SnapshotWrite[], now: string): void {
    for (const snapshot of snapshots) {
      const payloadJson = toJsonText(snapshot.payload);
      this.database
        .prepare<[string, string, number, number, string, string, string]>(
          `
            INSERT INTO snapshots (
              snapshot_id,
              aggregate_id,
              aggregate_version,
              snapshot_schema_version,
              taken_at,
              payload_json,
              checksum
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          snapshot.snapshotId,
          snapshot.aggregateId,
          snapshot.aggregateVersion,
          snapshot.snapshotSchemaVersion,
          snapshot.takenAt ?? now,
          payloadJson,
          checksumString(payloadJson),
        );
    }
  }

  private applyProjectionMutations(
    mutations: NonNullable<LedgerTransaction['projections']>,
    now: string,
  ): void {
    for (const mutation of mutations) {
      if (mutation.kind === 'delete') {
        this.database
          .prepare<[string, string]>(
            `
              DELETE FROM projections
              WHERE projection_type = ?
                AND projection_id = ?
            `,
          )
          .run(mutation.projectionType, mutation.projectionId);
        continue;
      }

      const payloadJson = toJsonText(mutation.payload);
      this.database
        .prepare<[string, string, string, string, string, number | null]>(
          `
            INSERT INTO projections (
              projection_type,
              projection_id,
              payload_json,
              checksum,
              updated_at,
              last_event_sequence
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(projection_type, projection_id)
            DO UPDATE SET
              payload_json = excluded.payload_json,
              checksum = excluded.checksum,
              updated_at = excluded.updated_at,
              last_event_sequence = excluded.last_event_sequence
          `,
        )
        .run(
          mutation.projectionType,
          mutation.projectionId,
          payloadJson,
          checksumString(payloadJson),
          mutation.updatedAt ?? now,
          mutation.lastEventSequence ?? null,
        );
    }
  }

  private insertSignals(signals: NonNullable<LedgerTransaction['signals']>, now: string): void {
    for (const signal of signals) {
      this.database
        .prepare<[string, string, string, string, string, string, string | null]>(
          `
            INSERT INTO signals (
              signal_id,
              signal_kind,
              correlation_key,
              payload_json,
              received_at,
              status,
              resolved_wait_key
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          signal.signalId,
          signal.signalKind,
          signal.correlationKey,
          toJsonText(signal.payload),
          signal.receivedAt ?? now,
          signal.status ?? 'received',
          signal.resolvedWaitKey ?? null,
        );
    }
  }

  private insertArtifacts(artifacts: readonly ArtifactWrite[], now: string): void {
    for (const artifact of artifacts) {
      const payloadJson = toJsonText(artifact.payload);
      this.database
        .prepare<[string, string, string, string, string, string, string, string | null]>(
          `
            INSERT INTO artifacts (
              artifact_id,
              artifact_kind,
              storage_uri,
              payload_json,
              metadata_json,
              checksum,
              created_at,
              parent_artifact_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          artifact.artifactId,
          artifact.artifactKind,
          artifact.storageUri,
          payloadJson,
          toJsonText(artifact.metadata),
          checksumString(payloadJson),
          artifact.createdAt ?? now,
          artifact.parentArtifactId ?? null,
        );
    }
  }

  private handleEventInsertError(
    error: unknown,
    eventId: string,
    aggregateId: string,
    aggregateVersion: number,
  ): never {
    if (isSqliteConstraintError(error)) {
      if (error.message.includes('events.event_id')) {
        raiseConflict({ kind: 'duplicate_event_id', eventId });
      }

      if (error.message.includes('events.aggregate_id, events.aggregate_version')) {
        const actualVersion = this.readCurrentVersion(aggregateId);
        raiseConflict({
          kind: 'version_conflict',
          aggregateId,
          expectedVersion: aggregateVersion - 1,
          actualVersion,
        });
      }
    }

    throw error;
  }

  private handleOutboxInsertError(error: unknown, commandId: string): never {
    if (isSqliteConstraintError(error) && error.message.includes('outbox.command_id')) {
      raiseConflict({ kind: 'duplicate_outbox_command_id', commandId });
    }

    throw error;
  }
}
