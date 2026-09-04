export type JsonValue =
  null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

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

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
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

export interface DocumentWrite {
  readonly kind: string;
  readonly id: string;
  readonly revision: number;
  readonly payload: JsonValue;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface DocumentRecord {
  readonly kind: string;
  readonly id: string;
  readonly revision: number;
  readonly payload: JsonValue;
  readonly checksum: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type DocumentRevisionSelector = number | 'latest';

export interface DocumentConflict {
  readonly kind: 'document_revision_conflict';
  readonly documentKind: string;
  readonly documentId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;
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

export interface LedgerConflict {
  readonly kind: 'version_conflict';
  readonly aggregateId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
}
