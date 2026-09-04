import { z } from 'zod';

import type { LedgerRepository } from '../store/repository.js';
import {
  TRANSCRIPT_TRUNCATION_SENTINEL_STREAM,
  type LedgerConflict,
  type TranscriptRecord,
} from '../store/types.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';

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
    };

export const planningTranscriptIdFor = (operationId: string): string =>
  `planning-transcript:${operationId}`;

const providerAttemptFrom = (row: TranscriptRecord): number | null => {
  const match = /:provider-attempt-(\d+):seq-\d+$/u.exec(row.id);
  if (match?.[1] === undefined) return null;
  const attempt = Number(match[1]);
  return Number.isSafeInteger(attempt) && attempt > 0 ? attempt : null;
};

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
    taskReference: string,
  ): Outcome<PlanningTranscriptView, PlanningTranscriptStoreError> {
    if (content.length === 0) return this.read(operationId);
    const current = this.read(operationId);
    if (!current.ok || current.value.truncated) return current;
    const bounded = takeUtf8(content, this.maxBytes - current.value.totalBytes);
    for (const chunk of splitUtf8(bounded.content, this.chunkBytes)) {
      this.ledger.appendTranscript({
        idPrefix: `${planningTranscriptIdFor(operationId)}:provider-attempt-${String(providerAttempt)}`,
        taskReference,
        operationId,
        stream,
        content: chunk,
        recordedAt: this.clock.now(),
      });
    }
    if (bounded.truncated) {
      this.ledger.appendTranscript({
        idPrefix: `${planningTranscriptIdFor(operationId)}:provider-attempt-${String(providerAttempt)}`,
        taskReference,
        operationId,
        stream: TRANSCRIPT_TRUNCATION_SENTINEL_STREAM,
        content: '',
        recordedAt: this.clock.now(),
      });
    }
    return this.read(operationId);
  }

  public read(operationId: string): Outcome<PlanningTranscriptView, PlanningTranscriptStoreError> {
    const transcriptId = planningTranscriptIdFor(operationId);
    const chunks: z.infer<typeof PlanningTranscriptChunkSchema>[] = [];
    let totalBytes = 0;
    let truncated = false;
    for (const row of this.ledger.listTranscripts(operationId)) {
      if (row.stream === TRANSCRIPT_TRUNCATION_SENTINEL_STREAM) {
        truncated = true;
        continue;
      }
      const parsed = PlanningTranscriptChunkSchema.safeParse({
        schemaVersion: 1,
        transcriptId,
        operationId: row.operationId,
        sequence: row.seq,
        providerAttempt: providerAttemptFrom(row),
        stream: row.stream,
        content: row.content,
        byteLength: row.byteLength,
        recordedAt: row.recordedAt,
      });
      if (!parsed.success) {
        return err({
          kind: 'transcript_corrupt',
          transcriptId,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
      }
      chunks.push(parsed.data);
      totalBytes += parsed.data.byteLength;
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

  public listOperationIds(taskReference: string, prefix = ''): readonly string[] {
    return this.ledger.listTranscriptOperationIds({
      taskReference,
      operationIdPrefix: prefix,
    });
  }
}
