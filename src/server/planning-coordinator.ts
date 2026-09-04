import { z } from 'zod';

import {
  applyHarnessPolicySkills,
  harnessPolicyAppliesToTask,
  loadHarnessPack,
  resolveHarnessProductByJiraProject,
  VALIDATION_PROCESS_COMMAND_REFERENCES,
  ValidationProcessExecutionPlansSchema,
  validationProcessCommandReference,
  resolveAgentExecutionProfile,
  resolveImplementationPlannerProfile,
  resolveTaskExecutionProfile,
} from '../harness/index.js';
import type {
  LoadedHarnessPack,
  LoadedHarnessProduct,
  LoadedPrompt,
  ProcessExecutionBinding,
  ValidationProcessCommandReference,
} from '../harness/index.js';
import type { JsonValue } from '../store/types.js';
import type { LedgerRepository } from '../store/repository.js';
import { checksumString } from '../store/checksum.js';
import {
  ImplementationPlanLinkSchema,
  PlanningClarificationAnswerCommandSchema,
  validateAcceptanceVerificationLinks,
  type PlanningQuestionAnswer,
  type PlanningStrategy,
  type PlanningStrategyRequest,
  type ImplementationPlanLink,
  type ReadyImplementationPlanningDecision,
} from '../planning/implementation-plan.js';
import type { TaskExecutionStrategy } from '../harness/execution-profile-contracts.js';
import type {
  EvidenceBundleReference,
  PlanningEvidenceCapture,
  WorkflowGenerationSubject,
  WorkflowGenerationSubjectSource,
} from '../planning/index.js';
import type {
  ExecutionRunSnapshot,
  PlanningContextSnapshot,
  PlanningSnapshotReference,
  PlanningSnapshotWorkspace,
  RunPlanningSnapshot,
} from '../planning/run-planning-snapshot.js';
import {
  ExecutionRunSnapshotSchema,
  PlanningContextSnapshotSchema,
} from '../planning/run-planning-snapshot.js';
import type {
  ImplementationPlanner,
  ImplementationPlannerDecisionSuccess,
  ImplementationPlannerFailure,
} from '../agents/implementation-planner.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  RESEARCH_STEP_REFERENCES,
  resolveDeliverPrScaffoldConfig,
  scaffoldResearch,
  scaffoldDeliverPr,
  VALIDATION_PROFILES,
  VALIDATION_RUN_STEP_REFERENCE,
} from '../graph/index.js';
import { CompiledWorkflowSchema, JsonValueSchema } from '../graph/schema.js';
import { SemanticWorkflowSourceSchema } from '../graph/semantic-schema.js';
import type {
  OperatorActivityResponse,
  OperatorStreamEvent,
  OperatorTaskSummary,
} from './operator-contracts.js';
import {
  ImplementationPlanningStore,
  type ImplementationPlanningRecord,
  type ImplementationPlanningStoreError,
  type ReadyImplementationPlanningRecord,
} from './planning-episodes.js';
import {
  listImplementationPlanningStreamEventsAfter,
  readImplementationPlanningActivity,
} from './planning-streams.js';
import {
  PlanningTranscriptStore,
  type PlanningTranscriptStoreError,
  type PlanningTranscriptView,
} from './planning-transcript.js';
import type { OperatorServiceError, OperatorWorkflowService } from './operator-service.js';
import { EvidenceBundleStore, type EvidenceBundleStoreError } from './evidence-bundle.js';
import type {
  PlanningEvidenceReaderRegistry,
  PlanningEvidenceReadError,
} from './planning-evidence.js';

export {
  IMPLEMENTATION_PLAN_PROJECTION,
  ImplementationPlanningRecordSchema,
} from './planning-episodes.js';
export type {
  ImplementationPlanningRecord,
  ReadyImplementationPlanningRecord,
  ImplementationPlanningStoreError,
} from './planning-episodes.js';

export type ImplementationPlanningError =
  | { readonly kind: 'subject'; readonly error: OperatorServiceError }
  | { readonly kind: 'workflow_not_ready'; readonly taskReference: string }
  | {
      readonly kind: 'workspace_repository_mismatch';
      readonly taskReference: string;
      readonly expectedReference: string;
      readonly actualReference: string;
    }
  | {
      readonly kind: 'workflow_snapshot_mismatch';
      readonly taskReference: string;
      readonly expectedHash: string;
      readonly actualHash: string | null;
    }
  | {
      readonly kind: 'invalid_clarification_answers';
      readonly taskReference: string;
      readonly issues: readonly string[];
    }
  | { readonly kind: 'transcript'; readonly error: PlanningTranscriptStoreError }
  | { readonly kind: 'evidence_bundle'; readonly error: EvidenceBundleStoreError }
  | { readonly kind: 'evidence_bundle_missing'; readonly taskReference: string }
  | { readonly kind: 'evidence_read'; readonly error: PlanningEvidenceReadError }
  | { readonly kind: 'store'; readonly error: ImplementationPlanningStoreError };

const MAX_PLANNING_EVIDENCE_ROUNDS = 3;

const planningInvocationNumberFor = (
  planning: Extract<ImplementationPlanningRecord, { readonly status: 'planning' }>,
  nextPersistedInvocationNumber: number,
): number =>
  Math.max(
    planning.evidenceRounds.length + planning.validationRevision + 1,
    nextPersistedInvocationNumber,
  );

const planningOutputReferencesFor = (
  planning: Extract<ImplementationPlanningRecord, { readonly status: 'planning' }>,
) => {
  const attemptId = `implementation-plan:${planning.planningEpisodeId}:attempt-${String(planning.attempt)}`;
  const nextEvidenceRound = planning.evidenceRounds.length + 1;
  return {
    completedArtifactId: attemptId,
    validatedCandidateArtifactId: `${attemptId}:validated-candidate`,
    evidenceRequestArtifactId: `${attemptId}:evidence-round-${String(nextEvidenceRound)}`,
    failedArtifactId: `${attemptId}:failed-provider-output`,
    receiptArtifactId: null,
  };
};

const plannerFailureReceipt = (
  failure: ImplementationPlannerFailure,
): ImplementationPlannerDecisionSuccess['receipt'] | null =>
  failure.kind === 'invalid_planner_output' ? (failure.receipt ?? null) : null;

