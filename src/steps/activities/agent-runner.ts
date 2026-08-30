import { z } from 'zod';

import type { LoadedHarnessStep, ResolvedExecutionProfile } from '../../harness/index.js';
import type { TaskRunEvidence } from '../../integrations/index.js';
import type { RunPlanningSnapshot } from '../../planning/run-planning-snapshot.js';
import {
  WorkflowChangeRequestSchema,
  parseDeclaredWorkflowChangeRequest,
} from '../../graph/index.js';
import type { AgentInvocationUsage } from '../../steps/agent-usage.js';
import type { Outcome } from '../../shared/outcome.js';
import {
  ExecuteTaskStepResultSchema,
  agentStepOutcomeSchema,
  type ExecuteTaskStepResult,
} from './block-execution-contracts.js';
import type { ExecuteTaskStepInputSchema } from './block-execution-contracts.js';
import { promptForAgentStep, runHistoryIndex, selectAgentRunEvidence } from './agent-prompt.js';
import {
  block,
  blockingWaitKindFor,
  executionOperationId,
  persistAgentBlockedResult,
  persistAgentFailedResult,
  persistBlockedArtifact,
  readRepositoryFromInput,
  withRecoveryArtifact,
} from './claims.js';
import { decodeAgentStepOutcome } from './envelope.js';
import type { TemporalTaskStepTraceStore } from './transcript-store.js';
import {
  TaskStepRecoveryContextSchema,
  type TaskStepRecoveryContext,
  type WorkspaceMutationRecoveryStore,
} from './workspace-mutation-recovery.js';

type SnapshottedAgentStep = RunPlanningSnapshot['harness']['steps'][number] & {
  readonly block: {
    readonly executor: Extract<
      RunPlanningSnapshot['harness']['steps'][number]['block']['executor'],
      { readonly kind: 'agent' }
    >;
  };
};

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

export interface AgentStepDependencies {
  readonly traces: TemporalTaskStepTraceStore;
  readonly agentRunner: TaskStepAgentRunner;
  readonly mutationRecovery: Pick<WorkspaceMutationRecoveryStore, 'prepare'>;
}

export const runAgentStep = async (
  input: z.output<typeof ExecuteTaskStepInputSchema>,
  dependencies: AgentStepDependencies,
  runtime: TaskStepActivityContext,
  snapshot: RunPlanningSnapshot,
  snapshottedStep: SnapshottedAgentStep,
  current: LoadedHarnessStep,
  evidence: TaskRunEvidence,
  validatedInput: unknown,
): Promise<ExecuteTaskStepResult> => {
  if (snapshottedStep.executionProfile === null) {
    return block(
      `Execution profile for ${input.uses} is absent from the immutable planning snapshot`,
      blockingWaitKindFor(input.uses),
    );
  }
  const executionProfile = snapshottedStep.executionProfile;
  const repository = readRepositoryFromInput(validatedInput);
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
    stepInput: validatedInput,
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
      taskReference: input.taskReference,
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
    taskReference: input.taskReference,
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
};
