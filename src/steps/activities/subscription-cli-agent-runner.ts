import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { basename, join } from 'node:path';

import { z } from 'zod';

import {
  codexOutputJsonSchema,
  normalizeCodexStructuredOutput,
  prepareIsolatedCodexHome,
  providerFailureMessage,
} from '../../agents/codex-cli-support.js';

import { prepareIsolatedClaudeHome } from '../../agents/claude-cli-support.js';

import { parseSubscriptionCliStream } from '../../agents/subscription-cli-stream.js';

import { prepareAgentSkills, workspaceHarnessEnvironment } from '../../agents/agent-skills.js';

import { estimateApiCost } from '../../agents/api-cost.js';

import type {
  CommandMount,
  CommandRequest,
  CommandResult,
  WorkspaceCommandRunner,
} from '../../agents/command-runner.js';

import {
  AgentInvocationReferencesSchema,
  executionAgentInvocationId,
  type AgentInvocationArtifact,
  type AgentInvocationRecorder,
  type AgentInvocationReferences,
} from '../../steps/agent-invocation.js';

import type { AgentInvocationUsage } from '../../steps/agent-usage.js';

import { err, ok, type Outcome } from '../../shared/outcome.js';

import { blockReceiptId } from '../../steps/index.js';

import type {
  TaskStepAgentFailure,
  TaskStepAgentRequest,
  TaskStepAgentResult,
  TaskStepAgentRunner,
} from './agent-runner.js';

import type { TaskStepEvidenceStore } from './task-step-evidence.js';

import { normalizeTaskStepEvidencePaths } from './task-step-evidence.js';

import type { TaskStepFilesystemStore } from './task-step-filesystem.js';

const removeWorkspaceScratchMountPoint = async (path: string): Promise<void> => {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EACCES') return;
    throw error;
  }
};

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