const snapshotPrompt = (prompt: LoadedPrompt) => ({
  relativePath: prompt.relativePath,
  content: prompt.content,
  contentSha256: prompt.contentSha256,
});

const resolveSnapshottedProcess = (
  executor: string,
  pack: LoadedHarnessPack,
  project: LoadedHarnessPack['projects'][number] | undefined,
): ProcessExecutionBinding | null => {
  if (executor === VALIDATION_RUN_STEP_REFERENCE) {
    if (project === undefined) return null;
    const profiles = ValidationProcessExecutionPlansSchema.safeParse(
      Object.fromEntries(
        VALIDATION_PROFILES.map((profile) => [
          profile,
          project.processCommands[validationProcessCommandReference(profile)],
        ]),
      ),
    );
    return profiles.success ? { kind: 'validation', profiles: profiles.data } : null;
  }
  const plan = project?.processCommands[executor] ?? pack.company.processCommands[executor];
  return plan === undefined ? null : { kind: 'fixed', plan };
};

const snapshotHarness = (
  pack: LoadedHarnessPack,
  repositoryReference: string,
  workflowGraph: JsonValue | null,
  task: WorkflowGenerationSubject['task'],
) => {
  const implementationPlannerSkills = pack.company.systemPrompts.implementationPlannerSkills;
  const project = pack.projects.find((candidate) => candidate.repository === repositoryReference);
  const profileOverrides = project?.executionProfileOverrides ?? null;
  const policies = pack.policies.filter((policy) => harnessPolicyAppliesToTask(policy, task));
  const referencedSteps =
    workflowGraph === null
      ? null
      : new Set(CompiledWorkflowSchema.parse(workflowGraph).metadata.references.stepTypes);
  const steps = pack.steps
    .filter((step) => referencedSteps === null || referencedSteps.has(step.reference))
    .filter(
      (step) =>
        step.block.availableDuring.includes('execution') ||
        step.block.availableDuring.includes('bootstrap_investigation'),
    )
    .filter(
      (step) =>
        step.block.executor.kind !== 'process' ||
        step.block.executor.executor === VALIDATION_RUN_STEP_REFERENCE ||
        resolveSnapshottedProcess(step.block.executor.executor, pack, project) !== null,
    )
    .map((step) => {
      const block = applyHarnessPolicySkills(step.block, step.reference, policies);
      return {
        reference: step.reference,
        block,
        activityDelivery: step.contract.activityDelivery,
        resolvedProcess:
          step.block.executor.kind === 'process'
            ? resolveSnapshottedProcess(step.block.executor.executor, pack, project)
            : null,
        executionProfile:
          block.executor.kind === 'agent'
            ? resolveAgentExecutionProfile(pack.company, profileOverrides, block.executor.profile)
            : null,
      };
    });
  return {
    company: pack.company,
    project: project ?? null,
    products: snapshottedProducts(pack),
    implementationPlanner: {
      prompt: snapshotPrompt(pack.prompts.implementationPlanner),
      skills: implementationPlannerSkills,
      profiles: {
        fast: resolveImplementationPlannerProfile(pack.company, profileOverrides, 'fast'),
        ralplan: resolveImplementationPlannerProfile(pack.company, profileOverrides, 'ralplan'),
      },
    },
    policies,
    steps,
  };
};

const selectStrategy = (
  requested: PlanningStrategyRequest,
): { readonly strategy: PlanningStrategy; readonly reason: string } => {
  if (requested !== 'auto') {
    return { strategy: requested, reason: `The operator explicitly selected ${requested}.` };
  }
  return {
    strategy: 'fast',
    reason:
      'No operator override requested consensus planning; the planner may still propose a durable continuation when investigation discovers another repository.',
  };
};

const internalScaffoldInvariant = (archetype: string): string => `${archetype} scaffold`;

const throwInternalScaffoldInvariant = (invariant: string, detail: string): never => {
  throw new Error(`Internal ${invariant} invariant violated: ${detail}`);
};

const requireInvariantValue = <T>(
  value: T | null | undefined,
  invariant: string,
  detail: string,
): T => value ?? throwInternalScaffoldInvariant(invariant, detail);

const isSegmentSchemaFeedback = (issues: readonly string[]): boolean =>
  issues.length > 0 && issues.every((issue) => /^decision\.segments(?:\.|:|$)/u.test(issue));

const isResearchProductSchemaFeedback = (issues: readonly string[]): boolean =>
  issues.length > 0 &&
  issues.every((issue) => /^decision(?::|\.|$)/u.test(issue) && issue.includes('product'));

const plannerOutputCorrectionBudget = (issues: readonly string[]): number =>
  isResearchProductSchemaFeedback(issues) ? 1 : isSegmentSchemaFeedback(issues) ? 2 : 0;

interface ProjectValidationMissingFailure {
  readonly kind: 'project_validation_missing';
  readonly repositoryReference: string;
  readonly expectedKeys: typeof VALIDATION_PROCESS_COMMAND_REFERENCES;
  readonly missingKeys: readonly ValidationProcessCommandReference[];
}

interface ProductNotMappedFailure {
  readonly kind: 'product_not_mapped';
  readonly taskId: string;
  readonly jiraProjectKey: string;
  readonly repositoryReference: string;
  readonly availableProjectKeys: readonly string[];
}

const snapshottedProducts = (pack: LoadedHarnessPack): readonly LoadedHarnessProduct[] =>
  pack.products;

const resolveSnapshottedProduct = (
  products: readonly LoadedHarnessProduct[],
  taskId: string,
): {
  readonly jiraProjectKey: string;
  readonly product: LoadedHarnessProduct | null;
} => {
  const jiraProjectKey =
    taskId
      .trim()
      .replace(/^jira:/iu, '')
      .split('-')[0] ?? taskId;
  return {
    jiraProjectKey,
    product: resolveHarnessProductByJiraProject(products, taskId),
  };
};

const materializeDeliverPrScaffold = (input: {
  readonly task: WorkflowGenerationSubject['task'];
  readonly taskSnapshot: WorkflowGenerationSubject['taskSnapshot'];
  readonly blocks: readonly LoadedHarnessPack['steps'][number]['block'][];
  readonly project: LoadedHarnessPack['projects'][number] | null;
  readonly policies: readonly LoadedHarnessPack['policies'][number][];
  readonly decision: Extract<
    ReadyImplementationPlanningDecision,
    { readonly archetype: 'deliver-pr' }
  >;
}): Outcome<
  z.infer<typeof SemanticWorkflowSourceSchema>,
  | { readonly kind: 'slot_error'; readonly issues: readonly string[] }
  | ProjectValidationMissingFailure
