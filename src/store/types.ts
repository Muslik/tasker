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
  readonly taskReference?: string;
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
  readonly taskReference: string | null;
  readonly storageUri: string;
  readonly payload: JsonValue;
  readonly metadata: JsonValue;
  readonly checksum: string;
  readonly createdAt: string;
  readonly parentArtifactId: string | null;
}

export const TRANSCRIPT_TRUNCATION_SENTINEL_STREAM = '__truncated__';

export interface TranscriptWrite {
  readonly idPrefix: string;
  readonly taskReference: string;
  readonly operationId: string;
  readonly stream: string;
  readonly content: string;
  readonly recordedAt?: string;
}

export interface TranscriptRecord {
  readonly id: string;
  readonly taskReference: string;
  readonly operationId: string;
  readonly seq: number;
  readonly stream: string;
  readonly content: string;
  readonly byteLength: number;
  readonly recordedAt: string;
}

export interface ReceiptWrite {
  readonly receiptId: string;
  readonly taskReference: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly blockRun: number;
  readonly blockReference: string;
  readonly verdict: string;
  readonly payload: JsonValue;
  readonly completedAt?: string;
}

export interface ReceiptRecord {
  readonly receiptId: string;
  readonly taskReference: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly blockRun: number;
  readonly blockReference: string;
  readonly verdict: string;
  readonly payload: JsonValue;
  readonly completedAt: string;
}

export interface AgentInvocationRunningWrite {
  readonly invocationId: string;
  readonly taskReference: string;
  readonly nodeId: string | null;
  readonly blockRun: number;
  readonly episodeId: string | null;
  readonly startedAt?: string;
}

export interface AgentInvocationFinishWrite {
  readonly invocationId: string;
  readonly taskReference: string;
  readonly nodeId: string | null;
  readonly blockRun: number;
  readonly episodeId: string | null;
  readonly status: 'completed' | 'waiting' | 'failed';
  readonly model: string | null;
  readonly profile: string | null;
  readonly promptBytes: number | null;
  readonly durationMs: number | null;
  readonly usage: JsonValue | null;
  readonly cost: JsonValue | null;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly payloadArtifactId?: string | null;
}

export interface AgentInvocationRecord {
  readonly invocationId: string;
  readonly taskReference: string;
  readonly nodeId: string | null;
  readonly blockRun: number;
  readonly episodeId: string | null;
  readonly status: string;
  readonly model: string | null;
  readonly profile: string | null;
  readonly promptBytes: number | null;
  readonly durationMs: number | null;
  readonly usage: JsonValue | null;
  readonly cost: JsonValue | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly payloadArtifactId: string | null;
}

export interface AgentInvocationTotalsRecord {
  readonly invocationCount: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly unratedCount: number;
}

export interface StreamEventWrite {
  readonly taskReference: string;
  readonly eventType: string;
  readonly payload: JsonValue;
  readonly occurredAt?: string;
}

export interface StreamEventRecord {
  readonly seq: number;
  readonly taskReference: string;
  readonly eventType: string;
  readonly payload: JsonValue;
  readonly occurredAt: string;
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
