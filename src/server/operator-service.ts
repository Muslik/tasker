import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { z } from 'zod';
import {
  createWorkflowProposalFromAnalyzerOutput,
  planWorkflowProposal,
  type ReadyImplementationPlanningDecision,
  type PlanningTaskSnapshot,
  type PlanningFailure,
  type WorkflowProposalArtifact,
  type WorkflowAnalyzerOutput,
  type WorkflowGenerationSubject,
} from '../planning/index.js';
import type { WorkflowAnalyzerFailure, WorkflowAnalyzerReceipt } from '../agents/index.js';
import {
  JsonValueSchema,
  type JsonValue,
  type SemanticWorkflowSource,
  type ValidationReport,
} from '../graph/index.js';
import {
  PlanningTaskSummarySchema,
  OPERATOR_VIEW_SCHEMA_VERSION,
  OperatorActivityResponseSchema,
  OperatorStreamEventSchema,
  WorkflowResponseSchema,
  WorkflowViewSchema,
  type PlanningTaskSummary,
  type OperatorActivityResponse,
  type OperatorStreamEvent,
  type WorkflowResponse,
  type WorkflowView,
} from './operator-contracts.js';
import {
  OperatorWorkflowStore,
  type OperatorStoreError,
  type OperatorWorkflowArtifacts,
} from './operator-store.js';

export type OperatorServiceError =
  | {
      readonly kind: 'task_not_found';
      readonly taskReference: string;
    }
  | {
      readonly kind: 'generation_blocked';
      readonly taskReference: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'planner_contract_failure';
      readonly stage: PlanningFailure['stage'];
    }
  | {
      readonly kind: 'non_json_artifact';
      readonly artifact: 'compiled_graph' | 'proposal' | 'semantic_source' | 'validator_report';
    }
  | {
      readonly kind: 'store_failure';
      readonly error: OperatorStoreError;
    }
  | {
      readonly kind: 'provider_failure';
      readonly provider: 'subscription_cli';
      readonly failure: WorkflowAnalyzerFailure;
    }
  | {
      readonly kind: 'generation_runtime_unavailable';
      readonly message: string;
    };

interface BuiltView {
  readonly artifacts: OperatorWorkflowArtifacts;
  readonly view: WorkflowView;
}

interface MaterializedImplementationPlanScaffold {
  readonly source: SemanticWorkflowSource;
}

