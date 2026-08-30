export type JsonValue =
  null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

export const SUPPORTED_EVENT_SCHEMA_VERSION = 1;
export const SUPPORTED_SNAPSHOT_SCHEMA_VERSION = 1;

export interface EventWrite {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventSchemaVersion: number;
  readonly payload: JsonValue;
  readonly metadata?: JsonValue;
  readonly occurredAt?: string;
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly actor?: string;
}

export interface AggregateWrite {
  readonly aggregateId: string;
  readonly expectedVersion: number;
  readonly events: readonly EventWrite[];
}

export interface SnapshotWrite {
  readonly snapshotId: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly snapshotSchemaVersion: number;
  readonly payload: JsonValue;
  readonly takenAt?: string;
}

export type ProjectionMutation =
  | {
      readonly kind: 'upsert';
      readonly projectionType: string;
      readonly projectionId: string;
      readonly payload: JsonValue;
      readonly updatedAt?: string;
      readonly lastEventSequence?: number;
    }
  | {
      readonly kind: 'delete';
      readonly projectionType: string;
      readonly projectionId: string;
    };

export interface ArtifactWrite {
  readonly artifactId: string;
  readonly artifactKind: string;
  readonly storageUri: string;
  readonly payload: JsonValue;
  readonly createdAt?: string;
  readonly metadata?: JsonValue;
  readonly parentArtifactId?: string;
}

export interface LedgerTransaction {
  readonly aggregate?: AggregateWrite;
  readonly snapshots?: readonly SnapshotWrite[];
  readonly projections?: readonly ProjectionMutation[];
  readonly artifacts?: readonly ArtifactWrite[];
  readonly timestamp?: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface AggregateHeadRecord {
  readonly aggregateId: string;
  readonly version: number;
  readonly updatedAt: string;
}

export interface EventRecord {
  readonly sequence: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly eventSchemaVersion: number;
  readonly payload: JsonValue;
  readonly metadata: JsonValue;
  readonly occurredAt: string;
  readonly causationId: string | null;
  readonly correlationId: string | null;
  readonly actor: string | null;
}

export interface ProjectionRecord {
  readonly projectionType: string;
  readonly projectionId: string;
  readonly payload: JsonValue;
  readonly checksum: string;
  readonly updatedAt: string;
  readonly lastEventSequence: number | null;
}

export interface SnapshotRecord {
  readonly snapshotId: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly snapshotSchemaVersion: number;
  readonly payload: JsonValue;
  readonly checksum: string;
  readonly takenAt: string;
}

export interface ArtifactRecord {
  readonly artifactId: string;
  readonly artifactKind: string;
  readonly storageUri: string;
  readonly payload: JsonValue;
  readonly metadata: JsonValue;
  readonly checksum: string;
  readonly createdAt: string;
  readonly parentArtifactId: string | null;
}

export type LedgerConflict =
  | {
      readonly kind: 'version_conflict';
      readonly aggregateId: string;
      readonly expectedVersion: number;
      readonly actualVersion: number;
    }
  | {
      readonly kind: 'duplicate_event_id';
      readonly eventId: string;
    }
  | {
      readonly kind: 'unsupported_schema_version';
      readonly schemaKind: 'event' | 'snapshot';
      readonly receivedVersion: number;
      readonly supportedVersion: 1;
      readonly recovery: 'quarantine';
    };

export interface LedgerCommitResult {
  readonly aggregateId: string | null;
  readonly aggregateVersion: number | null;
  readonly appendedEventCount: number;
  readonly lastEventSequence: number | null;
}