> => {
  const expectedKeys = VALIDATION_PROCESS_COMMAND_REFERENCES;
  const missingKeys = expectedKeys.filter(
    (reference) => input.project?.processCommands[reference] === undefined,
  );
  if (missingKeys.length > 0) {
    return err({
      kind: 'project_validation_missing',
      repositoryReference: input.task.repository,
      expectedKeys,
      missingKeys,
    });
  }

  const config = resolveDeliverPrScaffoldConfig(input.policies);
  const blockByReference = new Map(input.blocks.map((block) => [block.reference, block] as const));

  for (const reference of config.requiredStages) {
    const block = blockByReference.get(reference);
    if (block?.availableDuring.includes('execution') === true) continue;
    throwInternalScaffoldInvariant(
      internalScaffoldInvariant('deliver-pr'),
      `missing required execution block ${reference}`,
    );
  }
  if (
    blockByReference.get(VALIDATION_RUN_STEP_REFERENCE)?.availableDuring.includes('execution') !==
    true
  ) {
    throwInternalScaffoldInvariant(
      internalScaffoldInvariant('deliver-pr'),
      `missing required execution block ${VALIDATION_RUN_STEP_REFERENCE}`,
    );
  }

  const unavailableSegments = input.decision.segments.flatMap((segment) => {
    const references = config.optionalSegments[segment];
    return references.every((reference) => {
      const block = blockByReference.get(reference);
      return block?.availableDuring.includes('execution') === true;
    })
      ? []
      : [`Segment ${segment} is unavailable in the frozen block catalog.`];
  });
  if (unavailableSegments.length > 0) {
    return err({ kind: 'slot_error', issues: unavailableSegments });
  }

  return scaffoldDeliverPr(
    {
      task: input.task,
      taskSnapshot: input.taskSnapshot,
      objective: input.decision.plan.summary,
      segments: input.decision.segments,
      verification: {
        validationProfile: input.decision.verification.validationProfile,
      },
    },
    config,
  );
};

const materializeResearchScaffold = (input: {
  readonly task: WorkflowGenerationSubject['task'];
  readonly blocks: readonly LoadedHarnessPack['steps'][number]['block'][];
  readonly products: readonly LoadedHarnessProduct[];
  readonly decision: Extract<
    ReadyImplementationPlanningDecision,
    { readonly archetype: 'research' }
  >;
  readonly repositoryReference: string;
  readonly operatorBrief: string | null;
}): Outcome<
  z.infer<typeof SemanticWorkflowSourceSchema>,
  { readonly kind: 'slot_error'; readonly issues: readonly string[] } | ProductNotMappedFailure
> => {
  const blockByReference = new Map(input.blocks.map((block) => [block.reference, block] as const));
  const unavailableSteps = Object.values(RESEARCH_STEP_REFERENCES).flatMap((reference) => {
    const block = blockByReference.get(reference);
    return block?.availableDuring.includes('execution') === true
      ? []
      : [`Research scaffold requires execution block ${reference}.`];
  });
  if (unavailableSteps.length > 0) {
    return err({ kind: 'slot_error', issues: unavailableSteps });
  }

  const { jiraProjectKey, product } = resolveSnapshottedProduct(input.products, input.task.taskId);
  if (product === null) {
    return err({
      kind: 'product_not_mapped',
      taskId: input.task.taskId,
      jiraProjectKey,
      repositoryReference: input.repositoryReference,
      availableProjectKeys: [
        ...new Set(input.products.flatMap(({ jiraProjects }) => jiraProjects)),
      ].sort((left, right) => left.localeCompare(right)),
    });
  }

  return scaffoldResearch({
    task: input.task,
    objective: input.decision.plan.summary,
    questions: input.decision.questions,
    product,
    repositoryReference: input.repositoryReference,
    segments: input.decision.segments,
    operatorBrief: input.operatorBrief,
  });
};

export class ImplementationPlanningCoordinator {
  private readonly inFlight = new Map<
    string,
    Promise<Outcome<ImplementationPlanningRecord, ImplementationPlanningError>>
  >();

  public constructor(
    private readonly store: ImplementationPlanningStore,
    private readonly workflows: OperatorWorkflowService,
    private readonly subjects: WorkflowGenerationSubjectSource,
    private readonly evidenceBundles: EvidenceBundleStore,
    private readonly planner: ImplementationPlanner,
    private readonly harnessPackSource: () => LoadedHarnessPack,
    private readonly transcripts: PlanningTranscriptStore,
    private readonly evidenceReaders: PlanningEvidenceReaderRegistry | null,
  ) {}

  public readRunSnapshot(
    reference: PlanningSnapshotReference,
  ): Outcome<RunPlanningSnapshot, ImplementationPlanningError> {
    const snapshot = this.store.readRunSnapshot(reference);
    return snapshot.ok ? snapshot : err({ kind: 'store', error: snapshot.error });
  }

  public readArchivedExecutionGraph(
    reference: PlanningSnapshotReference,
  ): Outcome<z.infer<typeof CompiledWorkflowSchema>, ImplementationPlanningError> {
    const graph = this.store.readArchivedExecutionGraph(reference);
    return graph.ok ? graph : err({ kind: 'store', error: graph.error });
  }

