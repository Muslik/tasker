import type { LoadedHarnessPack, LoadedHarnessStep } from '../../harness/index.js';
import type { RunPlanningSnapshot } from '../../planning/run-planning-snapshot.js';
import type { PullRequestReviewEvidence, TaskRunEvidence } from '../../integrations/index.js';
import type { WorkspaceStore } from '../../workspace/store.js';
import type { WorkspaceCommandRunner } from '../../agents/command-runner.js';
import type { IntegrationStepAdapterRegistry } from '../../integrations/index.js';
import type { ImplementationPlanningStore } from '../../server/planning-episodes.js';
import { err, ok, type Outcome } from '../../shared/outcome.js';
import {
  ExecuteTaskStepInputSchema,
  type ExecuteTaskStepInput,
  type ExecuteTaskStepResult,
} from './block-execution-contracts.js';
import {
  type TaskStepActivityContext,
  type TaskStepAgentRunner,
  type LinkedRepositoryMount,
  runAgentStep,
} from './agent-runner.js';
import {
  block,
  blockingWaitKindFor,
  executionOperationId,
  persistBlockedArtifact,
} from './claims.js';
import { runEffectStep } from './effect-runner.js';
import { runProcessStep } from './process-runner.js';
import type { TemporalTaskStepTraceStore } from './transcript-store.js';
import type { WorkspaceMutationRecoveryStore } from './workspace-mutation-recovery.js';

const snapshottedStepFrom = (
  snapshot: RunPlanningSnapshot,
  stepReference: string,
): (typeof snapshot.harness.steps)[number] | null =>
  snapshot.harness.steps.find((step) => step.reference === stepReference) ?? null;

const registryFrom = (pack: LoadedHarnessPack): ReadonlyMap<string, LoadedHarnessStep> =>
  new Map(pack.steps.map((step) => [step.reference, step] as const));

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
    const completedSteps = this.traces.readRunStepEvidence(taskReference, workflowId);
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
  linkedRepositories: readonly LinkedRepositoryMount[] = [],
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
    return runEffectStep(
      input,
      {
        traces: dependencies.traces,
        ...(dependencies.integrations === undefined
          ? {}
          : { integrations: dependencies.integrations }),
      },
      runtime,
      snapshot,
      snapshottedStep as Parameters<typeof runEffectStep>[4],
      current,
      evidence,
      validatedInput.data,
    );
  }

  if (snapshottedStep.block.executor.kind === 'agent') {
    return runAgentStep(
      input,
      {
        traces: dependencies.traces,
        agentRunner: dependencies.agentRunner,
        mutationRecovery: dependencies.mutationRecovery,
      },
      runtime,
      snapshot,
      snapshottedStep as Parameters<typeof runAgentStep>[4],
      current,
      evidence,
      validatedInput.data,
      linkedRepositories,
    );
  }

  return runProcessStep(
    input,
    { traces: dependencies.traces, commands: dependencies.commands },
    runtime,
    snapshot.repository.reference,
    snapshottedStep,
    current,
    validatedInput.data,
  );
};

export const createCurrentStepRegistry = (
  pack: LoadedHarnessPack,
): ReadonlyMap<string, LoadedHarnessStep> => registryFrom(pack);
