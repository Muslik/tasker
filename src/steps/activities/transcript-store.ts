import { z } from 'zod';

import type { TaskRunEvidence } from '../../integrations/index.js';
import { JsonValueSchema } from '../../graph/schema.js';
import { PlanningTranscriptViewSchema } from '../../server/planning-transcript.js';
import type { Clock } from '../../shared/clock.js';
import { err, ok, type Outcome } from '../../shared/outcome.js';
import type { LedgerRepository } from '../../store/repository.js';
import { TRANSCRIPT_TRUNCATION_SENTINEL_STREAM, type TranscriptRecord } from '../../store/types.js';
import {
  LedgerAgentInvocationRecorder,
  type AgentInvocationRecorder,
} from '../../steps/agent-invocation.js';
import type { AgentInvocationUsage } from '../../steps/agent-usage.js';
import { BlockReceiptSchema } from '../../steps/contracts.js';
import { TaskStepOutputArtifactSchema, type TaskStepOutputArtifact } from '../task-step-output.js';
import { blockReceiptId } from '../receipt-store.js';
import {
  ExecuteTaskStepResultSchema,
  type ExecuteTaskStepResult,
} from './block-execution-contracts.js';

const TaskStepTranscriptChunkSchema = z
  .object({
    schemaVersion: z.literal(1),
    transcriptId: z.string().min(1),
    operationId: z.string().min(1),
    sequence: z.number().int().positive(),
    providerAttempt: z.number().int().positive(),
    stream: z.enum(['stdout', 'stderr']),
    content: z.string().min(1),
    byteLength: z.number().int().positive(),
    recordedAt: z.iso.datetime(),
  })
  .strict();

type TemporalTaskStepTraceStoreError =
  | { readonly kind: 'ledger_conflict' }
  | {
      readonly kind: 'output_corrupt';
      readonly artifactId: string;
      readonly issues: readonly string[];
    }
  | { readonly kind: 'transcript_corrupt'; readonly issues: readonly string[] };

const asJson = (value: unknown) => JsonValueSchema.parse(value);

const predicateFactsFromReceipt = (
  ledger: LedgerRepository,
  output: TaskStepOutputArtifact,
): Readonly<Record<string, boolean>> => {
  const receipt = ledger.readReceipt(
    blockReceiptId({
      workflowId: output.workflowId,
      workflowRunId: output.workflowRunId,
      nodeId: output.nodeId,
      blockRun: output.stepAttempt,
    }),
  );
  if (receipt === null) return {};
  const parsed = BlockReceiptSchema.safeParse(receipt.payload);
  return parsed.success ? parsed.data.predicateFacts : {};
};

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

