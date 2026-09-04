import type { LoadedHarnessStep } from '../../harness/index.js';
import type { RunPlanningSnapshot } from '../../planning/run-planning-snapshot.js';

import { acceptsAnyProcessExit } from '../../steps/index.js';

import { processExecutionPlanFor } from '../../harness/index.js';

import { planningTranscriptIdFor } from '../../server/planning-transcript.js';

import type { CommandResult, WorkspaceCommandRunner } from '../../agents/command-runner.js';

import {
  ExecuteTaskStepResultSchema,
  type ExecuteTaskStepInput,
  type ExecuteTaskStepResult,
} from './block-execution-contracts.js';

import type { TaskStepActivityContext } from './agent-runner.js';

import {
  block,
  blockingWaitKindFor,
  executionOperationId,
  persistBlockedArtifact,
  readRepositoryFromInput,
} from './claims.js';

import type { TemporalTaskStepTraceStore } from './transcript-store.js';

export interface ProcessStepDependencies {
  readonly traces: TemporalTaskStepTraceStore;

  readonly commands: WorkspaceCommandRunner;
}

export const runProcessStep = async (
  input: ExecuteTaskStepInput,

  dependencies: ProcessStepDependencies,

  runtime: TaskStepActivityContext,

  snapshotRepositoryReference: string,

  snapshottedStep: RunPlanningSnapshot['harness']['steps'][number],

  current: LoadedHarnessStep,

  validatedInput: unknown,
): Promise<ExecuteTaskStepResult> => {
  const inputRepository = readRepositoryFromInput(validatedInput);
  if (inputRepository !== null && inputRepository !== snapshotRepositoryReference) {
    const artifactIds = persistBlockedArtifact(dependencies.traces, input, 'system', {
      kind: 'cross_repository_not_supported',
      requestedRepository: inputRepository,
      preparedRepository: snapshotRepositoryReference,
    });
    return block(
      `Process step ${input.uses} targets ${inputRepository} but this run prepared ${snapshotRepositoryReference}`,
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
  const processPlan = processExecutionPlanFor(snapshottedStep.resolvedProcess, validatedInput);
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
          input.taskReference,
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
    taskReference: input.taskReference,
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