  public createPlanningContextSnapshot(
    taskReference: string,
    workflowRunId: string,
    workspace: PlanningSnapshotWorkspace,
  ): Outcome<
    { readonly reference: PlanningSnapshotReference; readonly contextHash: string },
    ImplementationPlanningError
  > {
    const subject = this.subjects.resolve(taskReference, workflowRunId);
    if (!subject.ok) return err({ kind: 'subject', error: subject.error });
    if (subject.value.task.repository !== workspace.reference) {
      return err({
        kind: 'workspace_repository_mismatch',
        taskReference,
        expectedReference: subject.value.task.repository,
        actualReference: workspace.reference,
      });
    }
    const harness = snapshotHarness(
      this.harnessPackSource(),
      subject.value.task.repository,
      null,
      subject.value.task,
    );
    const harnessHash = checksumString(JSON.stringify(harness));
    const contextHash = checksumString(
      JSON.stringify({
        task: subject.value.task,
        taskSnapshot: subject.value.taskSnapshot,
        repository: workspace,
        harness,
      }),
    );
    const snapshot: PlanningContextSnapshot = PlanningContextSnapshotSchema.parse({
      schemaVersion: 11,
      kind: 'planning_context',
      taskReference,
      workflowRunId,
      contextHash,
      task: subject.value.task,
      taskSnapshot: subject.value.taskSnapshot,
      repository: {
        workspaceId: workspace.workspaceId,
        reference: subject.value.task.repository,
        path: workspace.path,
      },
      harness,
      harnessHash,
      createdAt: this.store.now(),
    });
    const stored = this.store.persistRunSnapshot(snapshot);
    return stored.ok
      ? ok({ reference: stored.value, contextHash })
      : err({ kind: 'store', error: stored.error });
  }

  public createExecutionSnapshot(
    taskReference: string,
    expectedWorkflowHash: string,
    workflowOperationId: string,
    acceptedPlan: JsonValue,
    executionStrategy: TaskExecutionStrategy,
    evidenceBundle: EvidenceBundleReference,
    workspace: PlanningSnapshotWorkspace,
    planningContextReference: PlanningSnapshotReference,
  ): Outcome<PlanningSnapshotReference, ImplementationPlanningError> {
    const workflow = this.workflows.readPlanningOperation(taskReference, workflowOperationId);
    if (!workflow.ok) return err({ kind: 'subject', error: workflow.error });
    if (workflow.value?.status !== 'ready') {
      return err({ kind: 'workflow_not_ready', taskReference });
    }
    const actualHash = workflow.value.view.workflow.graphHash;
    if (actualHash !== expectedWorkflowHash) {
      return err({
        kind: 'workflow_snapshot_mismatch',
        taskReference,
        expectedHash: expectedWorkflowHash,
        actualHash,
      });
    }
    const graph = JsonValueSchema.safeParse(workflow.value.view.workflow.graph);
    if (!graph.success) return err({ kind: 'workflow_not_ready', taskReference });
    const semanticSource = SemanticWorkflowSourceSchema.safeParse(
      workflow.value.view.workflow.semanticSource,
    );
    const semanticHash = workflow.value.view.workflow.semanticHash;
    const compilerVersion = workflow.value.view.workflow.compilerVersion;
    if (!semanticSource.success || semanticHash === null || compilerVersion === null) {
      return err({ kind: 'workflow_not_ready', taskReference });
    }
    const planningContext = this.store.readRunSnapshot(planningContextReference);
    if (!planningContext.ok) return err({ kind: 'store', error: planningContext.error });
    if (
      planningContext.value.kind !== 'planning_context' ||
      planningContext.value.taskReference !== taskReference
    ) {
      return err({ kind: 'workflow_not_ready', taskReference });
    }
    const referencedSteps = new Set(
      CompiledWorkflowSchema.parse(graph.data).metadata.references.stepTypes,
    );
    const snapshot: ExecutionRunSnapshot = ExecutionRunSnapshotSchema.parse({
      schemaVersion: 11,
      kind: 'execution',
      executionStrategy,
      semanticHash,
      semanticSource: semanticSource.data,
      compilerVersion,
      taskReference,
      workflowRunId: planningContext.value.workflowRunId,
      workflowHash: expectedWorkflowHash,
      task: planningContext.value.task,
      taskSnapshot: planningContext.value.taskSnapshot,
      workflow: JsonValueSchema.parse(workflow.value.view.workflow),
      acceptedPlan,
      evidenceBundle,
      repository: {
        workspaceId: workspace.workspaceId,
        reference: planningContext.value.task.repository,
        path: workspace.path,
      },
      harness: {
        ...planningContext.value.harness,
        steps: planningContext.value.harness.steps
          .filter(({ reference }) => referencedSteps.has(reference))
          .map((step) => {
            const role =
              step.block.executor.kind === 'agent'
                ? (step.block.executor.strategyRole ?? null)
                : null;
            return role === null || step.block.executor.kind !== 'agent'
              ? step
              : {
                  ...step,
                  executionProfile: resolveTaskExecutionProfile(
                    planningContext.value.harness.company,
                    planningContext.value.harness.project?.executionProfileOverrides ?? null,
                    executionStrategy,
                    role,
                  ),
                };
          }),
      },
      harnessHash: planningContext.value.harnessHash,
      createdAt: this.store.now(),
    });
    const stored = this.store.persistRunSnapshot(snapshot);
    return stored.ok ? stored : err({ kind: 'store', error: stored.error });
  }

  public read(
    planningEpisodeId: string,
  ): Outcome<ImplementationPlanningRecord | null, ImplementationPlanningError> {
    const record = this.store.read(planningEpisodeId);
    return record.ok ? record : err({ kind: 'store', error: record.error });
  }

  public readTranscript(
    planningEpisodeId: string,
  ): Outcome<PlanningTranscriptView | null, ImplementationPlanningError> {
    const planning = this.store.read(planningEpisodeId);
    if (!planning.ok) return err({ kind: 'store', error: planning.error });
    if (planning.value === null || planning.value.commandId === null) return ok(null);
    const transcript = this.transcripts.read(planning.value.commandId);
    return transcript.ok ? transcript : err({ kind: 'transcript', error: transcript.error });
  }

  public readOperationTranscript(
    operationId: string,
  ): Outcome<PlanningTranscriptView, ImplementationPlanningError> {
    const transcript = this.transcripts.read(operationId);
    return transcript.ok ? transcript : err({ kind: 'transcript', error: transcript.error });
  }

  public prepare(
    taskReference: string,
    requestedStrategy: PlanningStrategyRequest,
    commandId: string,
    planningEpisodeId: string,
    snapshotReference: PlanningSnapshotReference,
    evidenceReference: EvidenceBundleReference,
    operatorGuidance: string | null = null,
    operatorBrief: string | null = null,
  ): Promise<Outcome<ImplementationPlanningRecord, ImplementationPlanningError>> {
    const inFlightKey = `${taskReference}:${commandId}`;
    const current = this.inFlight.get(inFlightKey);
    if (current !== undefined) return current;
    const pending = this.prepareOnce(
      taskReference,
      requestedStrategy,
      commandId,
      planningEpisodeId,
      snapshotReference,
      evidenceReference,
      operatorGuidance,
      operatorBrief,
    ).finally(() => {
      this.inFlight.delete(inFlightKey);
    });
    this.inFlight.set(inFlightKey, pending);
    return pending;
  }

