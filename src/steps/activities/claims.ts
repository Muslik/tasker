import {
  AgentClaimSchema,
  CompletionVerdictSchema,
  type AgentClaim,
  type AgentClaimCategory,
  type BlockReceipt,
  type CompletionVerdict,
} from '../../steps/index.js';
import type { AgentProvider } from '../../agents/agent-skills.js';
import { JsonValueSchema, type JsonValue } from '../../graph/schema.js';
import type { AgentInvocationUsage } from '../../steps/agent-usage.js';
import type { TaskStepOutputArtifact } from '../task-step-output.js';
import { ExecuteTaskStepResultSchema } from './block-execution-contracts.js';
import type { ExecuteTaskStepInput, ExecuteTaskStepResult } from './block-execution-contracts.js';
import type { TaskStepRecoveryContext } from './workspace-mutation-recovery.js';
import type { TemporalTaskStepTraceStore } from './transcript-store.js';

export const block = (
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

export const integrationBlockedCategory = (
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

export const withRecoveryArtifact = (
  recovery: TaskStepRecoveryContext,
  artifactIds: readonly string[],
): readonly string[] =>
  recovery.kind === 'single_attempt' ? artifactIds : [recovery.intentArtifactId, ...artifactIds];

export const blockingWaitKindFor = (stepReference: string): string =>
  `${stepReference.replace(/@/gu, '.').replace(/[^a-zA-Z0-9_.-]/gu, '-')}.blocked@1`;

export const readRepositoryFromInput = (value: unknown): string | null =>
  typeof value === 'object' &&
  value !== null &&
  'repository' in value &&
  typeof (value as { readonly repository?: unknown }).repository === 'string'
    ? (value as { readonly repository: string }).repository
    : null;

export const executionOperationIdFor = (
  workflowId: string,
  workflowRunId: string,
  nodeId: string,
  attempt: number,
): string => `${workflowId}:${workflowRunId}:${nodeId}:attempt-${String(attempt)}`;

export const executionOperationId = (input: ExecuteTaskStepInput): string =>
  executionOperationIdFor(input.workflowId, input.workflowRunId, input.nodeId, input.stepAttempt);

export const persistBlockedArtifact = (
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
    taskReference: input.taskReference,
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

export const persistAgentBlockedResult = (
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
    taskReference: input.taskReference,
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

export const persistAgentFailedResult = (
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
    taskReference: input.taskReference,
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

const persistedOutput = (artifact: TaskStepOutputArtifact): JsonValue => {
  const details = artifact.details;
  return details !== null && !Array.isArray(details) && typeof details === 'object'
    ? JsonValueSchema.parse(details.output ?? {})
    : {};
};

export const claimFromResult = (
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
    case 'blocked':
      return AgentClaimSchema.parse({
        status: 'blocked',
        summary: result.summary,
        waitKind: result.waitKind,
        category: result.category,
        retryable: result.retryable,
      });
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

export const appendEvidenceIssues = (
  verdict: CompletionVerdict,
  issues: readonly string[],
): CompletionVerdict =>
  issues.length === 0
    ? verdict
    : CompletionVerdictSchema.parse({
        status: 'rejected',
        reasons: [...(verdict.status === 'rejected' ? verdict.reasons : []), ...issues],
      });

export const executionResultFromReceipt = (receipt: BlockReceipt) => {
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
