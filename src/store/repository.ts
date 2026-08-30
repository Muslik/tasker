import type { Database as SqliteDatabase } from 'better-sqlite3';

import { err, ok, type Outcome } from '../shared/outcome.js';
import type { Clock } from '../shared/clock.js';

import { checksumString } from './checksum.js';
import type {
  LedgerConflict,
  AgentInvocationFinishWrite,
  AgentInvocationRecord,
  AgentInvocationRunningWrite,
  AgentInvocationTotalsRecord,
  ArtifactRecord,
  ArtifactWrite,
  DocumentConflict,
  DocumentRecord,
  DocumentRevisionSelector,
  DocumentWrite,
  JsonValue,
  ReceiptRecord,
  ReceiptWrite,
  StreamEventRecord,
  StreamEventWrite,
  TranscriptRecord,
  TranscriptWrite,
} from './types.js';

const toJsonText = (value: JsonValue | undefined, fallback: JsonValue = {}): string =>
  JSON.stringify(value ?? fallback);

const parseJson = (value: string): JsonValue => JSON.parse(value) as JsonValue;

const taskReferenceFrom = (payload: JsonValue): string | null => {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return typeof payload.taskReference === 'string' ? payload.taskReference : null;
};

type DocumentRow = {
  readonly kind: string;
  readonly id: string;
  readonly revision: number;
  readonly payload_json: string;
  readonly checksum: string;
  readonly created_at: string;
  readonly updated_at: string;
};

