import { z } from 'zod';

import type { TaskRunEvidence } from '../../integrations/index.js';

import { PlanningTranscriptViewSchema } from '../../server/planning-transcript.js';

import type { Clock } from '../../shared/clock.js';

import { err, ok, type Outcome } from '../../shared/outcome.js';

import { JsonValueSchema } from '../../graph/schema.js';

import type { LedgerRepository } from '../../store/repository.js';

import {
  LedgerAgentInvocationRecorder,
  type AgentInvocationRecorder,
} from '../../steps/agent-invocation.js';

import type { AgentInvocationUsage } from '../../steps/agent-usage.js';

import { TaskStepOutputArtifactSchema, type TaskStepOutputArtifact } from '../task-step-output.js';

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

const TaskStepTranscriptEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('chunk'),
      artifactId: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal('truncated') }).strict(),
]);

type TemporalTaskStepTraceStoreError =
  | { readonly kind: 'ledger_conflict' }
  | {
      readonly kind: 'output_corrupt';
      readonly artifactId: string;
      readonly issues: readonly string[];
    }
  | { readonly kind: 'transcript_corrupt'; readonly issues: readonly string[] }
  | { readonly kind: 'artifact_missing'; readonly artifactId: string };

const asJson = (value: unknown) => JsonValueSchema.parse(value);

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
    workflowId: string,
  ): Outcome<TaskRunEvidence['completedSteps'], TemporalTaskStepTraceStoreError> {
    const prefix = `task-step-output:${workflowId}:`;
    const steps: TaskRunEvidence['completedSteps'][number][] = [];
    for (const event of this.ledger.listEvents()) {
      if (event.eventType !== 'TaskStepOutputRecorded' || !event.aggregateId.startsWith(prefix)) {
        continue;
      }
      const pointer = z.object({ artifactId: z.string().min(1) }).safeParse(event.payload);
      if (!pointer.success) {
        return err({
          kind: 'output_corrupt',
          artifactId: event.aggregateId,
          issues: pointer.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
      }
      const artifact = this.ledger.readArtifact(pointer.data.artifactId);
      if (artifact === null) {
        return err({ kind: 'artifact_missing', artifactId: pointer.data.artifactId });
      }
      const parsed = TaskStepOutputArtifactSchema.safeParse(artifact.payload);
      if (!parsed.success) {
        return err({
          kind: 'output_corrupt',
          artifactId: pointer.data.artifactId,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
      }
      steps.push({
        operationId: parsed.data.operationId,
        nodeId: parsed.data.nodeId,
        stepReference: parsed.data.stepReference,
        status: parsed.data.status,
        summary: parsed.data.result?.summary ?? null,
        artifactIds: parsed.data.result?.artifactIds ?? [],
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
  ): Outcome<z.infer<typeof PlanningTranscriptViewSchema>, TemporalTaskStepTraceStoreError> {
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

  public read(
    operationId: string,
  ): Outcome<z.infer<typeof PlanningTranscriptViewSchema>, TemporalTaskStepTraceStoreError> {
    const transcriptId = this.transcriptIdFor(operationId);
    const chunks: z.infer<typeof TaskStepTranscriptChunkSchema>[] = [];
    let totalBytes = 0;
    let truncated = false;
    for (const event of this.ledger.listEvents(transcriptId)) {
      const parsed = TaskStepTranscriptEventSchema.safeParse(event.payload);
      if (!parsed.success) {
        return err({
          kind: 'transcript_corrupt',
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
      }
      if (parsed.data.kind === 'truncated') {
        truncated = true;
        continue;
      }
      const artifact = this.ledger.readArtifact(parsed.data.artifactId);
      if (artifact === null) {
        return err({ kind: 'artifact_missing', artifactId: parsed.data.artifactId });
      }
      const chunk = TaskStepTranscriptChunkSchema.safeParse(artifact.payload);
      if (!chunk.success) {
        return err({
          kind: 'transcript_corrupt',
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

  public persistOutputArtifact(input: {
    readonly operationId: string;
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
    const aggregateId = `task-step-output:${input.operationId}`;
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
    const committed = this.ledger.transact({
      aggregate: {
        aggregateId,
        expectedVersion: 0,
        events: [
          {
            eventId: `event:${aggregateId}:1`,
            eventType: 'TaskStepOutputRecorded',
            eventSchemaVersion: 1,
            payload: asJson({ artifactId }),
            actor: 'provider',
          },
        ],
      },
      artifacts: [
        {
          artifactId,
          artifactKind: 'task_step_output',
          storageUri: `ledger://artifacts/${artifactId}`,
          payload: asJson(payload),
          metadata: asJson({
            operationId: input.operationId,
            workflowId: input.workflowId,
            workflowRunId: input.workflowRunId,
            nodeId: input.nodeId,
            stepReference: input.stepReference,
            status: input.status,
          }),
          createdAt: recordedAt,
        },
      ],
      timestamp: recordedAt,
    });
    return committed.ok ? ok({ artifactId, result }) : err({ kind: 'ledger_conflict' });
  }

  private appendChunk(
    operationId: string,
    providerAttempt: number,
    stream: 'stdout' | 'stderr',
    content: string,
  ): Outcome<z.infer<typeof PlanningTranscriptViewSchema>, TemporalTaskStepTraceStoreError> {
    const transcriptId = this.transcriptIdFor(operationId);
    const expectedVersion = this.ledger.readAggregateHead(transcriptId)?.version ?? 0;
    const sequence = expectedVersion + 1;
    const artifactId = `${transcriptId}:chunk-${String(sequence)}`;
    const recordedAt = this.clock.now();
    const payload = TaskStepTranscriptChunkSchema.parse({
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
            eventType: 'TaskStepTranscriptChunkAppended',
            eventSchemaVersion: 1,
            payload: asJson({ kind: 'chunk', artifactId }),
            actor: 'provider',
          },
        ],
      },
      artifacts: [
        {
          artifactId,
          artifactKind: 'task_step_transcript_chunk',
          storageUri: `ledger://artifacts/${artifactId}`,
          payload: asJson(payload),
          metadata: asJson({ operationId, providerAttempt, stream, sequence }),
          createdAt: recordedAt,
        },
      ],
      timestamp: recordedAt,
    });
    return committed.ok ? this.read(operationId) : err({ kind: 'ledger_conflict' });
  }

  private appendTruncation(
    operationId: string,
  ): Outcome<z.infer<typeof PlanningTranscriptViewSchema>, TemporalTaskStepTraceStoreError> {
    const transcriptId = this.transcriptIdFor(operationId);
    const expectedVersion = this.ledger.readAggregateHead(transcriptId)?.version ?? 0;
    const sequence = expectedVersion + 1;
    const committed = this.ledger.transact({
      aggregate: {
        aggregateId: transcriptId,
        expectedVersion,
        events: [
          {
            eventId: `event:${transcriptId}:${String(sequence)}`,
            eventType: 'TaskStepTranscriptTruncated',
            eventSchemaVersion: 1,
            payload: asJson({ kind: 'truncated' }),
            actor: 'kernel',
          },
        ],
      },
      timestamp: this.clock.now(),
    });
    return committed.ok ? this.read(operationId) : err({ kind: 'ledger_conflict' });
  }
}