const isJsonRecord = (value: JsonValue): value is Readonly<Record<string, JsonValue>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const WorkflowAnalyzedEventPayloadSchema = z
  .object({
    durationMs: z.number().nonnegative(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .loose(),
  })
  .loose();

const toTaskSummary = (task: PlanningTaskSnapshot): PlanningTaskSummary =>
  PlanningTaskSummarySchema.parse({
    reference: task.reference,
    title: task.title,
    kind: task.kind,
  });

const toJson = (
  value: unknown,
  artifact: 'compiled_graph' | 'proposal' | 'semantic_source' | 'validator_report',
): Outcome<JsonValue, OperatorServiceError> => {
  const result = JsonValueSchema.safeParse(value);
  return result.success ? ok(result.data) : err({ kind: 'non_json_artifact', artifact });
};

const verificationProfile = (
  proposal: WorkflowProposalArtifact,
): WorkflowView['workflow']['verificationPlan']['profile'] => {
  switch (proposal.verificationPlan.profile) {
    case 'targeted':
    case 'translation_and_targeted':
      return 'targeted_tests';
    case 'full':
      return 'full_suite';
    case 'full_with_visual':
      return 'visual_compare';
  }
};

const baseWorkflowView = (
  task: PlanningTaskSnapshot,
  proposal: WorkflowProposalArtifact,
  persistedAt: string,
) => ({
  schemaVersion: OPERATOR_VIEW_SCHEMA_VERSION,
  taskSummary: toTaskSummary(task),
  intake: {
    id: `intake:${task.reference}`,
    status: 'accepted' as const,
    eligibility: {
      eligible: true,
      reason:
        'The current task snapshot and managed repository checkout are ready for workflow planning.',
    },
  },
  task: {
    id: task.taskId,
  },
  workflow: {
    proposalId: `proposal:${task.reference}`,
    assemblyDecisions: proposal.assemblyDecisions,
    capabilities: proposal.capabilities,
    waits: proposal.waits.map((wait) => ({
      nodeId: wait.nodeId,
      waitKind: wait.waitKind,
    })),
    expectedArtifacts: [
      ...new Set(proposal.expectedArtifacts.map((artifact) => artifact.kind)),
    ].sort((left, right) => left.localeCompare(right)),
    verificationPlan: {
      profile: verificationProfile(proposal),
      rationale: proposal.verificationPlan.rationale,
    },
    executable: false as const,
  },
  persistedAt,
});

const rejectedValidatorReport = (failure: PlanningFailure): ValidationReport => {
  switch (failure.stage) {
    case 'workflow_validation':
      return failure.validatorReport;
    case 'capability_validation':
      return {
        workflowId: `${failure.proposal.task.reference}-workflow`,
        issues: [
          {
            code: 'unknown_reference',
            message: `Missing required capabilities: ${failure.missingCapabilities.join(', ')}`,
            path: ['capabilities'],
            details: {
              missingCapabilities: failure.missingCapabilities,
              recovery: 'reject',
            },
          },
        ],
      };
    case 'proposal':
      throw new Error(`Planning failed before a proposal existed at ${failure.stage}`);
  }
};

const rejectedProposal = (failure: PlanningFailure): WorkflowProposalArtifact | null => {
  switch (failure.stage) {
    case 'workflow_validation':
    case 'capability_validation':
      return failure.proposal;
    case 'proposal':
      return null;
  }
};

const buildAcceptedView = (
  task: PlanningTaskSnapshot,
  planned: Extract<ReturnType<typeof planWorkflowProposal>, { readonly ok: true }>['value'],
  persistedAt: string,
): Outcome<BuiltView, OperatorServiceError> => {
  const graph = toJson(planned.compiled.graph, 'compiled_graph');
  const proposal = toJson(planned.proposal, 'proposal');
  const semanticSource = toJson(planned.semantic.source, 'semantic_source');
  const validatorReport = toJson(planned.compiled.validatorReport, 'validator_report');

  if (!graph.ok) return graph;
  if (!proposal.ok) return proposal;
  if (!semanticSource.ok) return semanticSource;
  if (!validatorReport.ok) return validatorReport;

  const common = baseWorkflowView(task, planned.proposal, persistedAt);
  const view = WorkflowViewSchema.parse({
    ...common,
    task: { ...common.task, status: 'planned' },
    workflow: {
      ...common.workflow,
      status: 'valid',
      semanticHash: planned.semantic.semanticHash,
      semanticSource: semanticSource.value,
      compilerVersion: planned.semantic.semanticIrVersion,
      graphHash: planned.compiled.hash,
      graph: graph.value,
      validatorReport: planned.compiled.validatorReport,
    },
  });

  return ok({
    view,
    artifacts: {
      analyzerVersion: planned.proposal.analyzerVersion,
      compiledGraph: graph.value,
      proposal: proposal.value,
      validatorReport: validatorReport.value,
    },
  });
};

const buildRejectedView = (
  task: PlanningTaskSnapshot,
  failure: PlanningFailure,
  persistedAt: string,
): Outcome<BuiltView, OperatorServiceError> => {
  const proposalValue = rejectedProposal(failure);
  if (proposalValue === null) {
    return err({ kind: 'planner_contract_failure', stage: failure.stage });
  }

  const proposal = toJson(proposalValue, 'proposal');
  const validatorReportValue = rejectedValidatorReport(failure);
  const validatorReport = toJson(validatorReportValue, 'validator_report');

  if (!proposal.ok) return proposal;
  if (!validatorReport.ok) return validatorReport;

  const common = baseWorkflowView(task, proposalValue, persistedAt);
  const view = WorkflowViewSchema.parse({
    ...common,
    task: { ...common.task, status: 'workflow_rejected' },
    workflow: {
      ...common.workflow,
      status: 'rejected',
      semanticHash: null,
      semanticSource: null,
      compilerVersion: null,
      graphHash: null,
      graph: null,
      validatorReport: validatorReportValue,
    },
  });

  return ok({
    view,
    artifacts: {
      analyzerVersion: proposalValue.analyzerVersion,
      proposal: proposal.value,
      validatorReport: validatorReport.value,
    },
  });
};

export class OperatorWorkflowService {
  public constructor(
    private readonly store: OperatorWorkflowStore,
    private readonly clock: Clock,
  ) {}

  public readActivity(
    taskReference: string,
    planningEpisodeId: string | null = null,
  ): Outcome<OperatorActivityResponse, OperatorServiceError> {
    const analyzerSession =
      planningEpisodeId === null
        ? ok(null)
        : this.store.readAnalyzerSessionForEpisode(taskReference, planningEpisodeId);
    if (!analyzerSession.ok) {
      return err({ kind: 'store_failure', error: analyzerSession.error });
    }

    const taskEvents = this.store.listStreamEventsAfter(0).filter((event) => {
      if (event.taskReference !== taskReference) return false;
      if (planningEpisodeId === null) return false;
      if (
        event.eventType !== 'WorkflowAnalyzed' &&
        event.eventType !== 'WorkflowPlanned' &&
        event.eventType !== 'WorkflowRejected'
      ) {
        return false;
      }
      return (
        isJsonRecord(event.payload) &&
        typeof event.payload.operationId === 'string' &&
        event.payload.operationId.startsWith(`${planningEpisodeId}:`)
      );
    });
    const entries = taskEvents.map((event) => {
      const source =
        event.eventType === 'WorkflowAnalyzed'
          ? ('agent' as const)
          : event.eventType === 'WorkflowPlanned' || event.eventType === 'WorkflowRejected'
            ? ('planner' as const)
            : ('kernel' as const);

      switch (event.eventType) {
        case 'IntakeAccepted':
          return {
            sequence: event.seq,
            occurredAt: event.occurredAt,
            source,
            level: 'info' as const,
            title: 'Intake accepted',
            detail: 'The task snapshot passed the intake boundary.',
          };
        case 'TaskCreated':
          return {
            sequence: event.seq,
            occurredAt: event.occurredAt,
            source,
            level: 'info' as const,
            title: 'Task created',
            detail: 'The task projection was created in the durable ledger transaction.',
          };
        case 'WorkflowAnalyzed': {
          const analysis = WorkflowAnalyzedEventPayloadSchema.safeParse(event.payload);
          return {
            sequence: event.seq,
            occurredAt: event.occurredAt,
            source,
            level: 'info' as const,
            title: 'Task and repository analyzed',
            detail: !analysis.success
              ? 'The provider proposal was persisted before deterministic validation.'
              : `Codex completed read-only analysis in ${String(Math.round(analysis.data.durationMs))} ms using ${String(analysis.data.usage.inputTokens + analysis.data.usage.outputTokens)} measured tokens.`,
          };
        }
        case 'WorkflowPlanned':
          return {
            sequence: event.seq,
            occurredAt: event.occurredAt,
            source,
            level: 'info' as const,
            title: 'Workflow compiled and persisted',
            detail: 'The deterministic validator accepted the proposed workflow graph.',
          };
        case 'WorkflowRejected': {
          const corrected = taskEvents.some(
            (candidate) => candidate.seq > event.seq && candidate.eventType === 'WorkflowPlanned',
          );
          return {
            sequence: event.seq,
            occurredAt: event.occurredAt,
            source,
            level: corrected ? ('info' as const) : ('error' as const),
            title: corrected ? 'Workflow candidate corrected' : 'Workflow rejected',
            detail: corrected
              ? 'The validator rejected this candidate, and the planner produced a later valid workflow.'
              : 'The deterministic validator blocked the proposal before execution.',
          };
        }
        default:
          return {
            sequence: event.seq,
            occurredAt: event.occurredAt,
            source,
            level: 'info' as const,
            title: event.eventType,
            detail: 'A persisted ledger event was recorded for this task.',
          };
      }
    });

    return ok(
      OperatorActivityResponseSchema.parse({
        taskReference: taskReference,
        providerSession:
          analyzerSession.value ?? ({ status: 'not_started', reason: 'planning_only' } as const),
        entries,
      }),
    );
  }

  public listStreamEventsAfter(sequence: number): readonly OperatorStreamEvent[] {
    return this.store.listStreamEventsAfter(sequence).map((event) =>
      OperatorStreamEventSchema.parse({
        sequence: event.seq,
        taskReference: event.taskReference,
        eventType: event.eventType,
      }),
    );
  }

  public readLatestStreamSequence(): number {
    return this.store.readLatestStreamSequence();
  }

  public readPlanningOperation(
    taskReference: string,
    operationId: string,
  ): Outcome<WorkflowResponse | null, OperatorServiceError> {
    const stored = this.store.readPlanningOperation(taskReference, operationId);
    if (!stored.ok) return err({ kind: 'store_failure', error: stored.error });
    return stored.value === null
      ? ok(null)
      : ok(
          WorkflowResponseSchema.parse({
            status: stored.value.workflow.status === 'valid' ? 'ready' : 'rejected',
            view: stored.value,
          }),
        );
  }

  public readGenerationSubject(
    taskReference: string,
  ): Outcome<WorkflowGenerationSubject | null, OperatorServiceError> {
    const subject = this.store.readGenerationSubject(taskReference);
    return subject.ok ? subject : err({ kind: 'store_failure', error: subject.error });
  }

  public saveGenerationSubject(
    taskReference: string,
    subject: WorkflowGenerationSubject,
  ): Outcome<WorkflowGenerationSubject, OperatorServiceError> {
    const saved = this.store.saveGenerationSubject(taskReference, subject);
    return saved.ok ? ok(saved.value.subject) : err({ kind: 'store_failure', error: saved.error });
  }

  public readRunGenerationSubject(
    taskReference: string,
    workflowRunId: string,
  ): Outcome<WorkflowGenerationSubject | null, OperatorServiceError> {
    const subject = this.store.readRunGenerationSubject(taskReference, workflowRunId);
    return subject.ok ? subject : err({ kind: 'store_failure', error: subject.error });
  }

  public captureRunGenerationSubject(
    taskReference: string,
    workflowRunId: string,
    subject: WorkflowGenerationSubject,
  ): Outcome<WorkflowGenerationSubject, OperatorServiceError> {
    const saved = this.store.captureRunGenerationSubject(taskReference, workflowRunId, subject);
    return saved.ok ? ok(saved.value.subject) : err({ kind: 'store_failure', error: saved.error });
  }

  public assembleFromAnalyzerOutputAtOperation(
    task: PlanningTaskSnapshot,
    output: WorkflowAnalyzerOutput,
    receipt: WorkflowAnalyzerReceipt,
    operationId: string,
  ): Outcome<WorkflowResponse, OperatorServiceError> {
    const completed = this.readPlanningOperation(task.reference, operationId);
    if (!completed.ok) return completed;
    if (completed.value !== null) return ok(completed.value);

    const proposal = createWorkflowProposalFromAnalyzerOutput(
      task,
      receipt.analyzerVersion,
      output,
    );
    if (!proposal.ok) {
      return err({
        kind: 'planner_contract_failure',
        stage: 'proposal',
      });
    }

    return this.persistPlanning(task, planWorkflowProposal(proposal.value), operationId, receipt);
  }

  public assembleFromImplementationPlanAtOperation(
    task: PlanningTaskSnapshot,
    decision: ReadyImplementationPlanningDecision,
    scaffold: MaterializedImplementationPlanScaffold,
    operationId: string,
  ): Outcome<WorkflowResponse, OperatorServiceError> {
    const completed = this.readPlanningOperation(task.reference, operationId);
    if (!completed.ok) return completed;
    if (completed.value !== null) return ok(completed.value);

    const proposal = createWorkflowProposalFromAnalyzerOutput(task, 'implementation-planner@4', {
      assemblyDecisions: [
        {
          id: 'deterministic-deliver-pr-scaffold',
          title: 'Deterministic deliver-pr scaffold',
          source: decision.archetype,
          reason: decision.rationale,
          effect: decision.rationale,
        },
      ],
      source: scaffold.source,
      verificationPlan: decision.verification,
    });
    if (!proposal.ok) {
      throw new Error(
        `Internal deliver-pr scaffold invariant violated: ${proposal.error.issues.map(({ message }) => message).join('; ')}`,
      );
    }

    return this.persistPlanning(
      task,
      planWorkflowProposal(proposal.value, { internalInvariant: 'deliver-pr scaffold' }),
      operationId,
    );
  }

  public reviseFromAnalyzerOutputForTask(
    task: PlanningTaskSnapshot,
    output: WorkflowAnalyzerOutput,
    receipt: WorkflowAnalyzerReceipt,
    operationId: string,
  ): Outcome<WorkflowResponse, OperatorServiceError> {
    const proposal = createWorkflowProposalFromAnalyzerOutput(
      task,
      receipt.analyzerVersion,
      output,
    );
    if (!proposal.ok) {
      return err({
        kind: 'planner_contract_failure',
        stage: 'proposal',
      });
    }

    return this.persistPlanning(task, planWorkflowProposal(proposal.value), operationId, receipt);
  }

  public assembleContinuationFromAnalyzerOutputAtOperation(
    task: PlanningTaskSnapshot,
    output: WorkflowAnalyzerOutput,
    receipt: WorkflowAnalyzerReceipt,
    operationId: string,
  ): Outcome<WorkflowResponse, OperatorServiceError> {
    const completed = this.readPlanningOperation(task.reference, operationId);
    if (!completed.ok) return completed;
    if (completed.value !== null) return ok(completed.value);

    const proposal = createWorkflowProposalFromAnalyzerOutput(
      task,
      receipt.analyzerVersion,
      output,
    );
    if (!proposal.ok) {
      return err({
        kind: 'planner_contract_failure',
        stage: 'proposal',
      });
    }

    return this.persistPlanning(task, planWorkflowProposal(proposal.value), operationId, receipt);
  }

  private persistPlanning(
    task: PlanningTaskSnapshot,
    planning: ReturnType<typeof planWorkflowProposal>,
    operationId: string,
    receipt?: WorkflowAnalyzerReceipt,
  ): Outcome<WorkflowResponse, OperatorServiceError> {
    const built = planning.ok
      ? buildAcceptedView(task, planning.value, this.clock.now())
      : buildRejectedView(task, planning.error, this.clock.now());

    if (!built.ok) return built;

    const saved = this.store.save(built.value.view, built.value.artifacts, operationId, receipt);
    if (!saved.ok) {
      return err({ kind: 'store_failure', error: saved.error });
    }

    return ok(
      WorkflowResponseSchema.parse({
        status: saved.value.view.workflow.status === 'valid' ? 'ready' : 'rejected',
        view: saved.value.view,
      }),
    );
  }
}

export const createOperatorWorkflowService = (
  ledger: ConstructorParameters<typeof OperatorWorkflowStore>[0],
  clock: Clock,
): OperatorWorkflowService =>
  new OperatorWorkflowService(new OperatorWorkflowStore(ledger, clock), clock);