  public answer(
    taskReference: string,
    answersInput: readonly PlanningQuestionAnswer[],
    commandId: string,
    planningEpisodeId: string,
    snapshotReference: PlanningSnapshotReference,
    evidenceReference: EvidenceBundleReference,
  ): Promise<Outcome<ImplementationPlanningRecord, ImplementationPlanningError>> {
    const command = PlanningClarificationAnswerCommandSchema.safeParse({
      answers: answersInput,
    });
    if (!command.success) {
      return Promise.resolve(
        err({
          kind: 'invalid_clarification_answers',
          taskReference,
          issues: command.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        }),
      );
    }
    const current = this.store.read(planningEpisodeId);
    if (!current.ok) return Promise.resolve(err({ kind: 'store', error: current.error }));
    if (current.value?.commandId === commandId) {
      if (current.value.status === 'failed' || current.value.status === 'planning') {
        return this.prepare(
          taskReference,
          current.value.requestedStrategy,
          commandId,
          planningEpisodeId,
          snapshotReference,
          evidenceReference,
          current.value.operatorGuidance,
          current.value.operatorBrief ?? null,
        );
      }
      return Promise.resolve(ok(current.value));
    }
    if (current.value?.status !== 'needs_clarification') {
      return Promise.resolve(
        err({
          kind: 'invalid_clarification_answers',
          taskReference,
          issues: ['The current planning attempt is not waiting for clarification.'],
        }),
      );
    }

    const questions = current.value.decision.questions;
    const provided = new Map<string, string>();
    const duplicateIds: string[] = [];
    for (const answer of command.data.answers) {
      if (provided.has(answer.questionId)) duplicateIds.push(answer.questionId);
      provided.set(answer.questionId, answer.answer);
    }
    const expectedIds = new Set(questions.map((question) => question.id));
    const missingIds = questions
      .map((question) => question.id)
      .filter((questionId) => !provided.has(questionId));
    const unexpectedIds = [...provided.keys()].filter((questionId) => !expectedIds.has(questionId));
    const issues = [
      ...duplicateIds.map((questionId) => `Duplicate answer for ${questionId}.`),
      ...missingIds.map((questionId) => `Missing answer for ${questionId}.`),
      ...unexpectedIds.map((questionId) => `Unexpected answer for ${questionId}.`),
    ];
    if (issues.length > 0) {
      return Promise.resolve(err({ kind: 'invalid_clarification_answers', taskReference, issues }));
    }

    const answerFor = (questionId: string): string => {
      const answer = provided.get(questionId);
      if (answer === undefined) {
        throw new Error(`Validated clarification answer ${questionId} is missing`);
      }
      return answer;
    };
    const answers = questions.map((question) => ({
      questionId: question.id,
      answer: answerFor(question.id),
    }));
    const recorded = this.store.recordClarificationAnswers(current.value, answers);
    if (!recorded.ok) return Promise.resolve(err({ kind: 'store', error: recorded.error }));
    const guidance = [
      `Operator clarification for planning attempt ${String(current.value.attempt)}:`,
      ...questions.flatMap((question) => [
        `Question [${question.id}]: ${question.question}`,
        `Answer: ${answerFor(question.id)}`,
      ]),
      `Answer artifact: ${recorded.value.artifactId}`,
    ].join('\n');
    return this.prepare(
      taskReference,
      current.value.requestedStrategy,
      commandId,
      planningEpisodeId,
      snapshotReference,
      evidenceReference,
      guidance,
      current.value.operatorBrief ?? null,
    );
  }

  public link(record: ReadyImplementationPlanningRecord): ImplementationPlanLink {
    return ImplementationPlanLinkSchema.parse({
      artifactId: record.artifactId,
      attempt: record.attempt,
      requestedStrategy: record.requestedStrategy,
      selectedStrategy: record.selectedStrategy,
    });
  }

  public draftFor(record: ReadyImplementationPlanningRecord): Outcome<
    {
      readonly workflowHash: string;
      readonly semanticHash: string;
      readonly compilerVersion: string;
      readonly harnessSnapshotHash: string;
      readonly retrospectiveEnabled: boolean;
      readonly graph: z.infer<typeof CompiledWorkflowSchema>;
      readonly planningSnapshot: PlanningSnapshotReference;
      readonly evidenceBundle: EvidenceBundleReference;
    },
    ImplementationPlanningError
  > {
    const snapshot = this.store.readRunSnapshot(record.executionSnapshot);
    if (!snapshot.ok) return err({ kind: 'store', error: snapshot.error });
    if (
      snapshot.value.kind !== 'execution' ||
      snapshot.value.workflowHash !== record.workflowHash
    ) {
      return err({ kind: 'workflow_not_ready', taskReference: record.taskReference });
    }
    const workflow = z
      .object({ graph: JsonValueSchema })
      .loose()
      .safeParse(snapshot.value.workflow);
    if (!workflow.success) {
      return err({ kind: 'workflow_not_ready', taskReference: record.taskReference });
    }
    const graph = CompiledWorkflowSchema.safeParse(workflow.data.graph);
    if (!graph.success) {
      return err({ kind: 'workflow_not_ready', taskReference: record.taskReference });
    }
    return ok({
      workflowHash: record.workflowHash,
      semanticHash: snapshot.value.semanticHash,
      compilerVersion: snapshot.value.compilerVersion,
      harnessSnapshotHash: snapshot.value.harnessHash,
      retrospectiveEnabled: snapshot.value.harness.company.retrospective.enabled,
      graph: graph.data,
      planningSnapshot: record.executionSnapshot,
      evidenceBundle: record.evidenceBundle,
    });
  }

  public decorateTask(task: OperatorTaskSummary): OperatorTaskSummary {
    return task;
  }

  public readActivity(planningEpisodeId: string): OperatorActivityResponse['entries'] {
    return readImplementationPlanningActivity(
      this.store.listStreamEventsAfter(0).filter((event) => {
        if (
          event.payload === null ||
          typeof event.payload !== 'object' ||
          Array.isArray(event.payload)
        ) {
          return false;
        }
        return event.payload.episodeId === planningEpisodeId;
      }),
    );
  }

