import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@temporalio/activity';
import { z } from 'zod';

import type { LoadedHarnessPack, LoadedHarnessStep } from '../../harness/index.js';
import {
  emptyIntegrationStepAdapterRegistry,
  type IntegrationStepAdapterRegistry,
} from '../../integrations/index.js';
import type { LedgerRepository } from '../../ledger/repository.js';
import {
  planningTranscriptIdFor,
  PlanningTranscriptViewSchema,
} from '../../control-plane/planning-transcript.js';
import type {
  ImplementationPlanningStore,
  ImplementationPlanningStoreError,
} from '../../control-plane/implementation-planning.js';
import {
  prepareIsolatedCodexHome,
  parseCodexStream,
  providerFailureMessage,
} from '../../providers/codex-cli-support.js';
import {
  prepareAgentSkills,
  type AgentProvider,
  workspaceHarnessEnvironment,
} from '../../providers/agent-skills.js';
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from '../../providers/command-runner.js';
import type { RunPlanningSnapshot } from '../../planning/run-planning-snapshot.js';
import type { Clock } from '../../shared/clock.js';
import { err, ok, type Outcome } from '../../shared/outcome.js';
import { JsonValueSchema } from '../../workflow/schema.js';
import {
  WorkflowChangeRequestSchema,
  parseDeclaredWorkflowChangeRequest,
} from '../../workflow/index.js';
import {
  ExecuteTaskStepInputSchema,
  ExecuteTaskStepResultSchema,
  type ExecuteTaskStepInput,
  type ExecuteTaskStepResult,
  type TaskWorkflowActivities,
} from '../contracts.js';
import {
  TaskStepRecoveryContextSchema,
  type TaskStepRecoveryContext,
  type WorkspaceMutationRecoveryStore,
} from './workspace-mutation-recovery.js';

const AgentStepOutcomeSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('completed'),
      output: JsonValueSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('workflow_change_required'),
      request: WorkflowChangeRequestSchema,
    })
    .strict(),
]);

const TaskStepOutputArtifactSchema = z
  .object({
    schemaVersion: z.literal(2),
    operationId: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    nodeId: z.string().min(1),
    stepReference: z.string().min(1),
    stepAttempt: z.number().int().positive(),
    runner: z.enum(['agent', 'integration', 'process', 'system']),
    command: z.string().nullable(),
    args: z.array(z.string()),
    cwd: z.string().min(1),
    exitCode: z.number().int().nullable(),
    status: z.enum(['completed', 'blocked', 'workflow_change_required']),
    stdout: z.string(),
    stderr: z.string(),
    details: JsonValueSchema,
    result: ExecuteTaskStepResultSchema.nullable(),
    recordedAt: z.iso.datetime(),
  })
  .strict();

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

export interface TaskStepActivityContext {
  readonly attempt: number;
  readonly cancellationSignal: AbortSignal;
  heartbeat(details: unknown): void;
}

export interface TaskStepAgentRequest {
  readonly operationId: string;
  readonly prompt: string;
  readonly skills: readonly string[];
  readonly recovery: TaskStepRecoveryContext;
  readonly outputSchema: z.ZodType;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly runtime: TaskStepActivityContext;
  readonly transcriptStore: TemporalTaskStepTraceStore;
}

export interface TaskStepAgentResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly finalMessage: unknown;
}

export type TaskStepAgentFailure =
  | { readonly kind: 'provider_unavailable'; readonly message: string }
  | {
      readonly kind: 'skill_unavailable';
      readonly skill: string;
      readonly message: string;
    }
  | {
      readonly kind: 'invalid_skill_package';
      readonly skill: string;
      readonly message: string;
    }
  | { readonly kind: 'skill_materialization_failed'; readonly message: string }
  | { readonly kind: 'invalid_skill_selection'; readonly issues: readonly string[] }
  | { readonly kind: 'provider_timed_out'; readonly durationMs: number; readonly stderr: string }
  | {
      readonly kind: 'provider_failed';
      readonly exitCode: number;
      readonly message: string;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: 'invalid_event_stream'; readonly message: string }
  | { readonly kind: 'invalid_output'; readonly issues: readonly string[] };

export interface TaskStepAgentRunner {
  readonly provider: AgentProvider;
  run(request: TaskStepAgentRequest): Promise<Outcome<TaskStepAgentResult, TaskStepAgentFailure>>;
}

export class CodexCliTaskStepAgentRunner implements TaskStepAgentRunner {
  public readonly provider = 'codex' as const;

