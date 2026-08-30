import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { Context } from '@temporalio/activity';
import { z } from 'zod';

import {
  acceptsAnyProcessExit,
  AgentClaimSchema,
  CompletionVerdictSchema,
  blockReceiptId,
  evaluateBlockCompletion,
  type AgentClaim,
  type AgentClaimCategory,
  type BlockReceipt,
  type BlockReceiptStore,
  type CompletionVerdict,
} from '../../blocks/index.js';
import type {
  LoadedHarnessPack,
  LoadedHarnessStep,
  ResolvedExecutionProfile,
} from '../../harness/index.js';
import { processExecutionPlanFor } from '../../harness/index.js';
import {
  emptyIntegrationStepAdapterRegistry,
  type IntegrationStepAdapterRegistry,
  type PullRequestReviewEvidence,
  type TaskRunEvidence,
  type TaskRunStepEvidence,
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
  codexOutputJsonSchema,
  normalizeCodexStructuredOutput,
  prepareIsolatedCodexHome,
  providerFailureMessage,
} from '../../providers/codex-cli-support.js';
import { prepareIsolatedClaudeHome } from '../../providers/claude-cli-support.js';
import { parseSubscriptionCliStream } from '../../providers/subscription-cli-stream.js';
import {
  prepareAgentSkills,
  type AgentProvider,
  workspaceHarnessEnvironment,
} from '../../providers/agent-skills.js';
import {
  AgentInvocationReferencesSchema,
  executionAgentInvocationId,
  LedgerAgentInvocationRecorder,
  type AgentInvocationArtifact,
  type AgentInvocationRecorder,
  type AgentInvocationReferences,
} from '../../observability/agent-invocation.js';
import type { AgentInvocationUsage } from '../../observability/agent-usage.js';
import { estimateApiCost } from '../../providers/api-cost.js';
import type {
  CommandMount,
  CommandRequest,
  CommandResult,
  WorkspaceCommandRunner,
} from '../../providers/command-runner.js';
import type { RunPlanningSnapshot } from '../../planning/run-planning-snapshot.js';
import type { Clock } from '../../shared/clock.js';
import { err, ok, type Outcome } from '../../shared/outcome.js';
import { TrackerStatusUpdatesSchema } from '../../shared/task-run-settings.js';
import { JsonValueSchema, type JsonValue } from '../../workflow/schema.js';
import {
  WorkflowChangeRequestSchema,
  parseDeclaredWorkflowChangeRequest,
  resolveOutputPredicateFacts,
} from '../../workflow/index.js';
import {
  ExecuteTaskStepInputSchema,
  ExecuteTaskStepResultSchema,
  agentStepOutcomeSchema,
  type AgentStepOutcome,
  type ExecuteTaskStepInput,
  type ExecuteTaskStepResult,
} from './block-execution-contracts.js';
import type {
  ExecutionWorkflowActivities,
  RunExecutionBlockInput,
} from '../execution-kernel/contracts.js';
import type { WorkspaceStore } from '../../workspaces/store.js';
import type { DockerWorkspaceRuntimePreparer } from '../../workspaces/docker-runtime-manager.js';
import { resolveWorkspaceRuntimePolicy } from '../../workspaces/runtime-policy.js';
import { TaskStepOutputArtifactSchema, type TaskStepOutputArtifact } from '../task-step-output.js';
import {
  TaskStepRecoveryContextSchema,
  type TaskStepRecoveryContext,
  type WorkspaceMutationRecoveryStore,
} from './workspace-mutation-recovery.js';
import { collectBlockCompletionEvidence } from './block-completion-evidence.js';
import type { TaskStepFilesystemStore } from './task-step-filesystem.js';
import type { TaskStepEvidenceStore } from './task-step-evidence.js';
import { normalizeTaskStepEvidencePaths } from './task-step-evidence.js';

const removeWorkspaceScratchMountPoint = async (path: string): Promise<void> => {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EACCES') return;
    throw error;
  }
};

export const decodeAgentStepOutcome = (
  envelope: unknown,
  outputSchema: z.ZodType,
): Outcome<
  AgentStepOutcome,
  { readonly kind: 'invalid_agent_outcome'; readonly issues: readonly string[] }
> => {
  const outcome = agentStepOutcomeSchema(outputSchema).safeParse(envelope);
  return outcome.success
    ? ok(outcome.data)
    : err({
        kind: 'invalid_agent_outcome',
        issues: outcome.error.issues.map(
          (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
        ),
      });
};

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
  readonly taskReference: string;
  readonly inputArtifactIds: readonly string[];
  readonly operationId: string;
  readonly workflowId: string;
  readonly workflowRunId: string;
  readonly nodeId: string;
  readonly blockRun: number;
  readonly providerAttempt: number;
  readonly stepReference: string;
  readonly profile: ResolvedExecutionProfile;
  readonly prompt: string;
  readonly skills: readonly string[];
  readonly recovery: TaskStepRecoveryContext;
  readonly outputSchema: z.ZodType;
  readonly cwd: string;
  readonly workspaceAccess: 'read_only' | 'read_write';
  readonly runtime: TaskStepActivityContext;
  readonly transcriptStore: TemporalTaskStepTraceStore;
}

export interface TaskStepAgentResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly finalMessage: unknown;
  readonly usage: AgentInvocationUsage;
  readonly artifactIds: readonly string[];
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
  | { readonly kind: 'evidence_persistence_failed'; readonly message: string }
  | { readonly kind: 'input_evidence_unavailable'; readonly message: string }
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
  run(request: TaskStepAgentRequest): Promise<Outcome<TaskStepAgentResult, TaskStepAgentFailure>>;
}

const invocationUsageTokens = (usage?: AgentInvocationUsage): AgentInvocationArtifact['usage'] => ({
  inputTokens: usage?.inputTokens ?? null,
  cachedInputTokens: usage?.cachedInputTokens ?? null,
  outputTokens: usage?.outputTokens ?? null,
  reasoningOutputTokens: usage?.reasoningOutputTokens ?? null,
});

const invocationCost = (usage?: AgentInvocationUsage): AgentInvocationArtifact['cost'] =>
  usage?.apiCost ?? { source: 'unrated' };

const invocationStatusFromFinalMessage = (
  finalMessage: unknown,
  outputSchema: z.ZodType,
): AgentInvocationArtifact['status'] => {
  const parsed = outputSchema.safeParse(finalMessage);
  if (!parsed.success) return 'failed';
  if (typeof parsed.data !== 'object' || parsed.data === null) return 'completed';
  const status = (parsed.data as Readonly<Record<string, unknown>>).status;
  if (status === 'waiting') return 'waiting';
  return status === 'failed' ? 'failed' : 'completed';
};

const commandExitStatus = (result: CommandResult): AgentInvocationArtifact['exitStatus'] => {
  switch (result.status) {
    case 'exited':
      return { kind: 'exited', exitCode: result.exitCode };
    case 'timed_out':
      return { kind: 'timed_out' };
    case 'spawn_failed':
      return { kind: 'spawn_failed', message: result.message };
  }
};

const thrownExitStatus = (error: unknown): AgentInvocationArtifact['exitStatus'] => ({
  kind: 'thrown',
  message: error instanceof Error ? error.message : String(error),
});

export class SubscriptionCliTaskStepAgentRunner implements TaskStepAgentRunner {
  public constructor(
    private readonly runner: WorkspaceCommandRunner,
    private readonly filesystems: TaskStepFilesystemStore,
    private readonly evidence: TaskStepEvidenceStore,
  ) {}

