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
  LeaseMutation,
  LeaseRecord,
  OutboxRecord,
  ProjectionRecord,
  SnapshotRecord,
  SnapshotWrite,
  TransactionFenceGuard,
} from './types.js';

interface LeaseRow {
  readonly lease_key: string;
  readonly owner_id: string;
  readonly fence_token: number;
  readonly status: 'active' | 'released';
  readonly acquired_at: string;
  readonly renewed_at: string;
  readonly released_at: string | null;
  readonly metadata_json: string;
}

interface LeasePlan {
  readonly mutation: LeaseMutation;
  readonly fenceToken: number;
  readonly status: 'active' | 'released';
  readonly previousLease: LeaseRow | null;
  readonly metadataJson: string;
}

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
          lease_key: string | null;
          lease_fence_token: number | null;
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
            lease_key,
            lease_fence_token,
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
        leaseKey: row.lease_key,
        leaseFenceToken: row.lease_fence_token,
        dispatchedAt: row.dispatched_at,
        attempts: row.attempts,
      }));
  }

  public readLease(leaseKey: string): LeaseRecord | null {
    const row = this.readLeaseRow(leaseKey);
    if (row === null) {
      return null;
    }

    return this.toLeaseRecord(row);
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

    const fenceGuard =
      transaction.fenceGuard === undefined ? null : this.verifyFenceGuard(transaction.fenceGuard);
    const leasePlan =
      transaction.lease === undefined ? null : this.planLeaseMutation(transaction.lease);

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
      const effectiveFenceToken = this.resolveFenceTokenForOutbox(
        command.leaseKey,
        fenceGuard,
        leasePlan,
      );

      try {
        this.database
          .prepare<[string, string, string, string, string, string, string | null, number | null]>(
            `
              INSERT INTO outbox (
                command_id,
                topic,
                payload_json,
                headers_json,
                created_at,
                visible_at,
                lease_key,
                lease_fence_token
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            command.commandId,
            command.topic,
            toJsonText(command.payload),
            toJsonText(command.headers),
            now,
            command.visibleAt ?? now,
            command.leaseKey ?? leasePlan?.mutation.leaseKey ?? null,
            effectiveFenceToken,
          );
      } catch (error) {
        this.handleOutboxInsertError(error, command.commandId);
      }
    }

    if (leasePlan !== null) {
      this.applyLeasePlan(leasePlan, now);
    }

    return {
      aggregateId: aggregate?.aggregateId ?? null,
      aggregateVersion,
      appendedEventCount: aggregate?.events.length ?? 0,
      lastEventSequence,
      outboxCount: transaction.outbox?.length ?? 0,
      lease:
        leasePlan === null
          ? null
          : {
              leaseKey: leasePlan.mutation.leaseKey,
              ownerId: leasePlan.mutation.ownerId,
              fenceToken: leasePlan.fenceToken,
              status: leasePlan.status,
            },
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

  private verifyFenceGuard(fenceGuard: TransactionFenceGuard): TransactionFenceGuard {
    const existing = this.readLeaseRow(fenceGuard.leaseKey);
    if (
      existing === null ||
      existing.fence_token !== fenceGuard.expectedFenceToken ||
      existing.owner_id !== fenceGuard.ownerId ||
      existing.status !== 'active'
    ) {
      raiseConflict({
        kind: 'stale_fence',
        leaseKey: fenceGuard.leaseKey,
        expectedFenceToken: fenceGuard.expectedFenceToken,
        actualFenceToken: existing?.fence_token ?? null,
        actualOwnerId: existing?.owner_id ?? null,
        actualStatus: existing?.status ?? null,
      });
    }

    return fenceGuard;
  }

  private planLeaseMutation(mutation: LeaseMutation): LeasePlan {
    const existing = this.readLeaseRow(mutation.leaseKey);
    const metadataJson = toJsonText(mutation.metadata);

    if (mutation.kind === 'acquire') {
      return {
        mutation,
        fenceToken: (existing?.fence_token ?? 0) + 1,
        status: 'active',
        previousLease: existing,
        metadataJson,
      };
    }

    if (
      existing === null ||
      existing.fence_token !== mutation.expectedFenceToken ||
      existing.owner_id !== mutation.ownerId ||
      existing.status !== 'active'
    ) {
      raiseConflict({
        kind: 'stale_fence',
        leaseKey: mutation.leaseKey,
        expectedFenceToken: mutation.expectedFenceToken,
        actualFenceToken: existing?.fence_token ?? null,
        actualOwnerId: existing?.owner_id ?? null,
        actualStatus: existing?.status ?? null,
      });
    }

    return {
      mutation,
      fenceToken: mutation.expectedFenceToken,
      status: mutation.kind === 'release' ? 'released' : 'active',
      previousLease: existing,
      metadataJson,
    };
  }

  private resolveFenceTokenForOutbox(
    leaseKey: string | undefined,
    fenceGuard: TransactionFenceGuard | null,
    leasePlan: LeasePlan | null,
  ): number | null {
    if (leaseKey === undefined) {
      return leasePlan?.fenceToken ?? null;
    }

    if (leasePlan?.mutation.leaseKey === leaseKey) {
      return leasePlan.fenceToken;
    }

    if (fenceGuard?.leaseKey === leaseKey) {
      return fenceGuard.expectedFenceToken;
    }

    raiseConflict({
      kind: 'missing_fence_guard',
      leaseKey,
    });

    throw new Error('unreachable');
  }

  private applyLeasePlan(plan: LeasePlan, now: string): void {
    if (plan.mutation.kind === 'acquire') {
      this.database
        .prepare<[string, string, number, string, string, string, string | null, string]>(
          `
            INSERT INTO leases (
              lease_key,
              owner_id,
              fence_token,
              status,
              acquired_at,
              renewed_at,
              released_at,
              metadata_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(lease_key)
            DO UPDATE SET
              owner_id = excluded.owner_id,
              fence_token = excluded.fence_token,
              status = excluded.status,
              acquired_at = excluded.acquired_at,
              renewed_at = excluded.renewed_at,
              released_at = excluded.released_at,
              metadata_json = excluded.metadata_json
          `,
        )
        .run(
          plan.mutation.leaseKey,
          plan.mutation.ownerId,
          plan.fenceToken,
          'active',
          now,
          now,
          null,
          plan.metadataJson,
        );
      return;
    }

    if (plan.mutation.kind === 'renew') {
      this.database
        .prepare<[string, string, string, string, number]>(
          `
            UPDATE leases
            SET owner_id = ?, renewed_at = ?, metadata_json = ?
            WHERE lease_key = ?
              AND fence_token = ?
          `,
        )
        .run(
          plan.mutation.ownerId,
          now,
          plan.metadataJson,
          plan.mutation.leaseKey,
          plan.fenceToken,
        );
      return;
    }

    this.database
      .prepare<[string, string, string | null, string, string, number]>(
        `
          UPDATE leases
          SET owner_id = ?,
              status = 'released',
              released_at = ?,
              renewed_at = ?,
              metadata_json = ?
          WHERE lease_key = ?
            AND fence_token = ?
        `,
      )
      .run(
        plan.mutation.ownerId,
        now,
        now,
        plan.metadataJson,
        plan.mutation.leaseKey,
        plan.fenceToken,
      );
  }

  private readLeaseRow(leaseKey: string): LeaseRow | null {
    const row = this.database
      .prepare<
        [{ readonly leaseKey: string }],
        {
          lease_key: string;
          owner_id: string;
          fence_token: number;
          status: 'active' | 'released';
          acquired_at: string;
          renewed_at: string;
          released_at: string | null;
          metadata_json: string;
        }
      >(
        `
          SELECT
            lease_key,
            owner_id,
            fence_token,
            status,
            acquired_at,
            renewed_at,
            released_at,
            metadata_json
          FROM leases
          WHERE lease_key = @leaseKey
        `,
      )
      .get({ leaseKey });

    return row ?? null;
  }

  private toLeaseRecord(row: LeaseRow): LeaseRecord {
    return {
      leaseKey: row.lease_key,
      ownerId: row.owner_id,
      fenceToken: row.fence_token,
      status: row.status,
      acquiredAt: row.acquired_at,
      renewedAt: row.renewed_at,
      releasedAt: row.released_at,
      metadata: parseJson(row.metadata_json),
    };
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