  public constructor(
    private readonly runner: CommandRunner,
    private readonly options: {
      readonly command?: string;
      readonly model?: string;
      readonly serviceTier?: 'fast' | 'flex';
      readonly timeoutMs?: number;
    } = {},
  ) {}

  public async run(
    request: TaskStepAgentRequest,
  ): Promise<Outcome<TaskStepAgentResult, TaskStepAgentFailure>> {
    const command = this.options.command ?? 'codex';
    const version = await this.runner.run({
      command,
      args: ['--version'],
      cwd: request.cwd,
      stdin: '',
      timeoutMs: 10_000,
    });
    if (version.status === 'spawn_failed') {
      return err({ kind: 'provider_unavailable', message: version.message });
    }
    if (version.status !== 'exited' || version.exitCode !== 0) {
      return err({ kind: 'provider_unavailable', message: 'Codex CLI version probe failed' });
    }

    const directory = await mkdtemp(join(tmpdir(), 'tasker-step-agent-'));
    const schemaPath = join(directory, 'task-step-output.schema.json');
    const isolatedCodexHome = join(directory, 'codex-home');
    const model = this.options.model ?? 'gpt-5.4';
    const serviceTier = this.options.serviceTier ?? 'fast';
    try {
      await prepareIsolatedCodexHome(isolatedCodexHome);
      const preparedSkills = await prepareAgentSkills({
        provider: 'codex',
        repositoryPath: request.cwd,
        configurationRoot: isolatedCodexHome,
        skills: [...request.skills],
      });
      if (!preparedSkills.ok) return err(preparedSkills.error);
      await writeFile(
        schemaPath,
        `${JSON.stringify(z.toJSONSchema(request.outputSchema), null, 2)}\n`,
        'utf8',
      );
      const execution = await this.runCommand(request, {
        command,
        args: [
          'exec',
          '--model',
          model,
          '-c',
          `service_tier="${serviceTier}"`,
          '-c',
          'model_reasoning_effort="medium"',
          '--ephemeral',
          '--skip-git-repo-check',
          '--sandbox',
          'workspace-write',
          '--cd',
          request.cwd,
          '--output-schema',
          schemaPath,
          '--json',
          '-',
        ],
        cwd: request.cwd,
        env: {
          CODEX_HOME: isolatedCodexHome,
          ...workspaceHarnessEnvironment(request.cwd, preparedSkills.value.skillsRoot),
        },
        stdin: request.prompt,
        timeoutMs: request.timeoutMs,
      });
      if (execution.status === 'spawn_failed') {
        return err({ kind: 'provider_unavailable', message: execution.message });
      }
      if (execution.status === 'timed_out') {
        return err({
          kind: 'provider_timed_out',
          durationMs: execution.durationMs,
          stderr: execution.stderr,
        });
      }
      if (execution.exitCode !== 0) {
        return err({
          kind: 'provider_failed',
          exitCode: execution.exitCode,
          message: providerFailureMessage(execution.stdout),
          stdout: execution.stdout,
          stderr: execution.stderr,
        });
      }
      const stream = parseCodexStream(execution.stdout);
      if (!stream.ok) return err(stream.error);
      let finalMessage: unknown;
      try {
        finalMessage = JSON.parse(stream.value.finalMessage) as unknown;
      } catch {
        return err({ kind: 'invalid_output', issues: ['Final agent message was not JSON'] });
      }
      const parsed = request.outputSchema.safeParse(finalMessage);
      if (!parsed.success) {
        return err({
          kind: 'invalid_output',
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
      }
      return ok({
        stdout: execution.stdout,
        stderr: execution.stderr,
        finalMessage: parsed.data,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async runCommand(
    request: TaskStepAgentRequest,
    command: CommandRequest,
  ): Promise<CommandResult> {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const heartbeat = (): void => {
      request.runtime.heartbeat({
        phase: 'agent',
        stdoutBytes,
        stderrBytes,
      });
    };
    const timer = setInterval(heartbeat, 10_000);
    timer.unref();
    try {
      heartbeat();
      const result = await this.runner.run({
        ...command,
        cancellationSignal: request.runtime.cancellationSignal,
        onOutput: (stream, chunk) => {
          const appended = request.transcriptStore.append(
            request.operationId,
            request.runtime.attempt,
            stream,
            chunk,
          );
          if (!appended.ok) {
            throw new Error(`Task step transcript persistence failed: ${appended.error.kind}`);
          }
          if (stream === 'stdout') stdoutBytes += Buffer.byteLength(chunk, 'utf8');
          else stderrBytes += Buffer.byteLength(chunk, 'utf8');
          heartbeat();
        },
      });
      request.runtime.cancellationSignal.throwIfAborted();
      return result;
    } finally {
      clearInterval(timer);
    }
  }
}

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
    this.maxBytes = options.maxBytes ?? 64 * 1024;
    this.chunkBytes = options.chunkBytes ?? 8 * 1024;
    if (this.maxBytes < 1 || this.chunkBytes < 1 || this.chunkBytes > this.maxBytes) {
      throw new Error('Task step transcript limits are invalid');
    }
  }

  public transcriptIdFor(operationId: string): string {
    return `task-step-transcript:${operationId}`;
  }

  public readOutputResult(
    operationId: string,
  ): Outcome<
    ExecuteTaskStepResult | null,
    Extract<TemporalTaskStepTraceStoreError, { readonly kind: 'output_corrupt' }>
  > {
    const artifactId = `task-step-output:${operationId}:artifact`;
    const artifact = this.ledger.readArtifact(artifactId);
    if (artifact === null) return ok(null);
    const parsed = TaskStepOutputArtifactSchema.safeParse(artifact.payload);
    return parsed.success
      ? ok(parsed.data.result)
      : err({
          kind: 'output_corrupt',
          artifactId,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
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
    readonly status: 'completed' | 'blocked' | 'workflow_change_required';
    readonly stdout: string;
    readonly stderr: string;
    readonly details: unknown;
    readonly result?: ExecuteTaskStepResult;
  }): Outcome<
    { readonly artifactId: string; readonly result: ExecuteTaskStepResult | null },
    TemporalTaskStepTraceStoreError
  > {
    const aggregateId = `task-step-output:${input.operationId}`;
    const artifactId = `${aggregateId}:artifact`;
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
      schemaVersion: 2,
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

const block = (
  summary: string,
  waitKind: string,
  artifactIds: readonly string[] = [],
): ExecuteTaskStepResult =>
  ExecuteTaskStepResultSchema.parse({
    status: 'blocked',
    summary,
    waitKind,
    artifactIds,
    transcriptId: null,
  });

const withRecoveryArtifact = (
  recovery: TaskStepRecoveryContext,
  artifactIds: readonly string[],
): readonly string[] =>
  recovery.kind === 'single_attempt' ? artifactIds : [recovery.intentArtifactId, ...artifactIds];

const commandLineToInvocation = (
  commandLine: string,
): Outcome<
  { readonly command: string; readonly args: readonly string[] },
  { readonly kind: string }
> => {
  const trimmed = commandLine.trim();
  if (trimmed.length === 0) return err({ kind: 'empty_command' });
  if (/["'`\\]/u.test(trimmed)) return err({ kind: 'unsupported_shell_syntax' });
  const parts = trimmed.split(/\s+/u);
  return ok({ command: parts[0] ?? trimmed, args: parts.slice(1) });
};

const registryFrom = (pack: LoadedHarnessPack): ReadonlyMap<string, LoadedHarnessStep> =>
  new Map(pack.steps.map((step) => [step.reference, step] as const));

const promptForAgentStep = (input: {
  readonly snapshottedPrompt: string;
  readonly taskReference: string;
  readonly nodeId: string;
  readonly stepAttempt: number;
  readonly uses: string;
  readonly workspacePath: string;
  readonly taskSnapshot: unknown;
  readonly stepInput: unknown;
  readonly requiredCapabilities: readonly string[];
  readonly allowedEffects: readonly string[];
  readonly workflowChanges: readonly string[];
  readonly skills: readonly string[];
  readonly recovery: TaskStepRecoveryContext;
  readonly operatorGuidance: string | null;
}): string =>
  [
    input.snapshottedPrompt.trim(),
    '',
    'Execution context:',
    JSON.stringify(
      {
        taskReference: input.taskReference,
        nodeId: input.nodeId,
        stepAttempt: input.stepAttempt,
        stepReference: input.uses,
        workspacePath: input.workspacePath,
        taskSnapshot: input.taskSnapshot,
        stepInput: input.stepInput,
        requiredCapabilities: input.requiredCapabilities,
        allowedEffects: input.allowedEffects,
        workflowChanges: input.workflowChanges,
        preferredSkills: input.skills,
        activityRecovery: input.recovery,
        operatorGuidance: input.operatorGuidance,
      },
      null,
      2,
    ),
    '',
    'Operate only inside the prepared worktree. Return one JSON object matching the provided schema.',
  ].join('\n');

const snapshottedStepFrom = (
  snapshot: RunPlanningSnapshot,
  stepReference: string,
): (typeof snapshot.harness.steps)[number] | null =>
  snapshot.harness.steps.find((step) => step.reference === stepReference) ?? null;

const blockingWaitKindFor = (stepReference: string): string =>
  `${stepReference.replace(/@/gu, '.').replace(/[^a-zA-Z0-9_.-]/gu, '-')}.blocked@1`;

const readRepositoryFromInput = (value: unknown): string | null =>
  typeof value === 'object' &&
  value !== null &&
  'repository' in value &&
  typeof (value as { readonly repository?: unknown }).repository === 'string'
    ? (value as { readonly repository: string }).repository
    : null;

const persistBlockedArtifact = (
  traces: TemporalTaskStepTraceStore,
  input: ExecuteTaskStepInput,
  runner: 'agent' | 'integration' | 'process' | 'system',
  details: unknown,
  stdout = '',
  stderr = '',
  command: string | null = null,
  args: readonly string[] = [],
  exitCode: number | null = null,
): readonly string[] => {
  const persisted = traces.persistOutputArtifact({
    operationId: executionOperationId(input),
    workflowId: input.workflowId,
    workflowRunId: input.workflowRunId,
    nodeId: input.nodeId,
    stepReference: input.uses,
    stepAttempt: input.stepAttempt,
    runner,
    command,
    args,
    cwd: input.workspace.path,
    exitCode,
    status: 'blocked',
    stdout,
    stderr,
    details,
  });
  return persisted.ok ? [persisted.value.artifactId] : [];
};

const executionOperationId = (input: ExecuteTaskStepInput): string =>
  `${input.workflowId}:${input.nodeId}:attempt-${String(input.stepAttempt)}`;

const persistAgentBlockedResult = (
  traces: TemporalTaskStepTraceStore,
  input: ExecuteTaskStepInput,
  recovery: TaskStepRecoveryContext,
  summary: string,
  details: unknown,
  stdout: string,
  stderr: string,
  provider: AgentProvider,
): ExecuteTaskStepResult => {
  const result = block(
    summary,
    blockingWaitKindFor(input.uses),
    withRecoveryArtifact(recovery, []),
  );
  const persisted = traces.persistOutputArtifact({
    operationId: executionOperationId(input),
    workflowId: input.workflowId,
    workflowRunId: input.workflowRunId,
    nodeId: input.nodeId,
    stepReference: input.uses,
    stepAttempt: input.stepAttempt,
    runner: 'agent',
    command: provider,
    args: [],
    cwd: input.workspace.path,
    exitCode: null,
    status: 'blocked',
    stdout,
    stderr,
    details,
    result,
  });
  if (!persisted.ok || persisted.value.result === null) {
    throw new Error(`Blocked execution receipt persistence failed for ${input.uses}`);
  }
  return persisted.value.result;
};

export interface TaskExecutionActivityDependencies {
  readonly snapshots: Pick<ImplementationPlanningStore, 'readRunSnapshot'>;
  readonly currentSteps: ReadonlyMap<string, LoadedHarnessStep>;
  readonly traces: TemporalTaskStepTraceStore;
  readonly mutationRecovery: Pick<WorkspaceMutationRecoveryStore, 'prepare'>;
  readonly agentRunner: TaskStepAgentRunner;
  readonly commands: CommandRunner;
  readonly integrations?: IntegrationStepAdapterRegistry;
}

export const executeRegisteredTaskStep = async (
  inputValue: ExecuteTaskStepInput,
  dependencies: TaskExecutionActivityDependencies,
  runtime: TaskStepActivityContext,
): Promise<ExecuteTaskStepResult> => {
  const input = ExecuteTaskStepInputSchema.parse(inputValue);
  const priorResult = dependencies.traces.readOutputResult(executionOperationId(input));
  if (!priorResult.ok) {
    return block(
      `Execution receipt for ${input.uses} is corrupt`,
      blockingWaitKindFor(input.uses),
      [priorResult.error.artifactId],
    );
  }
  if (priorResult.value !== null) return priorResult.value;
  runtime.heartbeat({ phase: 'load_snapshot', nodeId: input.nodeId });
  const loaded = dependencies.snapshots.readRunSnapshot(input.planningSnapshot);
  if (!loaded.ok) {
    return block(
      `Execution snapshot is unavailable: ${loaded.error.kind}`,
      blockingWaitKindFor(input.uses),
    );
  }
  const snapshot = loaded.value;
  const snapshottedStep = snapshottedStepFrom(snapshot, input.uses);
  if (snapshottedStep === null) {
    return block(
      `Execution binding ${input.uses} is absent from the immutable planning snapshot`,
      blockingWaitKindFor(input.uses),
    );
  }
  const current = dependencies.currentSteps.get(input.uses);
  if (current === undefined || current.execution.kind !== snapshottedStep.execution.kind) {
    return block(
      `Current harness registration for ${input.uses} no longer matches the snapshotted execution boundary`,
      blockingWaitKindFor(input.uses),
    );
  }
  if (current.contract.activityDelivery.kind !== input.activityDelivery.kind) {
    return block(
      `Current harness registration for ${input.uses} no longer matches its compiled Activity delivery boundary`,
      blockingWaitKindFor(input.uses),
    );
  }
  const validatedInput = current.contract.inputSchema.safeParse(input.input);
  if (!validatedInput.success) {
    const artifactIds = persistBlockedArtifact(dependencies.traces, input, 'system', {
      kind: 'invalid_step_input',
      issues: validatedInput.error.issues.map(
        (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
      ),
    });
    return block(
      `Execution input for ${input.uses} no longer matches its contract`,
      blockingWaitKindFor(input.uses),
      artifactIds,
    );
  }

  if (snapshottedStep.execution.kind === 'integration') {
    if (
      current.execution.kind !== 'integration' ||
      current.execution.adapter !== snapshottedStep.execution.adapter
    ) {
      const artifactIds = persistBlockedArtifact(dependencies.traces, input, 'system', {
        kind: 'integration_binding_changed',
        snapshottedAdapter: snapshottedStep.execution.adapter,
      });
      return block(
        `Integration binding for ${input.uses} changed after planning`,
        blockingWaitKindFor(input.uses),
        artifactIds,
      );
    }
    const adapter = (dependencies.integrations ?? emptyIntegrationStepAdapterRegistry).get(
      snapshottedStep.execution.adapter,
    );
    if (adapter === undefined) {
      const artifactIds = persistBlockedArtifact(dependencies.traces, input, 'system', {
        kind: 'integration_adapter_unavailable',
        adapter: snapshottedStep.execution.adapter,
      });
      return block(
        `Integration adapter ${snapshottedStep.execution.adapter} is not configured`,
        blockingWaitKindFor(input.uses),
        artifactIds,
      );
    }
    runtime.heartbeat({
      phase: 'integration',
      adapter: snapshottedStep.execution.adapter,
      nodeId: input.nodeId,
    });
    const execution = await adapter.execute({
      operationId: executionOperationId(input),
      taskReference: input.taskReference,
      task: snapshot.task,
      taskSnapshot: snapshot.taskSnapshot,
      stepInput: JsonValueSchema.parse(validatedInput.data),
      workspace: input.workspace,
      operatorGuidance: input.operatorGuidance,
      runtime,
    });
    if (execution.status === 'blocked') {
      const result = block(
        execution.summary,
        blockingWaitKindFor(input.uses),
        execution.artifactIds,
      );
      const persisted = dependencies.traces.persistOutputArtifact({
        operationId: executionOperationId(input),
        workflowId: input.workflowId,
        workflowRunId: input.workflowRunId,
        nodeId: input.nodeId,
        stepReference: input.uses,
        stepAttempt: input.stepAttempt,
        runner: 'integration',
        command: adapter.id,
        args: [],
        cwd: input.workspace.path,
        exitCode: null,
        status: 'blocked',
        stdout: '',
        stderr: '',
        details: { kind: execution.kind, details: execution.details },
        result,
      });
      if (!persisted.ok || persisted.value.result === null) {
        throw new Error(`Integration block receipt persistence failed for ${input.uses}`);
      }
      return persisted.value.result;
    }
    const validatedOutput = current.contract.outputSchema.safeParse(execution.output);
    if (!validatedOutput.success) {
      const artifactIds = persistBlockedArtifact(dependencies.traces, input, 'integration', {
        kind: 'invalid_integration_output',
        adapter: adapter.id,
        issues: validatedOutput.error.issues.map(
          (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
        ),
      });
      return block(
        `Integration adapter ${adapter.id} returned invalid output`,
        blockingWaitKindFor(input.uses),
        [...execution.artifactIds, ...artifactIds],
      );
    }
    const result = ExecuteTaskStepResultSchema.parse({
      status: 'completed',
      summary: execution.summary,
      predicateResults: { 'attempt.succeeded@1': true },
      artifactIds: execution.artifactIds,
      transcriptId: null,
    });
    const persisted = dependencies.traces.persistOutputArtifact({
      operationId: executionOperationId(input),
      workflowId: input.workflowId,
      workflowRunId: input.workflowRunId,
      nodeId: input.nodeId,
      stepReference: input.uses,
      stepAttempt: input.stepAttempt,
      runner: 'integration',
      command: adapter.id,
      args: [],
      cwd: input.workspace.path,
      exitCode: 0,
      status: 'completed',
      stdout: '',
      stderr: '',
      details: { output: validatedOutput.data },
      result,
    });
    if (!persisted.ok || persisted.value.result === null) {
      throw new Error(`Integration completion receipt persistence failed for ${input.uses}`);
    }
    return persisted.value.result;
  }

  if (snapshottedStep.execution.kind === 'agent') {
    const repository = readRepositoryFromInput(validatedInput.data);
    if (repository !== null && repository !== snapshot.repository.reference) {
      const artifactIds = persistBlockedArtifact(dependencies.traces, input, 'system', {
        kind: 'cross_repository_not_supported',
        requestedRepository: repository,
        preparedRepository: snapshot.repository.reference,
      });
      return block(
        `Step ${input.uses} targets ${repository} but this run prepared ${snapshot.repository.reference}`,
        blockingWaitKindFor(input.uses),
        artifactIds,
      );
    }
    let recovery: TaskStepRecoveryContext = TaskStepRecoveryContextSchema.parse({
      kind: 'single_attempt',
    });
    if (input.activityDelivery.kind === 'workspace_reconciled') {
      const prepared = await dependencies.mutationRecovery.prepare({
        operationId: executionOperationId(input),
        workspaceId: input.workspace.workspaceId,
        workspacePath: input.workspace.path,
        stepReference: input.uses,
      });
      if (!prepared.ok) {
        const artifactIds = persistBlockedArtifact(dependencies.traces, input, 'system', {
          kind: 'workspace_recovery_failed',
          failure: prepared.error,
        });
        return block(
          `Workspace recovery for ${input.uses} is blocked: ${prepared.error.kind}`,
          blockingWaitKindFor(input.uses),
          artifactIds,
        );
      }
      recovery = prepared.value;
    }
    const prompt = promptForAgentStep({
      snapshottedPrompt: snapshottedStep.execution.prompt.content,
      taskReference: input.taskReference,
      nodeId: input.nodeId,
      stepAttempt: input.stepAttempt,
      uses: input.uses,
      workspacePath: input.workspace.path,
      taskSnapshot: snapshot.taskSnapshot,
      stepInput: validatedInput.data,
      requiredCapabilities: current.contract.requiredCapabilities,
      allowedEffects: current.contract.allowedEffects,
      workflowChanges: current.contract.workflowChanges,
      skills: snapshottedStep.execution.skills,
      recovery,
      operatorGuidance: input.operatorGuidance,
    });
    const provider = await dependencies.agentRunner.run({
      operationId: executionOperationId(input),
      prompt,
      skills: snapshottedStep.execution.skills,
      recovery,
      outputSchema: AgentStepOutcomeSchema,
      cwd: input.workspace.path,
      timeoutMs: 35 * 60_000,
      runtime,
      transcriptStore: dependencies.traces,
    });
    if (!provider.ok) {
      return persistAgentBlockedResult(
        dependencies.traces,
        input,
        recovery,
        `Agent execution for ${input.uses} is blocked: ${provider.error.kind}`,
        provider.error,
        'stdout' in provider.error ? provider.error.stdout : '',
        'stderr' in provider.error ? provider.error.stderr : '',
        dependencies.agentRunner.provider,
      );
    }
    const decision = AgentStepOutcomeSchema.parse(provider.value.finalMessage);
    if (decision.status === 'workflow_change_required') {
      const declared = parseDeclaredWorkflowChangeRequest(
        decision.request,
        current.contract.workflowChanges,
      );
      if (!declared.ok) {
        return persistAgentBlockedResult(
          dependencies.traces,
          input,
          recovery,
          `Agent execution for ${input.uses} returned an invalid workflow change request`,
          {
            kind: declared.error.kind,
            ...(declared.error.kind === 'invalid_request'
              ? { issues: declared.error.issues }
              : { changeKind: declared.error.changeKind }),
          },
          provider.value.stdout,
          provider.value.stderr,
          dependencies.agentRunner.provider,
        );
      }
      const result = ExecuteTaskStepResultSchema.parse({
        status: 'workflow_change_required',
        summary: `Agent execution for ${input.uses} requested a workflow change`,
        request: declared.value,
        artifactIds: withRecoveryArtifact(recovery, []),
        transcriptId: dependencies.traces.transcriptIdFor(executionOperationId(input)),
        predicateResults: {},
      });
      const persisted = dependencies.traces.persistOutputArtifact({
        operationId: executionOperationId(input),
        workflowId: input.workflowId,
        workflowRunId: input.workflowRunId,
        nodeId: input.nodeId,
        stepReference: input.uses,
        stepAttempt: input.stepAttempt,
        runner: 'agent',
        command: dependencies.agentRunner.provider,
        args: [],
        cwd: input.workspace.path,
        exitCode: 0,
        status: 'workflow_change_required',
        stdout: provider.value.stdout,
        stderr: provider.value.stderr,
        details: { request: declared.value },
        result,
      });
      if (!persisted.ok || persisted.value.result === null) {
        throw new Error(`Workflow change receipt persistence failed for ${input.uses}`);
      }
      return persisted.value.result;
    }
    const validatedOutput = current.contract.outputSchema.safeParse(decision.output);
    if (!validatedOutput.success) {
      return persistAgentBlockedResult(
        dependencies.traces,
        input,
        recovery,
        `Agent execution for ${input.uses} returned output that does not match the registered contract`,
        {
          kind: 'invalid_step_output',
          issues: validatedOutput.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        },
        provider.value.stdout,
        provider.value.stderr,
        dependencies.agentRunner.provider,
      );
    }
    const outputRecord = validatedOutput.data as {
      readonly summary?: string;
      readonly artifacts?: unknown;
    };
    const result = ExecuteTaskStepResultSchema.parse({
      status: 'completed',
      summary:
        typeof outputRecord.summary === 'string' && outputRecord.summary.trim().length > 0
          ? outputRecord.summary
          : `${input.uses} completed`,
      predicateResults: { 'attempt.succeeded@1': true },
      artifactIds: withRecoveryArtifact(recovery, []),
      transcriptId: dependencies.traces.transcriptIdFor(executionOperationId(input)),
    });
    const persisted = dependencies.traces.persistOutputArtifact({
      operationId: executionOperationId(input),
      workflowId: input.workflowId,
      workflowRunId: input.workflowRunId,
      nodeId: input.nodeId,
      stepReference: input.uses,
      stepAttempt: input.stepAttempt,
      runner: 'agent',
      command: dependencies.agentRunner.provider,
      args: [],
      cwd: input.workspace.path,
      exitCode: 0,
      status: 'completed',
      stdout: provider.value.stdout,
      stderr: provider.value.stderr,
      details: { output: validatedOutput.data },
      result,
    });
    if (!persisted.ok || persisted.value.result === null) {
      throw new Error(`Completion receipt persistence failed for ${input.uses}`);
    }
    return persisted.value.result;
  }

  const inputRepository = readRepositoryFromInput(validatedInput.data);
  if (inputRepository !== null && inputRepository !== snapshot.repository.reference) {
    const artifactIds = persistBlockedArtifact(dependencies.traces, input, 'system', {
      kind: 'cross_repository_not_supported',
      requestedRepository: inputRepository,
      preparedRepository: snapshot.repository.reference,
    });
    return block(
      `Process step ${input.uses} targets ${inputRepository} but this run prepared ${snapshot.repository.reference}`,
      blockingWaitKindFor(input.uses),
      artifactIds,
    );
  }
  const invocation = commandLineToInvocation(snapshottedStep.execution.command);
  if (!invocation.ok) {
    const artifactIds = persistBlockedArtifact(
      dependencies.traces,
      input,
      'system',
      invocation.error,
    );
    return block(
      `Process command for ${input.uses} uses unsupported shell syntax`,
      blockingWaitKindFor(input.uses),
      artifactIds,
    );
  }
  runtime.heartbeat({ phase: 'process', nodeId: input.nodeId });
  const processResult = await dependencies.commands.run({
    command: invocation.value.command,
    args: [...invocation.value.args],
    cwd: input.workspace.path,
    stdin: '',
    timeoutMs: 35 * 60_000,
    cancellationSignal: runtime.cancellationSignal,
    onOutput: (stream, chunk) => {
      const appended = dependencies.traces.append(
        executionOperationId(input),
        runtime.attempt,
        stream,
        chunk,
      );
      if (!appended.ok) {
        throw new Error(`Task step transcript persistence failed: ${appended.error.kind}`);
      }
      runtime.heartbeat({ phase: 'process_output', stream });
    },
  });
  if (processResult.status !== 'exited' || processResult.exitCode !== 0) {
    const stdout = processResult.status === 'spawn_failed' ? '' : processResult.stdout;
    const stderr =
      processResult.status === 'spawn_failed' ? processResult.message : processResult.stderr;
    const exitCode = processResult.status === 'exited' ? processResult.exitCode : null;
    const artifactIds = persistBlockedArtifact(
      dependencies.traces,
      input,
      'process',
      {
        kind: processResult.status,
        ...(processResult.status === 'spawn_failed'
          ? { message: processResult.message }
          : { exitCode: processResult.status === 'exited' ? processResult.exitCode : null }),
      },
      stdout,
      stderr,
      invocation.value.command,
      invocation.value.args,
      exitCode,
    );
    return block(
      `Process execution for ${input.uses} did not complete successfully`,
      blockingWaitKindFor(input.uses),
      artifactIds,
    );
  }
  const processOutput = current.contract.outputSchema.safeParse({
    exitCode: processResult.exitCode,
    receiptId: `${planningTranscriptIdFor(executionOperationId(input))}:process-receipt`,
  });
  if (!processOutput.success) {
    const artifactIds = persistBlockedArtifact(
      dependencies.traces,
      input,
      'process',
      {
        kind: 'invalid_process_output',
        issues: processOutput.error.issues.map(
          (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
        ),
      },
      processResult.stdout,
      processResult.stderr,
      invocation.value.command,
      invocation.value.args,
      processResult.exitCode,
    );
    return block(
      `Process execution for ${input.uses} produced an invalid receipt`,
      blockingWaitKindFor(input.uses),
      artifactIds,
    );
  }
  const persisted = dependencies.traces.persistOutputArtifact({
    operationId: executionOperationId(input),
    workflowId: input.workflowId,
    workflowRunId: input.workflowRunId,
    nodeId: input.nodeId,
    stepReference: input.uses,
    stepAttempt: input.stepAttempt,
    runner: 'process',
    command: invocation.value.command,
    args: invocation.value.args,
    cwd: input.workspace.path,
    exitCode: processResult.exitCode,
    status: 'completed',
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    details: { output: processOutput.data },
  });
  return ExecuteTaskStepResultSchema.parse({
    status: 'completed',
    summary: `${input.uses} completed`,
    predicateResults: { 'attempt.succeeded@1': true },
    artifactIds: persisted.ok ? [persisted.value.artifactId] : [],
    transcriptId: dependencies.traces.transcriptIdFor(executionOperationId(input)),
  });
};

const temporalRuntime = (): TaskStepActivityContext => {
  const context = Context.current();
  return {
    attempt: context.info.attempt,
    cancellationSignal: context.cancellationSignal,
    heartbeat: (details) => {
      context.heartbeat(details);
      context.cancellationSignal.throwIfAborted();
    },
  };
};

export const createTaskExecutionActivity = (
  dependencies: TaskExecutionActivityDependencies,
): Pick<
  TaskWorkflowActivities,
  | 'evaluatePredicate'
  | 'executeStep'
  | 'executeWorkspaceReconciledStep'
  | 'executeRemoteReconciledStep'
> => ({
  executeStep: async (input) => executeRegisteredTaskStep(input, dependencies, temporalRuntime()),
  executeWorkspaceReconciledStep: async (input) =>
    executeRegisteredTaskStep(input, dependencies, temporalRuntime()),
  executeRemoteReconciledStep: async (input) =>
    executeRegisteredTaskStep(input, dependencies, temporalRuntime()),
  evaluatePredicate: (input) => Promise.resolve(input.facts[input.reference] ?? true),
});

export const createCurrentStepRegistry = (
  pack: LoadedHarnessPack,
): ReadonlyMap<string, LoadedHarnessStep> => registryFrom(pack);

export type { ImplementationPlanningStoreError };