  public async run(
    request: TaskStepAgentRequest,
  ): Promise<Outcome<TaskStepAgentResult, TaskStepAgentFailure>> {
    const profile = request.profile;
    const command = profile.command;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let heartbeatFailure: Error | null = null;
    const heartbeat = (
      details: {
        readonly stdoutBytes?: number;
        readonly stderrBytes?: number;
      } = {},
    ): void => {
      try {
        request.runtime.heartbeat({ phase: 'agent', ...details });
      } catch (error) {
        heartbeatFailure ??= error instanceof Error ? error : new Error(String(error));
        clearInterval(heartbeatTimer);
      }
    };
    const throwIfHeartbeatFailed = (): void => {
      if (heartbeatFailure !== null) throw heartbeatFailure;
    };
    const heartbeatTimer = setInterval(() => {
      heartbeat();
    }, 10_000);
    heartbeatTimer.unref();
    try {
      heartbeat();
      throwIfHeartbeatFailed();
      const version = await this.runner.run({
        command,
        args: ['--version'],
        cwd: request.cwd,
        workspaceAccess: 'read_write',
        stdin: '',
        timeoutMs: 10_000,
        cancellationSignal: request.runtime.cancellationSignal,
      });
      throwIfHeartbeatFailed();
      if (version.status === 'spawn_failed') {
        return err({ kind: 'provider_unavailable', message: version.message });
      }
      if (version.status !== 'exited' || version.exitCode !== 0) {
        return err({
          kind: 'provider_unavailable',
          message: `${profile.provider} CLI version probe failed`,
        });
      }

      const directory = await mkdtemp(join(tmpdir(), 'tasker-step-agent-'));
      const stepFilesystem = await this.filesystems.prepare(request.operationId);
      const workspaceScratchPath = join(
        request.cwd,
        '.tasker',
        'scratch',
        basename(stepFilesystem.scratchPath),
      );
      await mkdir(workspaceScratchPath, { recursive: true, mode: 0o700 });
      try {
        const inputArtifacts = await this.evidence.materializeInputs(
          request.inputArtifactIds,
          stepFilesystem.inputsPath,
        );
        if (!inputArtifacts.ok) {
          return err({
            kind: 'input_evidence_unavailable',
            message: `Immutable input evidence is unavailable: ${inputArtifacts.error.kind}`,
          });
        }
        const schemaPath = join(directory, 'task-step-output.schema.json');
        const isolatedConfigurationRoot = join(directory, 'provider-home');
        if (profile.provider === 'codex') {
          await prepareIsolatedCodexHome(isolatedConfigurationRoot);
        } else {
          await prepareIsolatedClaudeHome(isolatedConfigurationRoot);
        }
        const preparedSkills = await prepareAgentSkills({
          provider: profile.provider,
          repositoryPath: request.cwd,
          configurationRoot: isolatedConfigurationRoot,
          selection: {
            kind: 'step',
            reference: request.stepReference,
            skills: [...request.skills],
          },
        });
        if (!preparedSkills.ok) return err(preparedSkills.error);
        const outputSchema =
          profile.provider === 'codex'
            ? codexOutputJsonSchema(request.outputSchema)
            : z.toJSONSchema(request.outputSchema);
        await writeFile(schemaPath, `${JSON.stringify(outputSchema, null, 2)}\n`, 'utf8');
        const harnessEnvironment = workspaceHarnessEnvironment(
          request.cwd,
          preparedSkills.value.skillsRoot,
        );
        const harnessEnvironmentFile = harnessEnvironment.TASKER_HARNESS_ENV_FILE;
        const inputEvidenceMounts: readonly CommandMount[] = inputArtifacts.value.map(
          ({ path }) => ({
            source: path,
            target: path,
            readOnly: true,
          }),
        );
        const extraMounts: readonly CommandMount[] =
          harnessEnvironmentFile !== undefined && harnessEnvironmentFile !== '/dev/null'
            ? [
                {
                  source: harnessEnvironmentFile,
                  target: harnessEnvironmentFile,
                  readOnly: true,
                },
              ]
            : [];
        const args =
          profile.provider === 'codex'
            ? [
                'exec',
                '--model',
                profile.model,
                '-c',
                `service_tier="${profile.serviceTier}"`,
                '-c',
                `model_reasoning_effort="${profile.effort}"`,
                '--ephemeral',
                '--skip-git-repo-check',
                '--dangerously-bypass-approvals-and-sandbox',
                '--cd',
                request.cwd,
                '--output-schema',
                schemaPath,
                '--json',
                '-',
              ]
            : [
                '--print',
                '--model',
                profile.model,
                '--effort',
                profile.effort,
                '--output-format',
                'stream-json',
                '--verbose',
                '--no-session-persistence',
                '--dangerously-skip-permissions',
                '--json-schema',
                JSON.stringify(outputSchema),
                ...preparedSkills.value.cliArguments,
              ];
        const stdin = [
          request.prompt,
          '',
          'Mounted immutable input evidence:',
          JSON.stringify(inputArtifacts.value, null, 2),
          'Inspect these exact files. Do not rerun broad verification to reconstruct accepted evidence.',
        ].join('\n');
        const argv = [command, ...args];
        const recorder = request.transcriptStore.agentInvocationRecorder();
        const invocationId = executionAgentInvocationId(
          request.operationId,
          request.providerAttempt,
        );
        const invocationReferences = AgentInvocationReferencesSchema.parse({
          kind: 'execution',
          workflowId: request.workflowId,
          runId: request.workflowRunId,
          nodeId: request.nodeId,
          blockRun: request.blockRun,
          providerAttempt: request.providerAttempt,
          transcriptId: request.transcriptStore.transcriptIdFor(request.operationId),
          outputArtifactIds: [request.transcriptStore.outputArtifactIdFor(request.operationId)],
          receiptArtifactId: blockReceiptId({
            workflowId: request.workflowId,
            workflowRunId: request.workflowRunId,
            nodeId: request.nodeId,
            blockRun: request.blockRun,
          }),
        });
        const startedAt = recorder.now();
        this.recordInvocationStart(
          request,
          recorder,
          invocationId,
          invocationReferences,
          startedAt,
        );
        heartbeat({ stdoutBytes, stderrBytes });
        let execution: CommandResult | null = null;
        try {
          execution = await this.runCommand(request, {
            command,
            args,
            cwd: request.cwd,
            workspaceAccess: request.workspaceAccess,
            env: {
              ...(profile.provider === 'codex'
                ? { CODEX_HOME: isolatedConfigurationRoot }
                : { HOME: isolatedConfigurationRoot }),
              ...harnessEnvironment,
              TASKER_SCRATCH_ROOT: workspaceScratchPath,
              TASKER_ARTIFACTS_ROOT: stepFilesystem.artifactsPath,
            },
            mounts: [
              { source: directory, target: directory, readOnly: false },
              {
                source: stepFilesystem.scratchPath,
                target: workspaceScratchPath,
                readOnly: false,
              },
              {
                source: stepFilesystem.artifactsPath,
                target: stepFilesystem.artifactsPath,
                readOnly: false,
              },
              ...extraMounts,
              ...inputEvidenceMounts,
            ],
            stdin,
            timeoutMs: profile.timeoutMs,
            onOutput: (stream, chunk) => {
              if (stream === 'stdout') stdoutBytes += Buffer.byteLength(chunk, 'utf8');
              else stderrBytes += Buffer.byteLength(chunk, 'utf8');
              heartbeat({ stdoutBytes, stderrBytes });
            },
          });
          throwIfHeartbeatFailed();
          if (execution.status === 'spawn_failed') {
            this.finishInvocation(request, recorder, {
              invocationId,
              references: invocationReferences,
              startedAt,
              prompt: stdin,
              argv,
              status: 'failed',
              result: execution,
            });
            return err({ kind: 'provider_unavailable', message: execution.message });
          }
          if (execution.status === 'timed_out') {
            this.finishInvocation(request, recorder, {
              invocationId,
              references: invocationReferences,
              startedAt,
              prompt: stdin,
              argv,
              status: 'failed',
              result: execution,
            });
            return err({
              kind: 'provider_timed_out',
              durationMs: execution.durationMs,
              stderr: execution.stderr,
            });
          }
          if (execution.exitCode !== 0) {
            this.finishInvocation(request, recorder, {
              invocationId,
              references: invocationReferences,
              startedAt,
              prompt: stdin,
              argv,
              status: 'failed',
              result: execution,
            });
            return err({
              kind: 'provider_failed',
              exitCode: execution.exitCode,
              message: providerFailureMessage(execution.stdout, execution.stderr),
              stdout: execution.stdout,
              stderr: execution.stderr,
            });
          }
          const stream = parseSubscriptionCliStream(profile.provider, execution.stdout);
          if (!stream.ok) {
            this.finishInvocation(request, recorder, {
              invocationId,
              references: invocationReferences,
              startedAt,
              prompt: stdin,
              argv,
              status: 'failed',
              result: execution,
            });
            return err(stream.error);
          }
          const usage = {
            provider: profile.provider,
            profile: profile.name,
            profileSha256: profile.configurationSha256,
            model: profile.model,
            effort: profile.effort,
            serviceTier: profile.provider === 'codex' ? profile.serviceTier : null,
            sessionId: stream.value.sessionId,
            durationMs: execution.durationMs,
            inputTokens: stream.value.usage?.inputTokens ?? 0,
            cachedInputTokens: stream.value.usage?.cachedInputTokens ?? 0,
            outputTokens: stream.value.usage?.outputTokens ?? 0,
            reasoningOutputTokens: stream.value.usage?.reasoningOutputTokens ?? 0,
            apiCost: estimateApiCost(profile, stream.value.usage, stream.value.reportedCostUsd),
          };
          if (stream.value.skippedCount > 0) {
            const samplesNote =
              stream.value.skippedCount > stream.value.diagnostics.length
                ? ' (showing first 20)'
                : '';
            const diagnosticsLine = `\n[stream diagnostics] skipped ${String(stream.value.skippedCount)} non-JSON line(s)${samplesNote}:\n${stream.value.diagnostics.join('\n')}\n`;
            const appended = request.transcriptStore.append(
              request.operationId,
              request.providerAttempt,
              'stderr',
              diagnosticsLine,
            );
            if (!appended.ok) {
              this.finishInvocation(request, recorder, {
                invocationId,
                references: invocationReferences,
                startedAt,
                prompt: stdin,
                argv,
                status: 'failed',
                result: execution,
                usage,
              });
              return err({
                kind: 'evidence_persistence_failed',
                message: `Task step transcript persistence failed: ${appended.error.kind}`,
              });
            }
          }
          const evidence = await this.evidence.register(
            request.operationId,
            stepFilesystem.artifactsPath,
          );
          if (!evidence.ok) {
            this.finishInvocation(request, recorder, {
              invocationId,
              references: invocationReferences,
              startedAt,
              prompt: stdin,
              argv,
              status: 'failed',
              result: execution,
              usage,
            });
            return err({
              kind: 'evidence_persistence_failed',
              message: `Task-step evidence registration failed: ${evidence.error.kind}`,
            });
          }
          const completedInvocationReferences = AgentInvocationReferencesSchema.parse({
            ...invocationReferences,
            outputArtifactIds: [...invocationReferences.outputArtifactIds, ...evidence.value],
          });
          const finalMessage =
            profile.provider === 'codex'
              ? normalizeCodexStructuredOutput(stream.value.finalMessage, request.outputSchema)
              : stream.value.finalMessage;
          const parsed = request.outputSchema.safeParse(
            normalizeTaskStepEvidencePaths(finalMessage, stepFilesystem.artifactsPath),
          );
          if (!parsed.success) {
            this.finishInvocation(request, recorder, {
              invocationId,
              references: completedInvocationReferences,
              startedAt,
              prompt: stdin,
              argv,
              status: 'failed',
              result: execution,
              usage,
            });
            return err({
              kind: 'invalid_output',
              issues: parsed.error.issues.map(
                (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
              ),
            });
          }
          this.finishInvocation(request, recorder, {
            invocationId,
            references: completedInvocationReferences,
            startedAt,
            prompt: stdin,
            argv,
            status: invocationStatusFromFinalMessage(parsed.data, request.outputSchema),
            result: execution,
            usage,
          });
          return ok({
            stdout: execution.stdout,
            stderr: execution.stderr,
            finalMessage: parsed.data,
            artifactIds: evidence.value,
            usage,
          });
        } catch (error) {
          this.finishInvocation(
            request,
            recorder,
            execution === null
              ? {
                  invocationId,
                  references: invocationReferences,
                  startedAt,
                  prompt: stdin,
                  argv,
                  status: 'failed',
                  thrown: error,
                }
              : {
                  invocationId,
                  references: invocationReferences,
                  startedAt,
                  prompt: stdin,
                  argv,
                  status: 'failed',
                  result: execution,
                  thrown: error,
                },
          );
          throw error;
        }
      } finally {
        await this.filesystems.cleanupScratch(stepFilesystem);
        await removeWorkspaceScratchMountPoint(workspaceScratchPath);
        await rm(directory, { recursive: true, force: true });
      }
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  private async runCommand(
    request: TaskStepAgentRequest,
    command: CommandRequest,
  ): Promise<CommandResult> {
    const commandOutput = command.onOutput;
    const result = await this.runner.run({
      ...command,
      cancellationSignal: request.runtime.cancellationSignal,
      onOutput: (stream, chunk) => {
        const appended = request.transcriptStore.append(
          request.operationId,
          request.providerAttempt,
          stream,
          chunk,
        );
        if (!appended.ok) {
          throw new Error(`Task step transcript persistence failed: ${appended.error.kind}`);
        }
        commandOutput?.(stream, chunk);
      },
    });
    request.runtime.cancellationSignal.throwIfAborted();
    return result;
  }

  private invocationArtifact(input: {
    readonly request: TaskStepAgentRequest;
    readonly invocationId: string;
    readonly references: AgentInvocationReferences;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly durationMs: number;
    readonly prompt: string;
    readonly argv: readonly string[];
    readonly status: AgentInvocationArtifact['status'];
    readonly exitStatus: AgentInvocationArtifact['exitStatus'];
    readonly usage?: AgentInvocationUsage;
  }): AgentInvocationArtifact {
    return {
      schemaVersion: 1,
      invocationId: input.invocationId,
      taskReference: input.request.taskReference,
      prompt: input.prompt,
      promptBytes: Buffer.byteLength(input.prompt, 'utf8'),
      provider: input.request.profile.provider,
      profile: input.request.profile.name,
      profileSha256: input.request.profile.configurationSha256,
      model: input.request.profile.model,
      effort: input.request.profile.effort,
      serviceTier:
        input.request.profile.provider === 'codex' ? input.request.profile.serviceTier : null,
      argv: [...input.argv],
      skills: [...input.request.skills],
      inputEvidenceArtifactIds: [...input.request.inputArtifactIds],
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs: input.durationMs,
      status: input.status,
      exitStatus: input.exitStatus,
      usage: invocationUsageTokens(input.usage),
      cost: invocationCost(input.usage),
      references: input.references,
    };
  }

  private recordInvocationStart(
    request: TaskStepAgentRequest,
    recorder: AgentInvocationRecorder,
    invocationId: string,
    references: AgentInvocationReferences,
    startedAt: string,
  ): void {
    try {
      const started = recorder.start({
        invocationId,
        taskReference: request.taskReference,
        references,
        startedAt,
      });
      if (started.ok) return;
      this.appendObservabilityFailure(
        request,
        `agent invocation start persistence failed for ${invocationId}: ${started.error.kind}`,
      );
    } catch (error) {
      this.appendObservabilityFailure(
        request,
        `agent invocation start persistence threw for ${invocationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private finishInvocation(
    request: TaskStepAgentRequest,
    recorder: AgentInvocationRecorder,
    input: {
      readonly invocationId: string;
      readonly references: AgentInvocationReferences;
      readonly startedAt: string;
      readonly prompt: string;
      readonly argv: readonly string[];
      readonly status: AgentInvocationArtifact['status'];
      readonly result?: CommandResult;
      readonly usage?: AgentInvocationUsage;
      readonly thrown?: unknown;
    },
  ): void {
    try {
      const finishedAt = recorder.now();
      const artifact = this.invocationArtifact({
        request,
        invocationId: input.invocationId,
        references: input.references,
        startedAt: input.startedAt,
        finishedAt,
        durationMs:
          input.result?.durationMs ??
          Math.max(0, Date.parse(finishedAt) - Date.parse(input.startedAt)),
        prompt: input.prompt,
        argv: input.argv,
        status: input.status,
        exitStatus:
          input.result === undefined
            ? thrownExitStatus(input.thrown)
            : commandExitStatus(input.result),
        ...(input.usage === undefined ? {} : { usage: input.usage }),
      });
      const finished = recorder.finish(artifact);
      if (finished.ok) return;
      this.appendObservabilityFailure(
        request,
        `agent invocation finish persistence failed for ${artifact.invocationId}: ${finished.error.kind}`,
      );
    } catch (error) {
      this.appendObservabilityFailure(
        request,
        `agent invocation finish persistence threw for ${input.invocationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private appendObservabilityFailure(request: TaskStepAgentRequest, message: string): void {
    try {
      request.transcriptStore.append(
        request.operationId,
        request.providerAttempt,
        'stderr',
        `\n[tasker observability] ${message}\n`,
      );
    } catch {
      return;
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

const block = (
  summary: string,
  waitKind: string,
  artifactIds: readonly string[] = [],
  classification: {
    readonly category?: AgentClaimCategory;
    readonly retryable?: boolean;
  } = {},
): ExecuteTaskStepResult =>
  ExecuteTaskStepResultSchema.parse({
    status: 'blocked',
    summary,
    waitKind,
    artifactIds,
    transcriptId: null,
    category: classification.category ?? 'infrastructure',
    retryable: classification.retryable ?? true,
  });

const fail = (
  summary: string,
  category: AgentClaimCategory,
  retryable: boolean,
  artifactIds: readonly string[] = [],
): ExecuteTaskStepResult =>
  ExecuteTaskStepResultSchema.parse({
    status: 'failed',
    summary,
    category,
    retryable,
    artifactIds,
    transcriptId: null,
  });

const integrationBlockedCategory = (
  kind:
    | 'configuration'
    | 'infrastructure'
    | 'invalid_request'
    | 'remote_conflict'
    | 'verification'
    | 'unknown_outcome',
): AgentClaimCategory => {
  switch (kind) {
    case 'configuration':
    case 'infrastructure':
    case 'unknown_outcome':
      return 'infrastructure';
    case 'remote_conflict':
    case 'verification':
      return 'dependency';
    case 'invalid_request':
      return 'task_ambiguity';
  }
};

const withRecoveryArtifact = (
  recovery: TaskStepRecoveryContext,
  artifactIds: readonly string[],
): readonly string[] =>
  recovery.kind === 'single_attempt' ? artifactIds : [recovery.intentArtifactId, ...artifactIds];

const registryFrom = (pack: LoadedHarnessPack): ReadonlyMap<string, LoadedHarnessStep> =>
  new Map(pack.steps.map((step) => [step.reference, step] as const));

const HISTORY_INDEX_LIMIT = 10;
const REVIEW_INPUTS_LIMIT = 5;

interface CappedEntries<T> {
  readonly entries: readonly T[];
  readonly omittedCount: number;
}

const capEntries = <T>(items: readonly T[], limit: number): CappedEntries<T> => ({
  entries: items.slice(-limit),
  omittedCount: Math.max(0, items.length - limit),
});

export const runHistoryIndex = (steps: readonly TaskRunStepEvidence[]) =>
  capEntries(
    steps.map(
      ({ operationId, nodeId, stepReference, status, summary, artifactIds, recordedAt }) => ({
        operationId,
        nodeId,
        stepReference,
        status,
        summary,
        artifactIds,
        recordedAt,
      }),
    ),
    HISTORY_INDEX_LIMIT,
  );

export const selectAgentRunEvidence = (evidence: TaskRunEvidence): TaskRunEvidence => {
  const selected = new Set<string>();
  const byNode = new Map<string, TaskRunStepEvidence[]>();
  for (const step of evidence.completedSteps) {
    const steps = byNode.get(step.nodeId) ?? [];
    steps.push(step);
    byNode.set(step.nodeId, steps);
  }
  for (const steps of byNode.values()) {
    const latest = steps.at(-1);
    const completed = steps.findLast(({ status }) => status === 'completed');
    const interrupted = steps.findLast(({ status }) => status !== 'completed');
    if (latest !== undefined) selected.add(latest.operationId);
    if (completed !== undefined) selected.add(completed.operationId);
    if (interrupted !== undefined) selected.add(interrupted.operationId);
  }
  return {
    acceptedPlan: evidence.acceptedPlan,
    completedSteps: evidence.completedSteps.filter(({ operationId }) => selected.has(operationId)),
    reviewInputs: evidence.reviewInputs,
  };
};

export const promptForAgentStep = (input: {
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
  readonly stepOutputContract: unknown;
  readonly workflowChangeRequestContract: unknown;
  readonly skills: readonly string[];
  readonly recovery: TaskStepRecoveryContext;
  readonly operatorGuidance: string | null;
  readonly evidence: TaskRunEvidence;
  readonly historyIndex: ReturnType<typeof runHistoryIndex>;
}): string => {
  const runEvidence = {
    acceptedPlan: input.evidence.acceptedPlan,
    completedSteps: input.evidence.completedSteps,
    reviewInputs: capEntries(input.evidence.reviewInputs, REVIEW_INPUTS_LIMIT),
  };
  return [
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
        stepOutputContract: input.stepOutputContract,
        workflowChangeRequestContract: input.workflowChangeRequestContract,
        preferredSkills: input.skills,
        activityRecovery: input.recovery,
        operatorGuidance: input.operatorGuidance,
        runEvidence,
        runHistoryIndex: input.historyIndex,
      },
      null,
      2,
    ),
    '',
    'Operate only inside the prepared worktree. Return one JSON object matching the provided schema.',
    'For a completed step, return {"status":"completed","output":{...}}. output must be a real JSON object matching stepOutputContract, never a JSON string.',
    'For a wait, return {"status":"waiting","waitKind":"...","reason":"...","resumeHint":"...","category":"...","retryable":true}. resumeHint is optional.',
    'For a terminal step failure, return {"status":"failed","category":"...","detail":"...","retryable":false}.',
    'For a workflow change, return {"status":"workflow_change","request":{...}}. request must be a real JSON object matching workflowChangeRequestContract and a declared workflowChanges kind, never a JSON string.',
    'category must be one of authorization, infrastructure, task_ambiguity, dependency, or agent_contract. Declare category and retryable directly; they are never inferred from prose.',
    'Do not encode infrastructure failures as workflow changes.',
    'runEvidence contains the bounded causal frontier; reviewInputs is capped to the most recent entries. runHistoryIndex lists the most recent prior attempts; older entries are counted, not listed. Full immutable receipt files are mounted for on-demand inspection.',
  ].join('\n');
};

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

export const executionOperationIdFor = (
  workflowId: string,
  workflowRunId: string,
  nodeId: string,
  attempt: number,
): string => `${workflowId}:${workflowRunId}:${nodeId}:attempt-${String(attempt)}`;

const executionOperationId = (input: ExecuteTaskStepInput): string =>
  executionOperationIdFor(input.workflowId, input.workflowRunId, input.nodeId, input.stepAttempt);

const persistAgentBlockedResult = (
  traces: TemporalTaskStepTraceStore,
  input: ExecuteTaskStepInput,
  recovery: TaskStepRecoveryContext,
  summary: string,
  waitKind: string,
  details: unknown,
  stdout: string,
  stderr: string,
  provider: AgentProvider,
  usage?: AgentInvocationUsage,
  artifactIds: readonly string[] = [],
  classification: {
    readonly category?: AgentClaimCategory;
    readonly retryable?: boolean;
  } = {},
): ExecuteTaskStepResult => {
  const result = block(
    summary,
    waitKind,
    withRecoveryArtifact(recovery, artifactIds),
    classification,
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
    ...(usage === undefined ? {} : { usage }),
    result,
  });
  if (!persisted.ok || persisted.value.result === null) {
    throw new Error(`Blocked execution receipt persistence failed for ${input.uses}`);
  }
  return persisted.value.result;
};

const persistAgentFailedResult = (
  traces: TemporalTaskStepTraceStore,
  input: ExecuteTaskStepInput,
  recovery: TaskStepRecoveryContext,
  summary: string,
  category: AgentClaimCategory,
  retryable: boolean,
  details: unknown,
  stdout: string,
  stderr: string,
  provider: AgentProvider,
  usage?: AgentInvocationUsage,
  artifactIds: readonly string[] = [],
): ExecuteTaskStepResult => {
  const result = fail(summary, category, retryable, withRecoveryArtifact(recovery, artifactIds));
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
    status: 'failed',
    stdout,
    stderr,
    details,
    ...(usage === undefined ? {} : { usage }),
    result,
  });
  if (!persisted.ok || persisted.value.result === null) {
    throw new Error(`Failed execution receipt persistence failed for ${input.uses}`);
  }
  return persisted.value.result;
};

export interface RegisteredTaskStepDependencies {
  readonly snapshots: Pick<ImplementationPlanningStore, 'readRunSnapshot'>;
  readonly currentSteps: ReadonlyMap<string, LoadedHarnessStep>;
  readonly traces: TemporalTaskStepTraceStore;
  readonly mutationRecovery: Pick<WorkspaceMutationRecoveryStore, 'prepare'>;
  readonly agentRunner: TaskStepAgentRunner;
  readonly commands: WorkspaceCommandRunner;
  readonly integrations?: IntegrationStepAdapterRegistry;
  readonly evidence?: TaskRunEvidenceSource;
  readonly workspaces: Pick<WorkspaceStore, 'read'>;
}

export interface TaskExecutionActivityDependencies extends Omit<
  RegisteredTaskStepDependencies,
  'mutationRecovery'
> {
  readonly mutationRecovery: Pick<WorkspaceMutationRecoveryStore, 'prepare' | 'inspectCompletion'>;
  readonly receipts: BlockReceiptStore;
  readonly runtimes: DockerWorkspaceRuntimePreparer;
}

export interface TaskRunEvidenceSource {
  read(
    taskReference: string,
    workflowId: string,
  ): Outcome<TaskRunEvidence, { readonly kind: string }>;
}

export class LedgerTaskRunEvidenceSource implements TaskRunEvidenceSource {
  public constructor(
    private readonly traces: TemporalTaskStepTraceStore,
    private readonly reviews?: {
      list(
        workflowId: string,
      ): Outcome<readonly PullRequestReviewEvidence[], { readonly kind: string }>;
    },
  ) {}

  public read(
    taskReference: string,
    workflowId: string,
  ): Outcome<TaskRunEvidence, { readonly kind: string }> {
    void taskReference;
    const completedSteps = this.traces.readRunStepEvidence(workflowId);
    if (!completedSteps.ok) return err({ kind: completedSteps.error.kind });
    const reviewInputs = this.reviews?.list(workflowId) ?? ok([]);
    if (!reviewInputs.ok) return err({ kind: reviewInputs.error.kind });
    return ok({
      acceptedPlan: null,
      completedSteps: completedSteps.value,
      reviewInputs: reviewInputs.value,
    });
  }
}

export const executeRegisteredTaskStep = async (
  inputValue: ExecuteTaskStepInput,
  dependencies: RegisteredTaskStepDependencies,
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
  const runEvidence =
    dependencies.evidence?.read(input.taskReference, input.workflowId) ??
    ok({ acceptedPlan: null, completedSteps: [], reviewInputs: [] });
  if (!runEvidence.ok) {
    return block(
      `Execution evidence for ${input.uses} is unavailable: ${runEvidence.error.kind}`,
      blockingWaitKindFor(input.uses),
    );
  }
  const evidence: TaskRunEvidence = {
    ...runEvidence.value,
    acceptedPlan: snapshot.kind === 'execution' ? snapshot.acceptedPlan : null,
  };
  const snapshottedStep = snapshottedStepFrom(snapshot, input.uses);
  if (snapshottedStep === null) {
    return block(
      `Execution binding ${input.uses} is absent from the immutable planning snapshot`,
      blockingWaitKindFor(input.uses),
    );
  }
  const current = dependencies.currentSteps.get(input.uses);
  if (
    current === undefined ||
    current.block.executor.kind !== snapshottedStep.block.executor.kind
  ) {
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

  if (snapshottedStep.block.executor.kind === 'effect') {
    if (
      current.block.executor.kind !== 'effect' ||
      current.block.executor.adapter !== snapshottedStep.block.executor.adapter
    ) {
      const artifactIds = persistBlockedArtifact(dependencies.traces, input, 'system', {
        kind: 'integration_binding_changed',
        snapshottedAdapter: snapshottedStep.block.executor.adapter,
      });
      return block(
        `Integration binding for ${input.uses} changed after planning`,
        blockingWaitKindFor(input.uses),
        artifactIds,
      );
    }
    const adapter = (dependencies.integrations ?? emptyIntegrationStepAdapterRegistry).get(
      snapshottedStep.block.executor.adapter,
    );
    if (adapter === undefined) {
      const artifactIds = persistBlockedArtifact(dependencies.traces, input, 'system', {
        kind: 'integration_adapter_unavailable',
        adapter: snapshottedStep.block.executor.adapter,
      });
      return block(
        `Integration adapter ${snapshottedStep.block.executor.adapter} is not configured`,
        blockingWaitKindFor(input.uses),
        artifactIds,
      );
    }
    runtime.heartbeat({
      phase: 'integration',
      adapter: snapshottedStep.block.executor.adapter,
      nodeId: input.nodeId,
    });
    const execution = await adapter.execute({
      operationId: executionOperationId(input),
      nodeId: input.nodeId,
      stepReference: input.uses,
      taskReference: input.taskReference,
      task: snapshot.task,
      taskSnapshot: snapshot.taskSnapshot,
      stepInput: JsonValueSchema.parse(validatedInput.data),
      workspace: input.workspace,
      operatorGuidance: input.operatorGuidance,
      waitResolution: input.waitResolution,
      evidence,
      policies: snapshot.harness.policies,
      project: snapshot.harness.project,
      trackerStatusUpdates: input.trackerStatusUpdates,
      runtime,
    });
    if (execution.status === 'continuation_required') {
      const declared = parseDeclaredWorkflowChangeRequest(
        execution.request,
        current.contract.workflowChanges,
      );
      if (!declared.ok) {
        const artifactIds = persistBlockedArtifact(dependencies.traces, input, 'integration', {
          kind: declared.error.kind,
          adapter: adapter.id,
        });
        return block(
          `Integration adapter ${adapter.id} returned an undeclared continuation request`,
          `${input.uses}.invalid_request@1`,
          [...execution.artifactIds, ...artifactIds],
        );
      }
      const result = ExecuteTaskStepResultSchema.parse({
        status: 'workflow_change_required',
        summary: execution.summary,
        request: declared.value,
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
        status: 'workflow_change_required',
        stdout: '',
        stderr: '',
        details: { request: declared.value },
        result,
      });
      if (!persisted.ok || persisted.value.result === null) {
        throw new Error(`Integration continuation receipt persistence failed for ${input.uses}`);
      }
      return persisted.value.result;
    }
    if (execution.status === 'blocked' || execution.status === 'waiting') {
      const result = block(
        execution.summary,
        execution.status === 'waiting' ? execution.waitKind : `${input.uses}.${execution.kind}@1`,
        execution.artifactIds,
        execution.status === 'waiting'
          ? { category: execution.category, retryable: execution.retryable }
          : {
              category: integrationBlockedCategory(execution.kind),
              retryable: execution.retryable ?? true,
            },
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
        details:
          execution.status === 'waiting'
            ? execution.details
            : { kind: execution.kind, details: execution.details },
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

  if (snapshottedStep.block.executor.kind === 'agent') {
    if (snapshottedStep.executionProfile === null) {
      return block(
        `Execution profile for ${input.uses} is absent from the immutable planning snapshot`,
        blockingWaitKindFor(input.uses),
      );
    }
    const executionProfile = snapshottedStep.executionProfile;
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
    const agentEvidence = selectAgentRunEvidence(evidence);
    const prompt = promptForAgentStep({
      snapshottedPrompt: snapshottedStep.block.executor.prompt,
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
      stepOutputContract: z.toJSONSchema(current.contract.outputSchema),
      workflowChangeRequestContract: z.toJSONSchema(WorkflowChangeRequestSchema),
      skills: snapshottedStep.block.executor.skills,
      recovery,
      operatorGuidance: input.operatorGuidance,
      evidence: agentEvidence,
      historyIndex: runHistoryIndex(evidence.completedSteps),
    });
    const outcomeSchema = agentStepOutcomeSchema(current.contract.outputSchema);
    const provider = await dependencies.agentRunner.run({
      taskReference: input.taskReference,
      inputArtifactIds: [
        ...agentEvidence.completedSteps.flatMap(({ artifactIds }) => artifactIds),
        ...evidence.completedSteps.map(({ operationId }) =>
          dependencies.traces.outputArtifactIdFor(operationId),
        ),
      ],
      operationId: executionOperationId(input),
      workflowId: input.workflowId,
      workflowRunId: input.workflowRunId,
      nodeId: input.nodeId,
      blockRun: input.stepAttempt,
      providerAttempt: runtime.attempt,
      stepReference: input.uses,
      profile: executionProfile,
      prompt,
      skills: snapshottedStep.block.executor.skills,
      recovery,
      outputSchema: outcomeSchema,
      cwd: input.workspace.path,
      workspaceAccess: current.contract.allowedEffects.includes('workspace.write')
        ? 'read_write'
        : 'read_only',
      runtime,
      transcriptStore: dependencies.traces,
    });
    if (!provider.ok) {
      if (provider.error.kind === 'invalid_output') {
        const detail = provider.error.issues
          .join('; ')
          .replace(/[ \t\r]+/gu, ' ')
          .slice(0, 4_000);
        return persistAgentFailedResult(
          dependencies.traces,
          input,
          recovery,
          `Agent execution for ${input.uses} returned an invalid outcome: ${detail}`,
          'agent_contract',
          false,
          { kind: 'agent_contract', issues: provider.error.issues },
          '',
          '',
          executionProfile.provider,
        );
      }
      const reason =
        'message' in provider.error
          ? provider.error.message
              .replace(/[ \t\r]+/gu, ' ')
              .trim()
              .slice(0, 4_000)
          : provider.error.kind;
      return persistAgentBlockedResult(
        dependencies.traces,
        input,
        recovery,
        `Agent execution for ${input.uses} is blocked: ${reason}`,
        blockingWaitKindFor(input.uses),
        provider.error,
        'stdout' in provider.error ? provider.error.stdout : '',
        'stderr' in provider.error ? provider.error.stderr : '',
        executionProfile.provider,
        undefined,
        [],
        { category: 'infrastructure', retryable: true },
      );
    }
    const decodedDecision = decodeAgentStepOutcome(
      provider.value.finalMessage,
      current.contract.outputSchema,
    );
    if (!decodedDecision.ok) {
      const detail = decodedDecision.error.issues
        .join('; ')
        .replace(/[ \t\r]+/gu, ' ')
        .slice(0, 4_000);
      return persistAgentFailedResult(
        dependencies.traces,
        input,
        recovery,
        `Agent execution for ${input.uses} returned an invalid outcome: ${detail}`,
        'agent_contract',
        false,
        { kind: 'agent_contract', issues: decodedDecision.error.issues },
        provider.value.stdout,
        provider.value.stderr,
        executionProfile.provider,
        provider.value.usage,
        provider.value.artifactIds,
      );
    }
    const decision = decodedDecision.value;
    if (decision.status === 'waiting') {
      return persistAgentBlockedResult(
        dependencies.traces,
        input,
        recovery,
        `Agent execution for ${input.uses} is blocked: ${decision.reason}`,
        decision.waitKind,
        {
          kind: 'agent_waiting',
          reason: decision.reason,
          ...(decision.resumeHint === undefined ? {} : { resumeHint: decision.resumeHint }),
          category: decision.category,
          retryable: decision.retryable,
        },
        provider.value.stdout,
        provider.value.stderr,
        executionProfile.provider,
        provider.value.usage,
        provider.value.artifactIds,
        { category: decision.category, retryable: decision.retryable },
      );
    }
    if (decision.status === 'failed') {
      return persistAgentFailedResult(
        dependencies.traces,
        input,
        recovery,
        `Agent execution for ${input.uses} failed: ${decision.detail}`,
        decision.category,
        decision.retryable,
        {
          kind: 'agent_failed',
          category: decision.category,
          detail: decision.detail,
          retryable: decision.retryable,
        },
        provider.value.stdout,
        provider.value.stderr,
        executionProfile.provider,
        provider.value.usage,
        provider.value.artifactIds,
      );
    }
    if (decision.status === 'workflow_change') {
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
          blockingWaitKindFor(input.uses),
          {
            kind: declared.error.kind,
            ...(declared.error.kind === 'invalid_request'
              ? { issues: declared.error.issues }
              : { changeKind: declared.error.changeKind }),
          },
          provider.value.stdout,
          provider.value.stderr,
          executionProfile.provider,
          provider.value.usage,
          provider.value.artifactIds,
          { category: 'agent_contract', retryable: false },
        );
      }
      const result = ExecuteTaskStepResultSchema.parse({
        status: 'workflow_change_required',
        summary: `Agent execution for ${input.uses} requested a workflow change`,
        request: declared.value,
        artifactIds: withRecoveryArtifact(recovery, provider.value.artifactIds),
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
        command: executionProfile.provider,
        args: [],
        cwd: input.workspace.path,
        exitCode: 0,
        status: 'workflow_change_required',
        stdout: provider.value.stdout,
        stderr: provider.value.stderr,
        details: { request: declared.value },
        usage: provider.value.usage,
        result,
      });
      if (!persisted.ok || persisted.value.result === null) {
        throw new Error(`Workflow change receipt persistence failed for ${input.uses}`);
      }
      return persisted.value.result;
    }
    const outputRecord = decision.output as {
      readonly summary?: string;
      readonly artifacts?: unknown;
    };
    const result = ExecuteTaskStepResultSchema.parse({
      status: 'completed',
      summary:
        typeof outputRecord.summary === 'string' && outputRecord.summary.trim().length > 0
          ? outputRecord.summary
          : `${input.uses} completed`,
      artifactIds: withRecoveryArtifact(recovery, provider.value.artifactIds),
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
      command: executionProfile.provider,
      args: [],
      cwd: input.workspace.path,
      exitCode: 0,
      status: 'completed',
      stdout: provider.value.stdout,
      stderr: provider.value.stderr,
      details: {
        output: decision.output,
        executionProfile: {
          provider: executionProfile.provider,
          profile: executionProfile.name,
          profileSha256: executionProfile.configurationSha256,
          model: executionProfile.model,
          effort: executionProfile.effort,
        },
      },
      usage: provider.value.usage,
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
  if (snapshottedStep.resolvedProcess === null) {
    const artifactIds = persistBlockedArtifact(dependencies.traces, input, 'system', {
      kind: 'process_command_missing',
    });
    return block(
      `Process command for ${input.uses} is absent from the immutable planning snapshot`,
      blockingWaitKindFor(input.uses),
      artifactIds,
    );
  }
  const processPlan = processExecutionPlanFor(snapshottedStep.resolvedProcess, validatedInput.data);
  if (processPlan === null) {
    const artifactIds = persistBlockedArtifact(dependencies.traces, input, 'system', {
      kind: 'process_profile_missing',
    });
    return block(
      `Process profile for ${input.uses} is absent from the immutable planning snapshot`,
      blockingWaitKindFor(input.uses),
      artifactIds,
    );
  }
  const acceptsAnyExit = acceptsAnyProcessExit(snapshottedStep.block.completion);
  const commandReceipts: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly exitCode: number;
  }> = [];
  let stdout = '';
  let stderr = '';
  let processResult: CommandResult | null = null;
  let failedCommand: (typeof processPlan.commands)[number] | null = null;
  for (const command of processPlan.commands) {
    runtime.heartbeat({ phase: 'process', nodeId: input.nodeId, command: command.command });
    const result = await dependencies.commands.run({
      command: command.command,
      args: command.args,
      cwd: input.workspace.path,
      stdin: '',
      timeoutMs: processPlan.timeoutMs,
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
    processResult = result;
    stdout += result.status === 'spawn_failed' ? '' : result.stdout;
    stderr += result.status === 'spawn_failed' ? result.message : result.stderr;
    if (result.status === 'exited') {
      commandReceipts.push({
        command: command.command,
        args: command.args,
        exitCode: result.exitCode,
      });
    }
    if (result.status !== 'exited' || result.exitCode !== 0) {
      failedCommand = command;
      break;
    }
  }
  if (processResult === null || failedCommand === null) {
    processResult ??= { status: 'spawn_failed', message: 'Process plan was empty', durationMs: 0 };
  }
  if (processResult.status !== 'exited' || (processResult.exitCode !== 0 && !acceptsAnyExit)) {
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
      failedCommand?.command ?? null,
      failedCommand?.args ?? [],
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
      stdout,
      stderr,
      failedCommand?.command ?? processPlan.commands[0]?.command ?? null,
      failedCommand?.args ?? processPlan.commands[0]?.args ?? [],
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
    command: processPlan.commands.map(({ command }) => command).join(' → '),
    args: [],
    cwd: input.workspace.path,
    exitCode: processResult.exitCode,
    status: 'completed',
    stdout,
    stderr,
    details: { output: processOutput.data, commands: commandReceipts },
  });
  return ExecuteTaskStepResultSchema.parse({
    status: 'completed',
    summary:
      processResult.exitCode === 0
        ? `${input.uses} passed`
        : `${input.uses} completed with exit code ${String(processResult.exitCode)}`,
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

const persistedOutput = (artifact: TaskStepOutputArtifact): JsonValue => {
  const details = artifact.details;
  return details !== null && !Array.isArray(details) && typeof details === 'object'
    ? JsonValueSchema.parse(details.output ?? {})
    : {};
};

const claimFromResult = (
  result: ExecuteTaskStepResult,
  outputArtifact: TaskStepOutputArtifact,
): AgentClaim => {
  const outputReference = `task-step-output:${outputArtifact.operationId}:artifact`;
  switch (result.status) {
    case 'completed':
      return AgentClaimSchema.parse({
        status: 'candidate_complete',
        summary: result.summary,
        output: persistedOutput(outputArtifact),
        evidenceReferences: [...new Set([outputReference, ...result.artifactIds])],
      });
    case 'blocked': {
      return AgentClaimSchema.parse({
        status: 'blocked',
        summary: result.summary,
        waitKind: result.waitKind,
        category: result.category,
        retryable: result.retryable,
      });
    }
    case 'failed':
      return AgentClaimSchema.parse({
        status: 'failed',
        summary: result.summary,
        category: result.category,
        retryable: result.retryable,
      });
    case 'workflow_change_required':
      return AgentClaimSchema.parse({
        status: 'continuation_required',
        summary: result.summary,
        requestReference: outputReference,
      });
  }
};

const appendEvidenceIssues = (
  verdict: CompletionVerdict,
  issues: readonly string[],
): CompletionVerdict =>
  issues.length === 0
    ? verdict
    : CompletionVerdictSchema.parse({
        status: 'rejected',
        reasons: [...(verdict.status === 'rejected' ? verdict.reasons : []), ...issues],
      });

const executionResultFromReceipt = (receipt: BlockReceipt) => {
  const verdict = receipt.verdict;
  if (verdict.status === 'waiting') {
    return {
      status: 'needs_input' as const,
      summary: verdict.summary,
      waitKind: verdict.waitKind,
    };
  }
  switch (receipt.claim.status) {
    case 'candidate_complete':
      return verdict.status === 'accepted'
        ? {
            status: 'completed' as const,
            summary: receipt.claim.summary,
            predicateFacts: receipt.predicateFacts,
            receiptReference: receipt.receiptId,
          }
        : {
            status: 'needs_input' as const,
            summary: `Completion evidence for ${receipt.blockReference} was rejected: ${verdict.reasons.join('; ')}`,
            waitKind: `${receipt.blockReference}.completion-evidence-required@1`,
          };
    case 'needs_input':
    case 'blocked':
      return {
        status: 'needs_input' as const,
        summary: receipt.claim.summary,
        waitKind: receipt.claim.waitKind,
      };
    case 'failed':
      return {
        status: 'needs_input' as const,
        summary: receipt.claim.summary,
        waitKind: `${receipt.blockReference}.failed@1`,
      };
    case 'continuation_required':
      return {
        status: 'continuation_required' as const,
        summary: receipt.claim.summary,
        waitKind: `${receipt.blockReference}.continuation-required@1`,
        requestReference: receipt.claim.requestReference,
        receiptReference: receipt.receiptId,
      };
  }
};

export const createTaskExecutionActivity = (
  dependencies: TaskExecutionActivityDependencies,
  runtimeFactory: () => TaskStepActivityContext = temporalRuntime,
): Pick<ExecutionWorkflowActivities, 'runExecutionBlock' | 'evaluateExecutionPredicate'> => ({
  runExecutionBlock: async (input: RunExecutionBlockInput) => {
    const workspaceReference = input.contextReferences.find(({ kind }) => kind === 'workspace');
    const planningReference = input.contextReferences.find(
      ({ kind }) => kind === 'planning_snapshot',
    );
    const trackerStatusUpdates = TrackerStatusUpdatesSchema.safeParse(
      input.contextReferences.find(({ kind }) => kind === 'tracker_status_updates')?.reference ??
        'enabled',
    );
    if (workspaceReference === undefined || planningReference?.hash === undefined) {
      return {
        status: 'needs_input',
        summary: `Execution context for ${input.uses} is incomplete`,
        waitKind: `${input.uses}.context-required@1`,
      };
    }
    if (!trackerStatusUpdates.success) {
      return {
        status: 'needs_input',
        summary: `Execution context for ${input.uses} has invalid Jira status settings`,
        waitKind: `${input.uses}.context-required@1`,
      };
    }
    const workspace = dependencies.workspaces.read(workspaceReference.reference);
    if (!workspace.ok || workspace.value === null) {
      return {
        status: 'needs_input',
        summary: `Prepared workspace for ${input.uses} is unavailable`,
        waitKind: `${input.uses}.workspace-required@1`,
      };
    }
    const preparedWorkspace = workspace.value;
    const snapshotReference = {
      artifactId: planningReference.reference,
      checksum: planningReference.hash,
    };
    const loadedSnapshot = dependencies.snapshots.readRunSnapshot(snapshotReference);
    if (!loadedSnapshot.ok) {
      return {
        status: 'needs_input',
        summary: `Execution snapshot for ${input.uses} is unavailable: ${loadedSnapshot.error.kind}`,
        waitKind: `${input.uses}.snapshot-required@1`,
      };
    }
    const snapshottedStep = snapshottedStepFrom(loadedSnapshot.value, input.uses);
    if (snapshottedStep === null) {
      return {
        status: 'needs_input',
        summary: `Block ${input.uses} is absent from the immutable execution snapshot`,
        waitKind: `${input.uses}.definition-required@1`,
      };
    }
    const receiptId = blockReceiptId({
      workflowId: input.workflowId,
      workflowRunId: input.workflowRunId,
      nodeId: input.nodeId,
      blockRun: input.blockRun,
    });
    const existingReceipt = dependencies.receipts.read(receiptId);
    if (!existingReceipt.ok) {
      return {
        status: 'needs_input',
        summary: `Block receipt ${receiptId} is unavailable: ${existingReceipt.error.kind}`,
        waitKind: `${input.uses}.receipt-recovery-required@1`,
      };
    }
    if (existingReceipt.value !== null) return executionResultFromReceipt(existingReceipt.value);

    const runtime = runtimeFactory();
    runtime.heartbeat({ phase: 'reconcile_docker_runtime' });
    const heartbeat = setInterval(() => {
      runtime.heartbeat({ phase: 'reconcile_docker_runtime' });
    }, 10_000);
    const preparedRuntime = await (async () => {
      try {
        return await dependencies.runtimes.prepare(
          preparedWorkspace,
          resolveWorkspaceRuntimePolicy(
            loadedSnapshot.value.harness.company,
            loadedSnapshot.value.harness.project,
          ),
          {
            cancellationSignal: runtime.cancellationSignal,
            onProgress: (progress) => {
              runtime.heartbeat({
                phase: `reconcile_docker_runtime:${progress.phase}`,
                ...(progress.detail === undefined ? {} : { detail: progress.detail }),
              });
            },
          },
        );
      } finally {
        clearInterval(heartbeat);
      }
    })();
    if (!preparedRuntime.ok) {
      return {
        status: 'needs_input',
        summary: `Docker runtime for ${input.uses} could not be restored: ${preparedRuntime.error.kind}: ${preparedRuntime.error.message}. Fix the runtime prerequisite and resume this step; completed workflow nodes and workspace changes are preserved.`,
        waitKind: 'workspace.runtime-recovery@1',
      };
    }

    const result = await executeRegisteredTaskStep(
      {
        taskReference: input.taskReference,
        workflowId: input.workflowId,
        workflowRunId: input.workflowRunId,
        workflowHash: input.workflowHash,
        nodeId: input.nodeId,
        stepAttempt: input.blockRun,
        uses: input.uses,
        activityDelivery: input.activityDelivery,
        workspace: preparedWorkspace,
        planningSnapshot: snapshotReference,
        trackerStatusUpdates: trackerStatusUpdates.data,
        operatorGuidance: input.operatorGuidance,
        waitResolution: input.waitResolution,
        input: input.input,
      },
      dependencies,
      runtime,
    );
    const operationId = executionOperationIdFor(
      input.workflowId,
      input.workflowRunId,
      input.nodeId,
      input.blockRun,
    );
    const outputArtifact = dependencies.traces.readOutputArtifact(operationId);
    if (outputArtifact.ok && outputArtifact.value === null && result.status === 'blocked') {
      return {
        status: 'needs_input',
        summary: result.summary,
        waitKind: result.waitKind,
      };
    }
    if (!outputArtifact.ok || outputArtifact.value === null) {
      return {
        status: 'needs_input',
        summary: `Candidate output for ${input.uses} was not durably persisted`,
        waitKind: `${input.uses}.receipt-persistence-required@1`,
      };
    }
    const claim = claimFromResult(result, outputArtifact.value);
    const collection =
      claim.status === 'candidate_complete'
        ? await collectBlockCompletionEvidence(
            {
              operationId,
              block: snapshottedStep.block,
              workspace: preparedWorkspace,
              outputArtifact: outputArtifact.value,
            },
            dependencies,
          )
        : { evidence: [], issues: [] };
    const verdict = appendEvidenceIssues(
      evaluateBlockCompletion(snapshottedStep.block.completion, claim, collection.evidence),
      collection.issues,
    );
    const predicateFacts =
      claim.status === 'candidate_complete' && verdict.status === 'accepted'
        ? resolveOutputPredicateFacts(snapshottedStep.block.outputPredicates, claim.output)
        : {};
    const recorded = dependencies.receipts.record({
      block: snapshottedStep.block,
      taskReference: input.taskReference,
      workflowId: input.workflowId,
      workflowRunId: input.workflowRunId,
      workflowHash: input.workflowHash,
      nodeId: input.nodeId,
      blockRun: input.blockRun,
      claim,
      verdict,
      predicateFacts,
      evidence: collection.evidence,
      transcriptReference: result.transcriptId,
      usageReference:
        outputArtifact.value.usage === null
          ? null
          : dependencies.traces.outputArtifactIdFor(operationId),
      usage: outputArtifact.value.usage,
    });
    return recorded.ok
      ? executionResultFromReceipt(recorded.value)
      : {
          status: 'needs_input',
          summary: `Block receipt for ${input.uses} could not be persisted: ${recorded.error.kind}`,
          waitKind: `${input.uses}.receipt-persistence-required@1`,
        };
  },
  evaluateExecutionPredicate: (input) => Promise.resolve(input.facts[input.reference] ?? false),
});

export const createCurrentStepRegistry = (
  pack: LoadedHarnessPack,
): ReadonlyMap<string, LoadedHarnessStep> => registryFrom(pack);

export type { ImplementationPlanningStoreError };
