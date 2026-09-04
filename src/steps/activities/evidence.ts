import { Context } from '@temporalio/activity';

import type { RunPlanningSnapshot } from '../../planning/run-planning-snapshot.js';

import {
  blockReceiptId,
  evaluateBlockCompletion,
  type BlockReceiptStore,
} from '../../steps/index.js';

import type {
  ExecutionWorkflowActivities,
  RunExecutionBlockInput,
} from '../../kernel/execution-kernel/contracts.js';

import type { DockerWorkspaceRuntimePreparer } from '../../workspace/docker-runtime-manager.js';

import { resolveWorkspaceRuntimePolicy } from '../../workspace/runtime-policy.js';

import { resolveOutputPredicateFacts } from '../../graph/index.js';

import { TrackerStatusUpdatesSchema } from '../../shared/task-run-settings.js';

import { collectBlockCompletionEvidence } from './block-completion-evidence.js';

import {
  appendEvidenceIssues,
  claimFromResult,
  executionOperationIdFor,
  executionResultFromReceipt,
} from './claims.js';

import { executeRegisteredTaskStep, type RegisteredTaskStepDependencies } from './run-block.js';

import type { TaskStepActivityContext } from './agent-runner.js';

import type { WorkspaceMutationRecoveryStore } from './workspace-mutation-recovery.js';
import type { RepositoryCatalog } from '../../workspace/catalog.js';
import type { LinkedRepositoryMount } from './agent-runner.js';

const isResearchExecution = (snapshot: RunPlanningSnapshot): boolean =>
  snapshot.kind === 'execution' && snapshot.semanticSource.id.startsWith('research-');

const linkedRepositoryMountsFor = async (
  snapshot: RunPlanningSnapshot,
  repositories: RepositoryCatalog | undefined,
): Promise<
  | { readonly status: 'ready'; readonly mounts: readonly LinkedRepositoryMount[] }
  | { readonly status: 'blocked'; readonly summary: string }
> => {
  if (!isResearchExecution(snapshot)) return { status: 'ready', mounts: [] };
  const jiraProjectKey = (snapshot.task.taskId.split('-')[0] ?? '').toUpperCase();
  const product = snapshot.harness.products.find(({ jiraProjects }) =>
    jiraProjects.includes(jiraProjectKey),
  );
  if (product === undefined || product.repositories.linked.length === 0) {
    return { status: 'ready', mounts: [] };
  }
  if (repositories === undefined) {
    return {
      status: 'blocked',
      summary: 'Research execution requires the managed repository catalog for linked repositories',
    };
  }
  const mounts: LinkedRepositoryMount[] = [];
  for (const reference of product.repositories.linked) {
    const resolved = await repositories.resolve(reference);
    if (resolved.status !== 'found') {
      return {
        status: 'blocked',
        summary: `Linked research repository ${reference} is unavailable: ${resolved.status}`,
      };
    }
    mounts.push({
      repository: resolved.repository.repositoryId,
      source: resolved.repository.checkout.path,
      target: `/workspace-linked/${resolved.repository.repositoryId}`,
    });
  }
  return { status: 'ready', mounts };
};

const snapshottedStepFrom = (
  snapshot: RunPlanningSnapshot,
  stepReference: string,
): (typeof snapshot.harness.steps)[number] | null =>
  snapshot.harness.steps.find((step) => step.reference === stepReference) ?? null;

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

export interface TaskExecutionActivityDependencies extends Omit<
  RegisteredTaskStepDependencies,
  'mutationRecovery'
> {
  readonly mutationRecovery: Pick<WorkspaceMutationRecoveryStore, 'prepare' | 'inspectCompletion'>;

  readonly receipts: BlockReceiptStore;

  readonly runtimes: DockerWorkspaceRuntimePreparer;
  readonly repositories?: RepositoryCatalog;
}

export const createTaskExecutionActivity = (
  dependencies: TaskExecutionActivityDependencies,
  runtimeFactory: () => TaskStepActivityContext = temporalRuntime,
): Pick<ExecutionWorkflowActivities, 'runExecutionBlock'> => ({
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
    const linked =
      snapshottedStep.block.executor.kind === 'agent'
        ? await linkedRepositoryMountsFor(loadedSnapshot.value, dependencies.repositories)
        : { status: 'ready' as const, mounts: [] as const };
    if (linked.status === 'blocked') {
      return {
        status: 'needs_input',
        summary: linked.summary,
        waitKind: `${input.uses}.linked-repository-required@1`,
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
      linked.mounts,
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
});