  public listStreamEventsAfter(sequence: number): readonly OperatorStreamEvent[] {
    return listImplementationPlanningStreamEventsAfter(this.store.listStreamEventsAfter(sequence));
  }

  private async prepareOnce(
    taskReference: string,
    requestedStrategy: PlanningStrategyRequest,
    commandId: string,
    planningEpisodeId: string,
    snapshotReference: PlanningSnapshotReference,
    evidenceReference: EvidenceBundleReference,
    operatorGuidance: string | null,
    operatorBrief: string | null,
  ): Promise<Outcome<ImplementationPlanningRecord, ImplementationPlanningError>> {
    const existing = this.store.read(planningEpisodeId);
    if (!existing.ok) return err({ kind: 'store', error: existing.error });
    if (
      existing.value?.commandId === commandId &&
      existing.value.status !== 'planning' &&
      existing.value.status !== 'failed'
    ) {
      return ok(existing.value);
    }

    const loaded = this.store.readRunSnapshot(snapshotReference);
    if (!loaded.ok) return err({ kind: 'store', error: loaded.error });
    if (loaded.value.kind !== 'planning_context' || loaded.value.taskReference !== taskReference) {
      return err({ kind: 'workflow_not_ready', taskReference });
    }
    const suppliedEvidence = this.evidenceBundles.read(evidenceReference);
    if (!suppliedEvidence.ok) {
      return err({ kind: 'evidence_bundle', error: suppliedEvidence.error });
    }
    const subject = {
      schemaVersion: 1 as const,
      repositoryPath: loaded.value.repository.path,
      task: loaded.value.task,
      taskSnapshot: loaded.value.taskSnapshot,
    };
    const planningInput = {
      subject,
      blocks: loaded.value.harness.steps.map(({ block }) => block),
      project: loaded.value.harness.project,
      products: loaded.value.harness.products,
      policies: loaded.value.harness.policies,
      promptTemplate: loaded.value.harness.implementationPlanner.prompt.content,
      plannerSkills: loaded.value.harness.implementationPlanner.skills,
      plannerProfiles: loaded.value.harness.implementationPlanner.profiles,
      workspace: loaded.value.repository,
    };
    const selection = selectStrategy(requestedStrategy);
    const begun =
      existing.value?.commandId === commandId && existing.value.status === 'planning'
        ? ok(existing.value)
        : this.store.begin({
            taskReference,
            planningEpisodeId,
            commandId,
            planningSnapshot: snapshotReference,
            evidenceBundle: suppliedEvidence.value.reference,
            requestedStrategy,
            selectedStrategy: selection.strategy,
            selectionReason: selection.reason,
            operatorGuidance,
            operatorBrief,
            validationFeedback:
              operatorGuidance !== null && existing.value?.status === 'failed'
                ? existing.value.validationFeedback
                : [],
            previousDecision:
              existing.value?.status === 'ready'
                ? existing.value.decision
                : operatorGuidance !== null && existing.value?.status === 'failed'
                  ? existing.value.previousDecision
                  : null,
          });
    if (!begun.ok) return err({ kind: 'store', error: begun.error });
    if (begun.value.status !== 'planning') {
      throw new Error('Planning begin did not produce a planning record');
    }

    let planning = begun.value;
    let evidenceBundle = this.evidenceBundles.readMaterialized(planning.evidenceBundle);
    if (!evidenceBundle.ok) {
      return err({ kind: 'evidence_bundle', error: evidenceBundle.error });
    }
    const mediatedSkills = (this.evidenceReaders?.supportedSkills() ?? []).filter((skill) =>
      planningInput.plannerSkills.includes(skill),
    );
    const mediatedCredentialEnvironment =
      this.evidenceReaders?.credentialEnvironment(mediatedSkills) ?? [];

    for (;;) {
      if (planning.validatedCandidate !== null) {
        return this.completeValidatedCandidate(
          planning,
          planningInput.workspace,
          snapshotReference,
        );
      }
      if (planning.pendingEvidence !== null) {
        if (this.evidenceReaders === null) {
          throw new Error('Persisted evidence request has no reader registry');
        }
        const captures: PlanningEvidenceCapture[] = [];
        for (const request of planning.pendingEvidence.requests) {
          const observed = await this.evidenceReaders.read(request);
          if (!observed.ok) return err({ kind: 'evidence_read', error: observed.error });
          captures.push({ request, observation: observed.value });
        }
        const appended = this.evidenceBundles.appendPlanningEvidence(
          planning.evidenceBundle,
          planning.pendingEvidence.operationId,
          captures,
        );
        if (!appended.ok) return err({ kind: 'evidence_bundle', error: appended.error });
        const recorded = this.store.completeEvidenceRequest(planning, appended.value.reference);
        if (!recorded.ok) return err({ kind: 'store', error: recorded.error });
        planning = recorded.value;
        const materialized = this.evidenceBundles.readMaterialized(planning.evidenceBundle);
        if (!materialized.ok) {
          return err({ kind: 'evidence_bundle', error: materialized.error });
        }
        evidenceBundle = materialized;
        continue;
      }

      const result = await this.planner.plan({
        operationId: commandId,
        taskReference,
        planningEpisodeId,
        planningAttempt: planning.attempt,
        invocationNumber: planningInvocationNumberFor(
          planning,
          this.store.nextAgentInvocationNumber(planningEpisodeId, planning.attempt),
        ),
        inputEvidenceArtifactIds: [
          snapshotReference.artifactId,
          planning.evidenceBundle.artifactId,
        ],
        outputReferences: planningOutputReferencesFor(planning),
        onTranscriptDegradation: (message) => {
          const appended = this.transcripts.append(
            commandId,
            planning.attempt,
            'stderr',
            message,
            taskReference,
          );
          void appended;
        },
        repositoryPath: planningInput.subject.repositoryPath,
        strategy: selection.strategy,
        profile: planningInput.plannerProfiles[selection.strategy],
        skills: planningInput.plannerSkills,
        mediatedSkills,
        mediatedCredentialEnvironment,
        context: {
          task: planningInput.subject.task,
          taskSnapshot: planningInput.subject.taskSnapshot,
          blocks: planningInput.blocks,
          evidenceBundle: evidenceBundle.value.bundle,
          product: resolveSnapshottedProduct(
            planningInput.products,
            planningInput.subject.task.taskId,
          ).product,
          repositoryReference: planningInput.subject.task.repository,
          operatorGuidance,
          validationFeedback: planning.validationFeedback,
          previousDecision: planning.previousDecision,
        },
        promptTemplate: planningInput.promptTemplate,
      });
      if (!result.ok) {
        const correctionBudget =
          result.error.kind === 'invalid_planner_output'
            ? plannerOutputCorrectionBudget(result.error.issues)
            : 0;
        if (result.error.kind === 'invalid_planner_output' && correctionBudget > 0) {
          if (planning.validationRevision >= correctionBudget) {
            const failed = this.store.fail(
              planning,
              result.error,
              plannerFailureReceipt(result.error),
            );
            return failed.ok ? failed : err({ kind: 'store', error: failed.error });
          }
          const rejected = this.store.recordValidationRejection(
            planning,
            result.error.issues,
            null,
          );
          if (!rejected.ok) return err({ kind: 'store', error: rejected.error });
          planning = rejected.value;
          continue;
        }
        const failed = this.store.fail(planning, result.error, plannerFailureReceipt(result.error));
        return failed.ok ? failed : err({ kind: 'store', error: failed.error });
      }
      if (result.value.decision !== null && (result.value.evidenceRequests?.length ?? 0) > 0) {
        const failed = this.store.fail(
          planning,
          {
            kind: 'invalid_planner_output',
            issues: ['Planner returned a decision before requested evidence was available.'],
          },
          result.value.receipt,
        );
        return failed.ok ? failed : err({ kind: 'store', error: failed.error });
      }
      if (result.value.decision !== null) {
        if (result.value.decision.status === 'investigation_required') {
          const blockByReference = new Map(
            planningInput.blocks.map((block) => [block.reference, block] as const),
          );
          const issues = result.value.decision.request.steps.flatMap((step) => {
            const block = blockByReference.get(step.uses);
            if (block === undefined) return [`Investigation selected unknown block ${step.uses}.`];
            return block.availableDuring.includes('bootstrap_investigation')
              ? []
              : [`Block ${step.uses} is not available during bootstrap investigation.`];
          });
          if (issues.length > 0) {
            const failed = this.store.fail(
              planning,
              { kind: 'invalid_planner_output', issues },
              result.value.receipt,
            );
            return failed.ok ? failed : err({ kind: 'store', error: failed.error });
          }
        }

        if (result.value.decision.status === 'ready') {
          const scaffold =
            result.value.decision.archetype === 'deliver-pr'
              ? materializeDeliverPrScaffold({
                  task: planningInput.subject.task,
                  taskSnapshot: planningInput.subject.taskSnapshot,
                  blocks: planningInput.blocks,
                  project: planningInput.project,
                  policies: planningInput.policies,
                  decision: result.value.decision,
                })
              : materializeResearchScaffold({
                  task: planningInput.subject.task,
                  blocks: planningInput.blocks,
                  products: planningInput.products,
                  decision: result.value.decision,
                  repositoryReference: planningInput.workspace.reference,
                  operatorBrief: planning.operatorBrief ?? null,
                });
          if (!scaffold.ok) {
            if (
              scaffold.error.kind === 'project_validation_missing' ||
              scaffold.error.kind === 'product_not_mapped'
            ) {
              const failed = this.store.fail(planning, scaffold.error, result.value.receipt);
              return failed.ok ? failed : err({ kind: 'store', error: failed.error });
            }
            if (planning.validationRevision >= 2) {
              const failed = this.store.fail(
                planning,
                { kind: 'invalid_planner_output', issues: scaffold.error.issues },
                result.value.receipt,
              );
              return failed.ok ? failed : err({ kind: 'store', error: failed.error });
            }
            const rejected = this.store.recordValidationRejection(
              planning,
              scaffold.error.issues,
              result.value.decision,
            );
            if (!rejected.ok) return err({ kind: 'store', error: rejected.error });
            planning = rejected.value;
            continue;
          }
          const acceptanceIssues = validateAcceptanceVerificationLinks(
            result.value.decision,
            scaffold.value,
          );
          if (acceptanceIssues.length > 0) {
            if (planning.validationRevision >= 2) {
              const failed = this.store.fail(
                planning,
                { kind: 'invalid_planner_output', issues: acceptanceIssues },
                result.value.receipt,
              );
              return failed.ok ? failed : err({ kind: 'store', error: failed.error });
            }
            const rejected = this.store.recordValidationRejection(
              planning,
              acceptanceIssues,
              result.value.decision,
            );
            if (!rejected.ok) return err({ kind: 'store', error: rejected.error });
            planning = rejected.value;
            continue;
          }
          const candidateNumber = planning.validationRevision + 1;
          const operationId = `${commandId}:workflow-candidate:${String(candidateNumber)}`;
          const assembled = this.workflows.assembleFromImplementationPlanAtOperation(
            planningInput.subject.task,
            result.value.decision,
            { source: scaffold.value },
            operationId,
          );
          if (!assembled.ok) {
            return err({ kind: 'subject', error: assembled.error });
          }
          if (
            assembled.value.status !== 'ready' ||
            assembled.value.view.workflow.graphHash === null
          ) {
            const invariant = internalScaffoldInvariant(result.value.decision.archetype);
            throwInternalScaffoldInvariant(
              invariant,
              assembled.value.view.workflow.validatorReport.issues
                .map(({ message }) => message)
                .join('; '),
            );
          }
          const invariant = internalScaffoldInvariant(result.value.decision.archetype);
          const workflowHash = requireInvariantValue(
            assembled.value.view.workflow.graphHash,
            invariant,
            'compiled workflow hash is absent',
          );
          const semanticHash = requireInvariantValue(
            assembled.value.view.workflow.semanticHash,
            invariant,
            'semantic workflow provenance is absent from the compiled candidate',
          );
          const compilerVersion = requireInvariantValue(
            assembled.value.view.workflow.compilerVersion,
            invariant,
            'semantic workflow provenance is absent from the compiled candidate',
          );
          const parsedGraph = CompiledWorkflowSchema.safeParse(assembled.value.view.workflow.graph);
          if (!parsedGraph.success) {
            throwInternalScaffoldInvariant(invariant, 'compiled workflow graph is corrupt');
          }
          const graph = requireInvariantValue(
            parsedGraph.data,
            invariant,
            'compiled workflow graph is corrupt',
          );
          const blockByReference = new Map(
            planningInput.blocks.map((block) => [block.reference, block] as const),
          );
          const phaseIssues = graph.metadata.references.stepTypes.flatMap((reference) => {
            const block = blockByReference.get(reference);
            return block?.availableDuring.includes('execution') === true
              ? []
              : [`Block ${reference} is not available during execution.`];
          });
          if (phaseIssues.length > 0) {
            throwInternalScaffoldInvariant(invariant, phaseIssues.join('; '));
          }
          const semanticSource = SemanticWorkflowSourceSchema.safeParse(
            assembled.value.view.workflow.semanticSource,
          );
          if (!semanticSource.success) {
            throwInternalScaffoldInvariant(
              invariant,
              'semantic workflow source is absent from the compiled candidate',
            );
          }
          const checkpointed = this.store.recordValidatedCandidate(planning, {
            decision: result.value.decision,
            semanticHash,
            compilerVersion,
            workflowHash,
            workflowOperationId: operationId,
            receipt: result.value.receipt,
          });
          if (!checkpointed.ok) return err({ kind: 'store', error: checkpointed.error });
          return this.completeValidatedCandidate(
            checkpointed.value,
            planningInput.workspace,
            snapshotReference,
          );
        }
        const completed = this.store.complete(
          planning,
          { decision: result.value.decision, receipt: result.value.receipt },
          null,
        );
        return completed.ok ? completed : err({ kind: 'store', error: completed.error });
      }
      const evidenceRequests = result.value.evidenceRequests ?? [];
      if (evidenceRequests.length === 0) {
        const failed = this.store.fail(
          planning,
          {
            kind: 'invalid_planner_output',
            issues: ['Planner returned neither a decision nor an evidence request.'],
          },
          result.value.receipt,
        );
        return failed.ok ? failed : err({ kind: 'store', error: failed.error });
      }
      const requestIssues = evidenceRequests.flatMap((request) => {
        if (!planningInput.plannerSkills.includes(request.skill)) {
          return [
            `Evidence request ${request.requestId} selected undeclared skill ${request.skill}.`,
          ];
        }
        if (!mediatedSkills.includes(request.skill)) {
          return [
            `Evidence request ${request.requestId} selected unmediated skill ${request.skill}.`,
          ];
        }
        return [];
      });
      const requestIds = new Set(evidenceRequests.map(({ requestId }) => requestId));
      if (requestIds.size !== evidenceRequests.length) {
        requestIssues.push('Evidence request IDs must be unique within one planner response.');
      }
      if (planning.evidenceRounds.length >= MAX_PLANNING_EVIDENCE_ROUNDS) {
        requestIssues.push(
          `Planner exceeded ${String(MAX_PLANNING_EVIDENCE_ROUNDS)} mediated evidence rounds.`,
        );
      }
      if (requestIssues.length > 0) {
        const failed = this.store.fail(
          planning,
          {
            kind: 'invalid_planner_output',
            issues: requestIssues,
          },
          result.value.receipt,
        );
        return failed.ok ? failed : err({ kind: 'store', error: failed.error });
      }
      const round = planning.evidenceRounds.length + 1;
      const operationId = `${commandId}:evidence:${String(round)}`;
      const recorded = this.store.recordEvidenceRequest(planning, {
        round,
        operationId,
        requests: [...evidenceRequests],
        receipt: result.value.receipt,
        requestedAt: this.store.now(),
      });
      if (!recorded.ok) return err({ kind: 'store', error: recorded.error });
      planning = recorded.value;
    }
  }

