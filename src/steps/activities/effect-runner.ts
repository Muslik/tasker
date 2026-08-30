import type { LoadedHarnessStep } from '../../harness/index.js';

import {
  emptyIntegrationStepAdapterRegistry,
  type IntegrationStepAdapterRegistry,
  type TaskRunEvidence,
} from '../../integrations/index.js';

import type { RunPlanningSnapshot } from '../../planning/run-planning-snapshot.js';
import type { z } from 'zod';

import { JsonValueSchema } from '../../graph/schema.js';

import { parseDeclaredWorkflowChangeRequest } from '../../graph/index.js';

import { ExecuteTaskStepResultSchema } from './block-execution-contracts.js';
import type { ExecuteTaskStepInputSchema } from './block-execution-contracts.js';
import type { ExecuteTaskStepResult } from './block-execution-contracts.js';

import type { TaskStepActivityContext } from './agent-runner.js';

import {
  block,
  blockingWaitKindFor,
  executionOperationId,
  integrationBlockedCategory,
  persistBlockedArtifact,
} from './claims.js';

import type { TemporalTaskStepTraceStore } from './transcript-store.js';

export interface EffectStepDependencies {
  readonly traces: TemporalTaskStepTraceStore;

  readonly integrations?: IntegrationStepAdapterRegistry;
}

export const runEffectStep = async (
  input: z.output<typeof ExecuteTaskStepInputSchema>,

  dependencies: EffectStepDependencies,

  runtime: TaskStepActivityContext,

  snapshot: RunPlanningSnapshot,

  snapshottedStep: RunPlanningSnapshot['harness']['steps'][number] & {
    readonly block: {
      readonly executor: Extract<
        RunPlanningSnapshot['harness']['steps'][number]['block']['executor'],
        { readonly kind: 'effect' }
      >;
    };
  },

  current: LoadedHarnessStep,

  evidence: TaskRunEvidence,
  validatedInput: unknown,
): Promise<ExecuteTaskStepResult> => {
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
    stepInput: JsonValueSchema.parse(validatedInput),
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
      taskReference: input.taskReference,
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
      taskReference: input.taskReference,
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
    taskReference: input.taskReference,
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
};