const toDocumentRecord = (row: DocumentRow): DocumentRecord => ({
  kind: row.kind,
  id: row.id,
  revision: row.revision,
  payload: parseJson(row.payload_json),
  checksum: row.checksum,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

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

export class LedgerRepository {
  public constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  public transact(input: {
    readonly artifacts?: readonly ArtifactWrite[];
    readonly timestamp?: string;
  }): Outcome<{ readonly appendedArtifactCount: number }, LedgerConflict> {
    this.database
      .transaction(() => {
        this.insertArtifacts(input.artifacts ?? [], input.timestamp ?? this.clock.now());
      })
      .immediate();
    return ok({ appendedArtifactCount: input.artifacts?.length ?? 0 });
  }
  public readArtifact(artifactId: string): ArtifactRecord | null {
    const row = this.database
      .prepare<
        [{ readonly artifactId: string }],
        {
          artifact_kind: string;
          task_reference: string | null;
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
            task_reference,
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
      taskReference: row.task_reference,
      storageUri: row.storage_uri,
      payload: parseJson(row.payload_json),
      metadata: parseJson(row.metadata_json),
      checksum: row.checksum,
      createdAt: row.created_at,
      parentArtifactId: row.parent_artifact_id,
    };
  }

  public listArtifacts(
    input: {
      readonly artifactKind?: string;
      readonly taskReference?: string;
    } = {},
  ): readonly ArtifactRecord[] {
    const conditions: string[] = [];
    const parameters: Record<string, string> = {};
    if (input.artifactKind !== undefined) {
      conditions.push('artifact_kind = @artifactKind');
      parameters.artifactKind = input.artifactKind;
    }
    if (input.taskReference !== undefined) {
      conditions.push('task_reference = @taskReference');
      parameters.taskReference = input.taskReference;
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const rows = this.database
      .prepare<
        [Record<string, string>],
        {
          artifact_id: string;
          artifact_kind: string;
          task_reference: string | null;
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
            artifact_id,
            artifact_kind,
            task_reference,
            storage_uri,
            payload_json,
            metadata_json,
            checksum,
            created_at,
            parent_artifact_id
          FROM artifacts
          ${where}
          ORDER BY created_at ASC, artifact_id ASC
        `,
      )
      .all(parameters);

    return rows.map((row) => ({
      artifactId: row.artifact_id,
      artifactKind: row.artifact_kind,
      taskReference: row.task_reference,
      storageUri: row.storage_uri,
      payload: parseJson(row.payload_json),
      metadata: parseJson(row.metadata_json),
      checksum: row.checksum,
      createdAt: row.created_at,
      parentArtifactId: row.parent_artifact_id,
    }));
  }

  public insertArtifact(artifact: ArtifactWrite): boolean {
    try {
      this.insertArtifacts([artifact], artifact.createdAt ?? this.clock.now());
      return true;
    } catch (error) {
      if (isSqliteConstraintError(error)) return false;
      throw error;
    }
  }

  public readDocument(
    kind: string,
    id: string,
    revision: DocumentRevisionSelector = 'latest',
  ): DocumentRecord | null {
    if (revision !== 'latest' && (!Number.isSafeInteger(revision) || revision < 1)) {
      throw new Error('Document revision selector must be "latest" or a positive safe integer');
    }

    const row =
      revision === 'latest'
        ? this.database
            .prepare<[{ readonly kind: string; readonly id: string }], DocumentRow>(
              `
                SELECT kind, id, revision, payload_json, checksum, created_at, updated_at
                FROM documents
                WHERE kind = @kind
                  AND id = @id
                ORDER BY revision DESC
                LIMIT 1
              `,
            )
            .get({ kind, id })
        : this.database
            .prepare<
              [{ readonly kind: string; readonly id: string; readonly revision: number }],
              DocumentRow
            >(
              `
                SELECT kind, id, revision, payload_json, checksum, created_at, updated_at
                FROM documents
                WHERE kind = @kind
                  AND id = @id
                  AND revision = @revision
              `,
            )
            .get({ kind, id, revision });

    return row === undefined ? null : toDocumentRecord(row);
  }

  public listDocuments(kind: string): readonly DocumentRecord[] {
    return this.database
      .prepare<[{ readonly kind: string }], DocumentRow>(
        `
          SELECT document.kind,
                 document.id,
                 document.revision,
                 document.payload_json,
                 document.checksum,
                 document.created_at,
                 document.updated_at
          FROM documents AS document
          INNER JOIN (
            SELECT id, MAX(revision) AS revision
            FROM documents
            WHERE kind = @kind
            GROUP BY id
          ) AS latest
            ON latest.id = document.id
           AND latest.revision = document.revision
          WHERE document.kind = @kind
          ORDER BY document.id ASC
        `,
      )
      .all({ kind })
      .map(toDocumentRecord);
  }

  public insertDocument(write: DocumentWrite): boolean {
    if (!Number.isSafeInteger(write.revision) || write.revision < 1) {
      throw new Error('Document revision must be a positive safe integer');
    }

    const createdAt = write.createdAt ?? this.clock.now();
    const updatedAt = write.updatedAt ?? createdAt;
    const payloadJson = toJsonText(write.payload);
    const checksum = checksumString(payloadJson);
    try {
      this.database
        .prepare<[string, string, number, string, string, string, string]>(
          `
            INSERT INTO documents (
              kind,
              id,
              revision,
              payload_json,
              checksum,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(write.kind, write.id, write.revision, payloadJson, checksum, createdAt, updatedAt);
      return true;
    } catch (error) {
      if (isSqliteConstraintError(error)) return false;
      throw error;
    }
  }

  public appendDocument(
    kind: string,
    id: string,
    expectedRevision: number,
    payload: JsonValue,
    timestamp = this.clock.now(),
  ): Outcome<DocumentRecord, DocumentConflict> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('Document expected revision must be a non-negative safe integer');
    }

    const payloadJson = toJsonText(payload);
    const checksum = checksumString(payloadJson);
    return this.database
      .transaction(() => {
        const actualRevision =
          this.database
            .prepare<[{ readonly kind: string; readonly id: string }], { revision: number }>(
              `
                SELECT revision
                FROM documents
                WHERE kind = @kind
                  AND id = @id
                ORDER BY revision DESC
                LIMIT 1
              `,
            )
            .get({ kind, id })?.revision ?? 0;

        if (actualRevision !== expectedRevision) {
          return err({
            kind: 'document_revision_conflict',
            documentKind: kind,
            documentId: id,
            expectedRevision,
            actualRevision,
          } satisfies DocumentConflict);
        }

        const revision = expectedRevision + 1;
        this.database
          .prepare<[string, string, number, string, string, string, string]>(
            `
              INSERT INTO documents (
                kind,
                id,
                revision,
                payload_json,
                checksum,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(kind, id, revision, payloadJson, checksum, timestamp, timestamp);

        return ok({
          kind,
          id,
          revision,
          payload,
          checksum,
          createdAt: timestamp,
          updatedAt: timestamp,
        } satisfies DocumentRecord);
      })
      .immediate();
  }

  public deleteDocuments(kind: string, id: string): number {
    return this.database
      .prepare<[string, string]>(
        `
          DELETE FROM documents
          WHERE kind = ?
            AND id = ?
        `,
      )
      .run(kind, id).changes;
  }

  public appendTranscript(write: TranscriptWrite): TranscriptRecord {
    const recordedAt = write.recordedAt ?? this.clock.now();
    return this.database
      .transaction(() => {
        const sequence =
          this.database
            .prepare<[{ readonly operationId: string }], { sequence: number }>(
              `
              SELECT COALESCE(MAX(seq), 0) + 1 AS sequence
              FROM transcripts
              WHERE operation_id = @operationId
            `,
            )
            .get({ operationId: write.operationId })?.sequence ?? 1;
        const id = `${write.idPrefix}:seq-${String(sequence)}`;
        const byteLength = Buffer.byteLength(write.content, 'utf8');
        this.database
          .prepare<[string, string, string, number, string, string, number, string]>(
            `
            INSERT INTO transcripts (
              id,
              task_reference,
              operation_id,
              seq,
              stream,
              content,
              byte_length,
              recorded_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            id,
            write.taskReference,
            write.operationId,
            sequence,
            write.stream,
            write.content,
            byteLength,
            recordedAt,
          );
        return {
          id,
          taskReference: write.taskReference,
          operationId: write.operationId,
          seq: sequence,
          stream: write.stream,
          content: write.content,
          byteLength,
          recordedAt,
        } satisfies TranscriptRecord;
      })
      .immediate();
  }

  public listTranscripts(
    operationId: string,
    range: { readonly afterSeq?: number; readonly limit?: number } = {},
  ): readonly TranscriptRecord[] {
    const afterSeq = range.afterSeq ?? 0;
    const limit = range.limit ?? -1;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new Error('Transcript cursor must be a non-negative safe integer');
    }
    if (limit !== -1 && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new Error('Transcript limit must be a positive safe integer');
    }
    return this.database
      .prepare<
        [{ readonly operationId: string; readonly afterSeq: number; readonly limit: number }],
        {
          id: string;
          task_reference: string;
          operation_id: string;
          seq: number;
          stream: string;
          content: string;
          byte_length: number;
          recorded_at: string;
        }
      >(
        `
          SELECT
            id,
            task_reference,
            operation_id,
            seq,
            stream,
            content,
            byte_length,
            recorded_at
          FROM transcripts
          WHERE operation_id = @operationId
            AND seq > @afterSeq
          ORDER BY seq ASC
          LIMIT @limit
        `,
      )
      .all({ operationId, afterSeq, limit })
      .map((row) => ({
        id: row.id,
        taskReference: row.task_reference,
        operationId: row.operation_id,
        seq: row.seq,
        stream: row.stream,
        content: row.content,
        byteLength: row.byte_length,
        recordedAt: row.recorded_at,
      }));
  }

  public listTranscriptOperationIds(input: {
    readonly taskReference: string;
    readonly operationIdPrefix?: string;
  }): readonly string[] {
    const prefix = input.operationIdPrefix ?? '';
    return this.database
      .prepare<
        [{ readonly taskReference: string; readonly prefix: string }],
        { operation_id: string; first_recorded_at: string }
      >(
        `
          SELECT operation_id, MIN(recorded_at) AS first_recorded_at
          FROM transcripts
          WHERE task_reference = @taskReference
            AND operation_id LIKE @prefix || '%'
          GROUP BY operation_id
          ORDER BY first_recorded_at ASC, operation_id ASC
        `,
      )
      .all({ taskReference: input.taskReference, prefix })
      .map((row) => row.operation_id);
  }

  public readReceipt(receiptId: string): ReceiptRecord | null {
    const row = this.database
      .prepare<
        [{ readonly receiptId: string }],
        {
          task_reference: string;
          workflow_id: string;
          run_id: string;
          node_id: string;
          block_run: number;
          block_reference: string;
          verdict: string;
          payload_json: string;
          completed_at: string;
        }
      >(
        `
          SELECT
            task_reference,
            workflow_id,
            run_id,
            node_id,
            block_run,
            block_reference,
            verdict,
            payload_json,
            completed_at
          FROM receipts
          WHERE receipt_id = @receiptId
        `,
      )
      .get({ receiptId });
    return row === undefined
      ? null
      : {
          receiptId,
          taskReference: row.task_reference,
          workflowId: row.workflow_id,
          runId: row.run_id,
          nodeId: row.node_id,
          blockRun: row.block_run,
          blockReference: row.block_reference,
          verdict: row.verdict,
          payload: parseJson(row.payload_json),
          completedAt: row.completed_at,
        };
  }

  public insertReceipt(write: ReceiptWrite, artifact?: ArtifactWrite): boolean {
    try {
      this.database
        .transaction(() => {
          this.database
            .prepare<
              [string, string, string, string, string, number, string, string, string, string]
            >(
              `
                INSERT INTO receipts (
                  receipt_id,
                  task_reference,
                  workflow_id,
                  run_id,
                  node_id,
                  block_run,
                  block_reference,
                  verdict,
                  payload_json,
                  completed_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `,
            )
            .run(
              write.receiptId,
              write.taskReference,
              write.workflowId,
              write.runId,
              write.nodeId,
              write.blockRun,
              write.blockReference,
              write.verdict,
              toJsonText(write.payload),
              write.completedAt ?? this.clock.now(),
            );
          if (artifact !== undefined) {
            this.insertArtifacts([artifact], artifact.createdAt ?? this.clock.now());
          }
        })
        .immediate();
      return true;
    } catch (error) {
      if (isSqliteConstraintError(error)) return false;
      throw error;
    }
  }

  public listReceiptsByWorkflowRun(workflowId: string, runId: string): readonly ReceiptRecord[] {
    return this.database
      .prepare<[{ readonly workflowId: string; readonly runId: string }], { receipt_id: string }>(
        `
          SELECT receipt_id
          FROM receipts
          WHERE workflow_id = @workflowId
            AND run_id = @runId
          ORDER BY completed_at ASC, receipt_id ASC
        `,
      )
      .all({ workflowId, runId })
      .map(({ receipt_id }) => this.readReceipt(receipt_id))
      .filter((receipt): receipt is ReceiptRecord => receipt !== null);
  }

  public startAgentInvocation(write: AgentInvocationRunningWrite): boolean {
    const startedAt = write.startedAt ?? this.clock.now();
    try {
      this.database
        .transaction(() => {
          this.database
            .prepare<[string, string, string | null, number, string | null, string]>(
              `
                INSERT INTO agent_invocations (
                  invocation_id,
                  task_reference,
                  node_id,
                  block_run,
                  episode_id,
                  status,
                  started_at
                )
                VALUES (?, ?, ?, ?, ?, 'running', ?)
              `,
            )
            .run(
              write.invocationId,
              write.taskReference,
              write.nodeId,
              write.blockRun,
              write.episodeId,
              startedAt,
            );
          this.insertStreamEvent({
            taskReference: write.taskReference,
            eventType: 'AgentInvocationStarted',
            payload: {},
            occurredAt: startedAt,
          });
        })
        .immediate();
      return true;
    } catch (error) {
      if (isSqliteConstraintError(error)) return false;
      throw error;
    }
  }

  public finishAgentInvocation(
    write: AgentInvocationFinishWrite,
    artifact: ArtifactWrite,
  ): boolean {
    const finishedAt = write.finishedAt ?? this.clock.now();
    try {
      this.database
        .transaction(() => {
          this.insertArtifacts([artifact], finishedAt);
          this.database
            .prepare<
              [
                string,
                string,
                string | null,
                number,
                string | null,
                string,
                string | null,
                string | null,
                number | null,
                number | null,
                string | null,
                string | null,
                string,
                string,
                string | null,
              ]
            >(
              `
                INSERT INTO agent_invocations (
                  invocation_id,
                  task_reference,
                  node_id,
                  block_run,
                  episode_id,
                  status,
                  model,
                  profile,
                  prompt_bytes,
                  duration_ms,
                  usage_json,
                  cost_json,
                  started_at,
                  finished_at,
                  payload_artifact_id
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(invocation_id)
                DO UPDATE SET
                  status = excluded.status,
                  model = excluded.model,
                  profile = excluded.profile,
                  prompt_bytes = excluded.prompt_bytes,
                  duration_ms = excluded.duration_ms,
                  usage_json = excluded.usage_json,
                  cost_json = excluded.cost_json,
                  finished_at = excluded.finished_at,
                  payload_artifact_id = excluded.payload_artifact_id
              `,
            )
            .run(
              write.invocationId,
              write.taskReference,
              write.nodeId,
              write.blockRun,
              write.episodeId,
              write.status,
              write.model,
              write.profile,
              write.promptBytes,
              write.durationMs,
              write.usage === null ? null : toJsonText(write.usage),
              write.cost === null ? null : toJsonText(write.cost),
              write.startedAt,
              finishedAt,
              write.payloadArtifactId ?? artifact.artifactId,
            );
          this.insertStreamEvent({
            taskReference: write.taskReference,
            eventType: 'AgentInvocationFinished',
            payload: {},
            occurredAt: finishedAt,
          });
        })
        .immediate();
      return true;
    } catch (error) {
      if (isSqliteConstraintError(error)) return false;
      throw error;
    }
  }

  public readAgentInvocation(invocationId: string): AgentInvocationRecord | null {
    const row = this.database
      .prepare<
        [{ readonly invocationId: string }],
        {
          task_reference: string;
          node_id: string | null;
          block_run: number;
          episode_id: string | null;
          status: string;
          model: string | null;
          profile: string | null;
          prompt_bytes: number | null;
          duration_ms: number | null;
          usage_json: string | null;
          cost_json: string | null;
          started_at: string;
          finished_at: string | null;
          payload_artifact_id: string | null;
        }
      >(
        `
          SELECT
            task_reference,
            node_id,
            block_run,
            episode_id,
            status,
            model,
            profile,
            prompt_bytes,
            duration_ms,
            usage_json,
            cost_json,
            started_at,
            finished_at,
            payload_artifact_id
          FROM agent_invocations
          WHERE invocation_id = @invocationId
        `,
      )
      .get({ invocationId });
    return row === undefined
      ? null
      : {
          invocationId,
          taskReference: row.task_reference,
          nodeId: row.node_id,
          blockRun: row.block_run,
          episodeId: row.episode_id,
          status: row.status,
          model: row.model,
          profile: row.profile,
          promptBytes: row.prompt_bytes,
          durationMs: row.duration_ms,
          usage: row.usage_json === null ? null : parseJson(row.usage_json),
          cost: row.cost_json === null ? null : parseJson(row.cost_json),
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          payloadArtifactId: row.payload_artifact_id,
        };
  }

  public listAgentInvocations(taskReference: string): readonly AgentInvocationRecord[] {
    return this.database
      .prepare<[{ readonly taskReference: string }], { invocation_id: string }>(
        `
          SELECT invocation_id
          FROM agent_invocations
          WHERE task_reference = @taskReference
          ORDER BY COALESCE(finished_at, started_at) DESC, invocation_id DESC
        `,
      )
      .all({ taskReference })
      .map(({ invocation_id }) => this.readAgentInvocation(invocation_id))
      .filter((record): record is AgentInvocationRecord => record !== null);
  }

  public readAgentInvocationTotals(taskReference: string): AgentInvocationTotalsRecord {
    const row = this.database
      .prepare<
        [{ readonly taskReference: string }],
        {
          invocation_count: number;
          input_tokens: number;
          cached_input_tokens: number;
          output_tokens: number;
          reasoning_output_tokens: number;
          total_tokens: number;
          cost_usd: number;
          unrated_count: number;
        }
      >(
        `
          SELECT
            COUNT(*) AS invocation_count,
            COALESCE(SUM(COALESCE(json_extract(usage_json, '$.inputTokens'), 0)), 0) AS input_tokens,
            COALESCE(SUM(COALESCE(json_extract(usage_json, '$.cachedInputTokens'), 0)), 0) AS cached_input_tokens,
            COALESCE(SUM(COALESCE(json_extract(usage_json, '$.outputTokens'), 0)), 0) AS output_tokens,
            COALESCE(SUM(COALESCE(json_extract(usage_json, '$.reasoningOutputTokens'), 0)), 0) AS reasoning_output_tokens,
            COALESCE(SUM(
              COALESCE(json_extract(usage_json, '$.inputTokens'), 0) +
              COALESCE(json_extract(usage_json, '$.outputTokens'), 0)
            ), 0) AS total_tokens,
            COALESCE(SUM(
              CASE
                WHEN json_extract(cost_json, '$.source') = 'unrated' THEN 0
                ELSE COALESCE(json_extract(cost_json, '$.amountUsd'), 0)
              END
            ), 0) AS cost_usd,
            COALESCE(SUM(
              CASE WHEN json_extract(cost_json, '$.source') = 'unrated' THEN 1 ELSE 0 END
            ), 0) AS unrated_count
          FROM agent_invocations
          WHERE task_reference = @taskReference
            AND status <> 'running'
        `,
      )
      .get({ taskReference });
    return {
      invocationCount: row?.invocation_count ?? 0,
      inputTokens: row?.input_tokens ?? 0,
      cachedInputTokens: row?.cached_input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      reasoningOutputTokens: row?.reasoning_output_tokens ?? 0,
      totalTokens: row?.total_tokens ?? 0,
      costUsd: row?.cost_usd ?? 0,
      unratedCount: row?.unrated_count ?? 0,
    };
  }

  public nextPlanningInvocationNumber(episodeId: string, planningAttempt: number): number {
    const row = this.database
      .prepare<
        [{ readonly episodeId: string; readonly planningAttempt: number }],
        { next_number: number }
      >(
        `
          SELECT COUNT(*) + 1 AS next_number
          FROM agent_invocations
          WHERE episode_id = @episodeId
            AND block_run = @planningAttempt
        `,
      )
      .get({ episodeId, planningAttempt });
    return row?.next_number ?? 1;
  }

  public appendStreamEvent(write: StreamEventWrite): StreamEventRecord {
    return this.insertStreamEvent(write);
  }

  public listStreamEventsAfter(sequence: number, limit = 1_000): readonly StreamEventRecord[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error('Stream cursor must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Stream event limit must be a positive safe integer');
    }
    return this.database
      .prepare<
        [{ readonly sequence: number; readonly limit: number }],
        {
          seq: number;
          task_reference: string;
          event_type: string;
          payload_json: string;
          occurred_at: string;
        }
      >(
        `
          SELECT seq, task_reference, event_type, payload_json, occurred_at
          FROM stream_events
          WHERE seq > @sequence
          ORDER BY seq ASC
          LIMIT @limit
        `,
      )
      .all({ sequence, limit })
      .map((row) => ({
        seq: row.seq,
        taskReference: row.task_reference,
        eventType: row.event_type,
        payload: parseJson(row.payload_json),
        occurredAt: row.occurred_at,
      }));
  }

  public listStreamEventsForTask(taskReference: string): readonly StreamEventRecord[] {
    return this.database
      .prepare<
        [{ readonly taskReference: string }],
        {
          seq: number;
          task_reference: string;
          event_type: string;
          payload_json: string;
          occurred_at: string;
        }
      >(
        `
          SELECT seq, task_reference, event_type, payload_json, occurred_at
          FROM stream_events
          WHERE task_reference = @taskReference
          ORDER BY seq ASC
        `,
      )
      .all({ taskReference })
      .map((row) => ({
        seq: row.seq,
        taskReference: row.task_reference,
        eventType: row.event_type,
        payload: parseJson(row.payload_json),
        occurredAt: row.occurred_at,
      }));
  }

  public readLatestStreamEventSequence(): number {
    return (
      this.database
        .prepare<[], { sequence: number }>(
          `SELECT COALESCE(MAX(seq), 0) AS sequence FROM stream_events`,
        )
        .get()?.sequence ?? 0
    );
  }

  private insertArtifacts(artifacts: readonly ArtifactWrite[], now: string): void {
    for (const artifact of artifacts) {
      const payloadJson = toJsonText(artifact.payload);
      this.database
        .prepare<
          [string, string, string | null, string, string, string, string, string, string | null]
        >(
          `
            INSERT INTO artifacts (
              artifact_id,
              artifact_kind,
              task_reference,
              storage_uri,
              payload_json,
              metadata_json,
              checksum,
              created_at,
              parent_artifact_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          artifact.artifactId,
          artifact.artifactKind,
          artifact.taskReference ?? taskReferenceFrom(artifact.metadata ?? {}),
          artifact.storageUri,
          payloadJson,
          toJsonText(artifact.metadata),
          checksumString(payloadJson),
          artifact.createdAt ?? now,
          artifact.parentArtifactId ?? null,
        );
    }
  }

  private insertStreamEvent(write: StreamEventWrite): StreamEventRecord {
    const occurredAt = write.occurredAt ?? this.clock.now();
    const result = this.database
      .prepare<[string, string, string, string]>(
        `
          INSERT INTO stream_events (task_reference, event_type, payload_json, occurred_at)
          VALUES (?, ?, ?, ?)
        `,
      )
      .run(write.taskReference, write.eventType, toJsonText(write.payload), occurredAt);
    return {
      seq: Number(result.lastInsertRowid),
      taskReference: write.taskReference,
      eventType: write.eventType,
      payload: write.payload,
      occurredAt,
    };
  }
}