  private completeValidatedCandidate(
    planning: Extract<ImplementationPlanningRecord, { readonly status: 'planning' }>,
    workspace: PlanningSnapshotWorkspace,
    planningContextReference: PlanningSnapshotReference,
  ): Outcome<ImplementationPlanningRecord, ImplementationPlanningError> {
    const candidate = planning.validatedCandidate;
    if (candidate === null)
      return err({ kind: 'workflow_not_ready', taskReference: planning.taskReference });
    const executionSnapshot = this.createExecutionSnapshot(
      planning.taskReference,
      candidate.workflowHash,
      candidate.workflowOperationId,
      JsonValueSchema.parse({
        artifactId: `implementation-plan:${planning.planningEpisodeId}:attempt-${String(planning.attempt)}`,
        attempt: planning.attempt,
        selectedStrategy: planning.selectedStrategy,
        executionStrategy: candidate.decision.executionStrategy,
        archetype: candidate.decision.archetype,
        plan: candidate.decision.plan,
      }),
      candidate.decision.executionStrategy,
      planning.evidenceBundle,
      workspace,
      planningContextReference,
    );
    if (!executionSnapshot.ok) return executionSnapshot;
    const completed = this.store.complete(
      planning,
      { decision: candidate.decision, receipt: candidate.receipt },
      {
        workflowHash: candidate.workflowHash,
        workflowOperationId: candidate.workflowOperationId,
        executionSnapshot: executionSnapshot.value,
      },
    );
    return completed.ok ? completed : err({ kind: 'store', error: completed.error });
  }
}

export const createImplementationPlanningCoordinator = (input: {
  readonly ledger: LedgerRepository;
  readonly clock: Clock;
  readonly workflows: OperatorWorkflowService;
  readonly subjects: WorkflowGenerationSubjectSource;
  readonly planner: ImplementationPlanner;
  readonly evidenceBundles?: EvidenceBundleStore;
  readonly evidenceReaders?: PlanningEvidenceReaderRegistry;
  readonly harnessPack?: LoadedHarnessPack;
  readonly harnessPackSource?: () => LoadedHarnessPack;
}): ImplementationPlanningCoordinator => {
  const fixedPack = input.harnessPack;
  const harnessPackSource =
    input.harnessPackSource ??
    (fixedPack === undefined ? () => loadHarnessPack() : () => fixedPack);
  return new ImplementationPlanningCoordinator(
    new ImplementationPlanningStore(input.ledger, input.clock),
    input.workflows,
    input.subjects,
    input.evidenceBundles ?? new EvidenceBundleStore(input.ledger, input.clock),
    input.planner,
    harnessPackSource,
    new PlanningTranscriptStore(input.ledger, input.clock),
    input.evidenceReaders ?? null,
  );
};
