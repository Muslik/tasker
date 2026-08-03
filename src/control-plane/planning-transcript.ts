import { z } from 'zod';

import type { LedgerRepository } from '../ledger/repository.js';
import type { LedgerConflict } from '../ledger/types.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { JsonValueSchema } from '../workflow/schema.js';

const TranscriptStreamSchema = z.enum(['stdout', 'stderr']);

const PlanningTranscriptChunkSchema = z
  .object({
    schemaVersion: z.literal(1),
    transcriptId: z.string().min(1),
    operationId: z.string().min(1),
    sequence: z.number().int().positive(),
    providerAttempt: z.number().int().positive(),
    stream: TranscriptStreamSchema,
    content: z.string().min(1),
    byteLength: z.number().int().positive(),
    recordedAt: z.iso.datetime(),
  })
  .strict();

const PlanningTranscriptEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('chunk'),
      artifactId: z.string().min(1),
      byteLength: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal('truncated') }).strict(),
]);

export const PlanningTranscriptViewSchema = z
  .object({
    transcriptId: z.string().min(1),
    operationId: z.string().min(1),
    chunks: z.array(PlanningTranscriptChunkSchema),
    totalBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export type PlanningTranscriptStream = z.infer<typeof TranscriptStreamSchema>;
export type PlanningTranscriptView = z.infer<typeof PlanningTranscriptViewSchema>;

export type PlanningTranscriptStoreError =
  | { readonly kind: 'ledger_conflict'; readonly conflict: LedgerConflict }
  | {
      readonly kind: 'transcript_corrupt';
      readonly transcriptId: string;
      readonly issues: readonly string[];
    }
  | {
      readonly kind: 'transcript_artifact_missing';
      readonly transcriptId: string;
      readonly artifactId: string;
    };

const asJson = (value: unknown) => JsonValueSchema.parse(value);
export const planningTranscriptIdFor = (operationId: string): string =>
  `planning-transcript:${operationId}`;

const takeUtf8 = (
  content: string,
  maximumBytes: number,
): { readonly content: string; readonly byteLength: number; readonly truncated: boolean } => {
  let result = '';
  let byteLength = 0;
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (byteLength + characterBytes > maximumBytes) {
      return { content: result, byteLength, truncated: true };
    }
    result += character;
    byteLength += characterBytes;
  }
  return { content: result, byteLength, truncated: false };
};

const splitUtf8 = (content: string, chunkBytes: number): readonly string[] => {
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (currentBytes > 0 && currentBytes + characterBytes > chunkBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

export class PlanningTranscriptStore {
  private readonly maxBytes: number;
  private readonly chunkBytes: number;

  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
    options: { readonly maxBytes?: number; readonly chunkBytes?: number } = {},
  ) {
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    this.chunkBytes = options.chunkBytes ?? 32 * 1024;
    if (this.maxBytes < 1 || this.chunkBytes < 1 || this.chunkBytes > this.maxBytes) {
      throw new Error('Planning transcript limits are invalid');
    }
  }

  public append(
    operationId: string,
    providerAttempt: number,
    stream: PlanningTranscriptStream,
    content: string,
  ): Outcome<PlanningTranscriptView, PlanningTranscriptStoreError> {
    if (content.length === 0) return this.read(operationId);
    const current = this.read(operationId);
    if (!current.ok || current.value.truncated) return current;
    const bounded = takeUtf8(content, this.maxBytes - current.value.totalBytes);
    for (const chunk of splitUtf8(bounded.content, this.chunkBytes)) {
      const appended = this.appendChunk(operationId, providerAttempt, stream, chunk);
      if (!appended.ok) return appended;
    }
    if (bounded.truncated) {
      const marked = this.appendTruncation(operationId);
      if (!marked.ok) return marked;
    }
    return this.read(operationId);
  }

  public read(operationId: string): Outcome<PlanningTranscriptView, PlanningTranscriptStoreError> {
    const transcriptId = planningTranscriptIdFor(operationId);
    const chunks: z.infer<typeof PlanningTranscriptChunkSchema>[] = [];
    let totalBytes = 0;
    let truncated = false;
    for (const event of this.ledger.listEvents(transcriptId)) {
      const payload = PlanningTranscriptEventSchema.safeParse(event.payload);
      if (!payload.success) {
        return err({
          kind: 'transcript_corrupt',
          transcriptId,
          issues: payload.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
      }
      if (payload.data.kind === 'truncated') {
        truncated = true;
        continue;
      }
      const artifact = this.ledger.readArtifact(payload.data.artifactId);
      if (artifact === null) {
        return err({
          kind: 'transcript_artifact_missing',
          transcriptId,
          artifactId: payload.data.artifactId,
        });
      }
      const chunk = PlanningTranscriptChunkSchema.safeParse(artifact.payload);
      if (!chunk.success) {
        return err({
          kind: 'transcript_corrupt',
          transcriptId,
          issues: chunk.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
      }
      chunks.push(chunk.data);
      totalBytes += chunk.data.byteLength;
    }
    return ok(
      PlanningTranscriptViewSchema.parse({
        transcriptId,
        operationId,
        chunks,
        totalBytes,
        truncated,
      }),
    );
  }

  private appendChunk(
    operationId: string,
    providerAttempt: number,
    stream: PlanningTranscriptStream,
    content: string,
  ): Outcome<PlanningTranscriptView, PlanningTranscriptStoreError> {
    const transcriptId = planningTranscriptIdFor(operationId);
    const expectedVersion = this.ledger.readAggregateHead(transcriptId)?.version ?? 0;
    const sequence = expectedVersion + 1;
    const artifactId = `${transcriptId}:chunk-${String(sequence)}`;
    const recordedAt = this.clock.now();
    const chunk = PlanningTranscriptChunkSchema.parse({
      schemaVersion: 1,
      transcriptId,
      operationId,
      sequence,
      providerAttempt,
      stream,
      content,
      byteLength: Buffer.byteLength(content, 'utf8'),
      recordedAt,
    });
    const committed = this.ledger.transact({
      aggregate: {
        aggregateId: transcriptId,
        expectedVersion,
        events: [
          {
            eventId: `event:${transcriptId}:${String(sequence)}`,
            eventType: 'PlanningTranscriptChunkAppended',
            eventSchemaVersion: 1,
            payload: asJson({
              kind: 'chunk',
              artifactId,
              byteLength: chunk.byteLength,
            }),
            actor: 'provider',
          },
        ],
      },
      artifacts: [
        {
          artifactId,
          artifactKind: 'planning_transcript_chunk',
          storageUri: `ledger://artifacts/${artifactId}`,
          payload: asJson(chunk),
          metadata: asJson({ operationId, providerAttempt, stream, sequence }),
          createdAt: recordedAt,
        },
      ],
      timestamp: recordedAt,
    });
    return committed.ok
      ? this.read(operationId)
      : err({ kind: 'ledger_conflict', conflict: committed.error });
  }

  private appendTruncation(
    operationId: string,
  ): Outcome<PlanningTranscriptView, PlanningTranscriptStoreError> {
    const transcriptId = planningTranscriptIdFor(operationId);
    const expectedVersion = this.ledger.readAggregateHead(transcriptId)?.version ?? 0;
    const sequence = expectedVersion + 1;
    const recordedAt = this.clock.now();
    const committed = this.ledger.transact({
      aggregate: {
        aggregateId: transcriptId,
        expectedVersion,
        events: [
          {
            eventId: `event:${transcriptId}:${String(sequence)}`,
            eventType: 'PlanningTranscriptTruncated',
            eventSchemaVersion: 1,
            payload: asJson({ kind: 'truncated' }),
            actor: 'kernel',
          },
        ],
      },
      timestamp: recordedAt,
    });
    return committed.ok
      ? this.read(operationId)
      : err({ kind: 'ledger_conflict', conflict: committed.error });
  }
}