export class TemporalTaskStepTraceStore {
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
      throw new Error('Task step transcript limits are invalid');
    }
  }

  public transcriptIdFor(operationId: string): string {
    return `task-step-transcript:${operationId}`;
  }

  public outputArtifactIdFor(operationId: string): string {
    return `task-step-output:${operationId}:artifact`;
  }

  public agentInvocationRecorder(): AgentInvocationRecorder {
    return new LedgerAgentInvocationRecorder(this.ledger, this.clock);
  }

  public readOutputArtifact(
    operationId: string,
  ): Outcome<
    TaskStepOutputArtifact | null,
    Extract<TemporalTaskStepTraceStoreError, { readonly kind: 'output_corrupt' }>
  > {
    const artifactId = this.outputArtifactIdFor(operationId);
    const artifact = this.ledger.readArtifact(artifactId);
    if (artifact === null) return ok(null);
    const parsed = TaskStepOutputArtifactSchema.safeParse(artifact.payload);
    return parsed.success
      ? ok(parsed.data)
      : err({
          kind: 'output_corrupt',
          artifactId,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
  }

  public readOutputResult(
    operationId: string,
  ): Outcome<
    ExecuteTaskStepResult | null,
    Extract<TemporalTaskStepTraceStoreError, { readonly kind: 'output_corrupt' }>
  > {
    const output = this.readOutputArtifact(operationId);
    return output.ok ? ok(output.value?.result ?? null) : output;
  }

  public readRunStepEvidence(
    taskReference: string,
    workflowId: string,
  ): Outcome<TaskRunEvidence['completedSteps'], TemporalTaskStepTraceStoreError> {
    const steps: TaskRunEvidence['completedSteps'][number][] = [];
    for (const artifact of this.ledger.listArtifacts({
      artifactKind: 'task_step_output',
      taskReference,
    })) {
      const parsed = TaskStepOutputArtifactSchema.safeParse(artifact.payload);
      if (!parsed.success) {
        return err({
          kind: 'output_corrupt',
          artifactId: artifact.artifactId,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
      }
      if (parsed.data.workflowId !== workflowId) continue;
      steps.push({
        operationId: parsed.data.operationId,
        nodeId: parsed.data.nodeId,
        stepReference: parsed.data.stepReference,
        status: parsed.data.status,
        summary: parsed.data.result?.summary ?? null,
        artifactIds: parsed.data.result?.artifactIds ?? [],
        predicateFacts: predicateFactsFromReceipt(this.ledger, parsed.data),
        details: parsed.data.details,
        recordedAt: parsed.data.recordedAt,
      });
    }
    return ok(steps);
  }

  public append(
    operationId: string,
    providerAttempt: number,
    stream: 'stdout' | 'stderr',
    content: string,
    taskReference: string,
  ): Outcome<z.infer<typeof PlanningTranscriptViewSchema>, TemporalTaskStepTraceStoreError> {
    if (content.length === 0) return this.read(operationId);
    const current = this.read(operationId);
    if (!current.ok || current.value.truncated) return current;
    const bounded = takeUtf8(content, this.maxBytes - current.value.totalBytes);
    for (const chunk of splitUtf8(bounded.content, this.chunkBytes)) {
      this.ledger.appendTranscript({
        idPrefix: `${this.transcriptIdFor(operationId)}:provider-attempt-${String(providerAttempt)}`,
        taskReference,
        operationId,
        stream,
        content: chunk,
        recordedAt: this.clock.now(),
      });
    }
    if (bounded.truncated) {
      this.ledger.appendTranscript({
        idPrefix: `${this.transcriptIdFor(operationId)}:provider-attempt-${String(providerAttempt)}`,
        taskReference,
        operationId,
        stream: TRANSCRIPT_TRUNCATION_SENTINEL_STREAM,
        content: '',
        recordedAt: this.clock.now(),
      });
    }
    return this.read(operationId);
  }

  public read(
    operationId: string,
  ): Outcome<z.infer<typeof PlanningTranscriptViewSchema>, TemporalTaskStepTraceStoreError> {
    const transcriptId = this.transcriptIdFor(operationId);
    const chunks: z.infer<typeof TaskStepTranscriptChunkSchema>[] = [];
    let totalBytes = 0;
    let truncated = false;
    for (const row of this.ledger.listTranscripts(operationId)) {
      if (row.stream === TRANSCRIPT_TRUNCATION_SENTINEL_STREAM) {
        truncated = true;
        continue;
      }
      const parsed = TaskStepTranscriptChunkSchema.safeParse({
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

  public persistOutputArtifact(input: {
    readonly operationId: string;
    readonly taskReference: string;
    readonly workflowId: string;
    readonly workflowRunId: string;
    readonly nodeId: string;
    readonly stepReference: string;
    readonly stepAttempt: number;
    readonly runner: 'agent' | 'integration' | 'process' | 'system';
    readonly command: string | null;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly exitCode: number | null;
    readonly status: 'completed' | 'blocked' | 'failed' | 'workflow_change_required';
    readonly stdout: string;
    readonly stderr: string;
    readonly details: unknown;
    readonly usage?: AgentInvocationUsage;
    readonly result?: ExecuteTaskStepResult;
  }): Outcome<
    { readonly artifactId: string; readonly result: ExecuteTaskStepResult | null },
    TemporalTaskStepTraceStoreError
  > {
    const artifactId = this.outputArtifactIdFor(input.operationId);
    const existing = this.ledger.readArtifact(artifactId);
    if (existing !== null) {
      const parsed = TaskStepOutputArtifactSchema.safeParse(existing.payload);
      return parsed.success
        ? ok({ artifactId, result: parsed.data.result })
        : err({
            kind: 'output_corrupt',
            artifactId,
            issues: parsed.error.issues.map(
              (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
            ),
          });
    }
    const recordedAt = this.clock.now();
    const result =
      input.result === undefined
        ? null
        : ExecuteTaskStepResultSchema.parse({
            ...input.result,
            artifactIds: [artifactId, ...new Set(input.result.artifactIds)],
          });
    const payload = TaskStepOutputArtifactSchema.parse({
      schemaVersion: 4,
      operationId: input.operationId,
      workflowId: input.workflowId,
      workflowRunId: input.workflowRunId,
      nodeId: input.nodeId,
      stepReference: input.stepReference,
      stepAttempt: input.stepAttempt,
      runner: input.runner,
      command: input.command,
      args: [...input.args],
      cwd: input.cwd,
      exitCode: input.exitCode,
      status: input.status,
      stdout: input.stdout,
      stderr: input.stderr,
      details: asJson(input.details),
      usage: input.usage ?? null,
      result,
      recordedAt,
    });
    const committed = this.ledger.insertArtifact({
      artifactId,
      artifactKind: 'task_step_output',
      taskReference: input.taskReference,
      storageUri: `ledger://artifacts/${artifactId}`,
      payload: asJson(payload),
      metadata: asJson({
        taskReference: input.taskReference,
        operationId: input.operationId,
        workflowId: input.workflowId,
        workflowRunId: input.workflowRunId,
        nodeId: input.nodeId,
        stepReference: input.stepReference,
        status: input.status,
      }),
      createdAt: recordedAt,
    });
    return committed ? ok({ artifactId, result }) : err({ kind: 'ledger_conflict' });
  }
}
