import type { EventRecord, JsonValue, LedgerConflict } from '../ledger/types.js';
import type { LedgerRepository } from '../ledger/repository.js';
import {
  createWorkflowAnalyzerContext,
  TaskFixtureSchema,
  type TaskFixture,
} from '../planning/index.js';
import type { RepositoryCatalog, RepositoryResolution } from '../repositories/catalog.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { CompiledWorkflowSchema, JsonValueSchema } from '../workflow/index.js';
import {
  OperatorActivityEntrySchema,
  OperatorStreamEventSchema,
  type OperatorActivityResponse,
  type OperatorStreamEvent,
  type OperatorTaskSummary,
  type WorkflowResponse,
} from './m1-contracts.js';
import type { ImplementationPlanningRecord } from './implementation-planning-contracts.js';
import type { M1ServiceError, M1WorkflowService } from './m1-service.js';
import type {
  WorkflowAnalyzer,
  WorkflowContextDiscovery,
  WorkflowGenerationSubject,
  WorkflowGenerationSubjectSource,
} from './workflow-generator.js';
import { ContextDiscoveryService, EvidenceBundleStore } from './evidence-bundle.js';
import {
  WorkflowContinuationIssueSchema,
  WorkflowContinuationRecordSchema,
  WorkflowContinuationReviewCommandSchema,
  type WorkflowContinuationIssue,
  type WorkflowContinuationRecord,
  type WorkflowContinuationReviewCommand,
} from './workflow-continuation-contracts.js';

export * from './workflow-continuation-contracts.js';

export const WORKFLOW_CONTINUATION_PROJECTION = 'workflow_continuation_by_parent';

type WorkflowChangePlanningRecord = Pick<
  Extract<ImplementationPlanningRecord, { readonly status: 'workflow_change_required' }>,
  'artifactId' | 'attempt' | 'decision'
>;

type WorkflowContinuationStoreError =
  | { readonly kind: 'ledger_conflict'; readonly conflict: LedgerConflict }
  | {
      readonly kind: 'projection_corrupt';
      readonly parentTaskReference: string;
      readonly issues: readonly string[];
    }
  | { readonly kind: 'continuation_not_reviewable'; readonly parentTaskReference: string }
  | { readonly kind: 'continuation_not_linkable'; readonly parentTaskReference: string }
  | { readonly kind: 'continuation_not_resolvable'; readonly parentTaskReference: string }
  | { readonly kind: 'continuation_not_retryable'; readonly parentTaskReference: string };

export type WorkflowContinuationError =
  | { readonly kind: 'store'; readonly error: WorkflowContinuationStoreError }
  | { readonly kind: 'subject'; readonly error: M1ServiceError }
  | { readonly kind: 'parent_workflow_not_ready'; readonly parentTaskReference: string };

const aggregateIdFor = (parentTaskReference: string): string =>
  `workflow-continuation:${parentTaskReference}`;

const asJson = (input: unknown): JsonValue => JsonValueSchema.parse(input);

class WorkflowContinuationStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public read(
    parentTaskReference: string,
  ): Outcome<WorkflowContinuationRecord | null, WorkflowContinuationStoreError> {
    const projection = this.ledger.readProjection(
      WORKFLOW_CONTINUATION_PROJECTION,
      parentTaskReference,
    );
    if (projection === null) return ok(null);
    const parsed = WorkflowContinuationRecordSchema.safeParse(projection.payload);
    return parsed.success
      ? ok(parsed.data)
      : err({
          kind: 'projection_corrupt',
          parentTaskReference,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
  }

  public listEvents(parentTaskReference?: string): readonly EventRecord[] {
    return parentTaskReference === undefined
      ? this.ledger
          .listEvents()
          .filter((event) => event.aggregateId.startsWith('workflow-continuation:'))
      : this.ledger.listEvents(aggregateIdFor(parentTaskReference));
  }

  public save(
    record: WorkflowContinuationRecord,
    eventType: string,
  ): Outcome<WorkflowContinuationRecord, WorkflowContinuationStoreError> {
    const aggregateId = aggregateIdFor(record.parent.taskReference);
    const expectedVersion = this.ledger.readAggregateHead(aggregateId)?.version ?? 0;
    const result = this.ledger.transact({
      aggregate: {
        aggregateId,
        expectedVersion,
        events: [
          {
            eventId: `event:${aggregateId}:${String(expectedVersion + 1)}`,
            eventType,
            eventSchemaVersion: 1,
            payload: asJson({
              parentTaskReference: record.parent.taskReference,
              continuationId: record.continuationId,
              attempt: record.attempt,
              status: record.status,
              ...('candidate' in record
                ? {
                    candidateTaskReference: record.candidate.taskReference,
                    graphHash: record.candidate.graphHash,
                  }
                : {}),
            }),
            actor:
              eventType === 'WorkflowContinuationAccepted' ||
              eventType === 'WorkflowContinuationRejectedByOperator'
                ? 'operator'
                : 'workflow_continuation_planner',
          },
        ],
      },
      projections: [
        {
          kind: 'upsert',
          projectionType: WORKFLOW_CONTINUATION_PROJECTION,
          projectionId: record.parent.taskReference,
          payload: asJson(record),
        },
      ],
      artifacts: [
        {
          artifactId: `continuation-link:${record.continuationId}:version-${String(expectedVersion + 1)}`,
          artifactKind: 'workflow_continuation_link',
          storageUri: `ledger://artifacts/continuation-link:${record.continuationId}:version-${String(expectedVersion + 1)}`,
          payload: asJson(record),
          metadata: asJson({
            parentTaskReference: record.parent.taskReference,
            parentGraphHash: record.parent.graphHash,
            sourceArtifactId: record.source.artifactId,
          }),
          createdAt: this.clock.now(),
        },
      ],
      timestamp: this.clock.now(),
    });
    return result.ok ? ok(record) : err({ kind: 'ledger_conflict', conflict: result.error });
  }

  public review(
    parentTaskReference: string,
    command: WorkflowContinuationReviewCommand,
  ): Outcome<WorkflowContinuationRecord, WorkflowContinuationStoreError> {
    const current = this.read(parentTaskReference);
    if (!current.ok) return current;
    if (current.value !== null && current.value.continuationId !== command.continuationId) {
      return ok(current.value);
    }
    if (
      (current.value?.status === 'accepted' || current.value?.status === 'linked') &&
      command.decision === 'accept'
    ) {
      return ok(current.value);
    }
    if (
      current.value?.status === 'rejected_by_operator' &&
      command.decision === 'reject' &&
      current.value.guidance === command.guidance
    ) {
      return ok(current.value);
    }
    if (current.value?.status !== 'awaiting_review') {
      return err({ kind: 'continuation_not_reviewable', parentTaskReference });
    }
    const reviewedAt = this.clock.now();
    const reviewed = WorkflowContinuationRecordSchema.parse(
      command.decision === 'accept'
        ? { ...current.value, status: 'accepted', reviewedAt }
        : {
            ...current.value,
            status: 'rejected_by_operator',
            reviewedAt,
            guidance: command.guidance,
          },
    );
    return this.save(
      reviewed,
      command.decision === 'accept'
        ? 'WorkflowContinuationAccepted'
        : 'WorkflowContinuationRejectedByOperator',
    );
  }

  public linkExecution(
    parentTaskReference: string,
    child: { readonly taskReference: string; readonly runId: string },
  ): Outcome<WorkflowContinuationRecord, WorkflowContinuationStoreError> {
    const current = this.read(parentTaskReference);
    if (!current.ok) return current;
    if (
      current.value?.status === 'linked' &&
      current.value.child.taskReference === child.taskReference &&
      current.value.child.runId === child.runId
    ) {
      return ok(current.value);
    }
    if (
      current.value?.status !== 'accepted' ||
      current.value.candidate.taskReference !== child.taskReference
    ) {
      return err({ kind: 'continuation_not_linkable', parentTaskReference });
    }
    const linked = WorkflowContinuationRecordSchema.parse({
      ...current.value,
      status: 'linked',
      linkedAt: this.clock.now(),
      child,
    });
    return this.save(linked, 'WorkflowContinuationExecutionLinked');
  }

  public supersedeWithPlan(
    parentTaskReference: string,
    implementationPlanArtifactId: string,
  ): Outcome<WorkflowContinuationRecord, WorkflowContinuationStoreError> {
    const current = this.read(parentTaskReference);
    if (!current.ok) return current;
    if (
      current.value?.status === 'superseded_by_plan' &&
      current.value.implementationPlanArtifactId === implementationPlanArtifactId
    ) {
      return ok(current.value);
    }
    if (current.value?.status !== 'rejected_by_operator') {
      return err({ kind: 'continuation_not_resolvable', parentTaskReference });
    }
    const superseded = WorkflowContinuationRecordSchema.parse({
      ...current.value,
      status: 'superseded_by_plan',
      resolvedAt: this.clock.now(),
      implementationPlanArtifactId,
    });
    return this.save(superseded, 'WorkflowContinuationSupersededByPlan');
  }
}

const continuationTaskReference = (parentTaskReference: string, attempt: number): string => {
  const normalized = parentTaskReference
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
  return `continuation-${normalized}-${String(attempt)}`;
};

const targetRepositoryFor = (subject: WorkflowGenerationSubject): string =>
  subject.task.family === 'shared_component'
    ? subject.task.componentRepository
    : subject.task.repository;

const qualifiedAlias = (resolution: Extract<RepositoryResolution, { readonly status: 'found' }>) =>
  resolution.repository.aliases.find((alias) => alias.includes('/')) ?? null;

const continuationFixture = (
  subject: WorkflowGenerationSubject,
  fixtureId: string,
  repositoryReference: string,
  reason: string,
): TaskFixture => {
  const common = {
    ...subject.task,
    fixtureId,
    title: `Continuation: ${subject.task.title}`,
    description: `${subject.task.description}\n\nWorkflow continuation: ${reason}`,
  };
  return TaskFixtureSchema.parse(
    subject.task.family === 'shared_component'
      ? { ...common, componentRepository: repositoryReference }
      : { ...common, repository: repositoryReference },
  );
};

const providerFailureIssue = (message: string) =>
  WorkflowContinuationIssueSchema.parse({ code: 'generation_failed', message, retryable: true });

const generationFailureMessage = (error: M1ServiceError): string => {
  switch (error.kind) {
    case 'fixture_not_found':
    case 'task_not_found':
      return `Continuation task was not available: ${error.kind}`;
    case 'generation_blocked':
      return error.reason;
    case 'planner_contract_failure':
      return `Continuation proposal failed at ${error.stage}`;
    case 'non_json_artifact':
      return `Continuation produced non-JSON ${error.artifact}`;
    case 'store_failure':
      return `Continuation store failed: ${error.error.kind}`;
    case 'provider_failure':
      return `Continuation analyzer failed: ${error.failure.kind}`;
  }
};

export class WorkflowContinuationCoordinator {
  public constructor(
    private readonly store: WorkflowContinuationStore,
    private readonly clock: Clock,
    private readonly workflows: M1WorkflowService,
    private readonly subjects: WorkflowGenerationSubjectSource,
    private readonly analyzer: WorkflowAnalyzer | undefined,
    private readonly repositories: RepositoryCatalog | undefined,
    private readonly contextDiscovery: WorkflowContextDiscovery,
  ) {}

  public read(
    parentTaskReference: string,
  ): Outcome<WorkflowContinuationRecord | null, WorkflowContinuationError> {
    const record = this.store.read(parentTaskReference);
    return record.ok ? record : err({ kind: 'store', error: record.error });
  }

  public async proposeFromPlanning(
    parentTaskReference: string,
    parentRunId: string,
    planning: WorkflowChangePlanningRecord,
    options: { readonly retry?: boolean } = {},
  ): Promise<Outcome<WorkflowContinuationRecord, WorkflowContinuationError>> {
    const current = this.store.read(parentTaskReference);
    if (!current.ok) return err({ kind: 'store', error: current.error });
    if (current.value?.source.artifactId === planning.artifactId && options.retry !== true) {
      return ok(current.value);
    }

    const parentWorkflow = this.workflows.read(parentTaskReference);
    if (!parentWorkflow.ok) return err({ kind: 'subject', error: parentWorkflow.error });
    if (parentWorkflow.value?.status !== 'ready') {
      return err({ kind: 'parent_workflow_not_ready', parentTaskReference });
    }
    const parentGraph = CompiledWorkflowSchema.parse(parentWorkflow.value.view.workflow.graph);
    const subject = this.subjects.resolve(parentTaskReference);
    if (!subject.ok) return err({ kind: 'subject', error: subject.error });

    const attempt = (current.value?.attempt ?? 0) + 1;
    const continuationId = `${parentRunId}:continuation-${String(attempt)}`;
    const candidateTaskReference = continuationTaskReference(parentTaskReference, attempt);
    const base = {
      schemaVersion: 1 as const,
      continuationId,
      attempt,
      parent: {
        taskReference: parentTaskReference,
        runId: parentRunId,
        workflowId: parentGraph.metadata.workflowId,
        graphHash: parentWorkflow.value.view.workflow.graphHash,
      },
      source: {
        kind: 'implementation_planning' as const,
        attempt: planning.attempt,
        artifactId: planning.artifactId,
        request: planning.decision.request,
      },
      reviewPolicy: 'review_all' as const,
      createdAt: this.clock.now(),
    };

    const discovered = [...new Set(planning.decision.request.discoveredRepositories)];
    if (discovered.length > 1) {
      return this.persistRecord(
        WorkflowContinuationRecordSchema.parse({
          ...base,
          status: 'invalid',
          candidateTaskReference: null,
          issues: [
            {
              code: 'multiple_repositories_unsupported',
              message:
                'The first-wave continuation can target only one newly discovered repository.',
              retryable: false,
            },
          ],
        }),
      );
    }

    const requestedRepository = discovered[0] ?? targetRepositoryFor(subject.value);
    const repository = await this.resolveRepository(subject.value, requestedRepository);
    if (repository.status === 'blocked') {
      return this.persistRecord(
        WorkflowContinuationRecordSchema.parse({
          ...base,
          status: 'blocked',
          repositoryReference: requestedRepository,
          issues: [repository.issue],
        }),
      );
    }

    const fixture = continuationFixture(
      subject.value,
      candidateTaskReference,
      repository.reference,
      planning.decision.request.reason,
    );
    const taskSnapshot = JsonValueSchema.parse({
      origin: 'workflow_continuation',
      parentTaskSnapshot: subject.value.taskSnapshot,
      parentWorkflow: {
        workflowId: parentGraph.metadata.workflowId,
        graphHash: parentWorkflow.value.view.workflow.graphHash,
      },
      workflowChange: planning.decision.request,
      targetRepository: repository.reference,
    });
    const savedSubject = this.workflows.saveGenerationSubject(candidateTaskReference, {
      schemaVersion: 1,
      repositoryPath: repository.path,
      task: fixture,
      taskSnapshot,
    });
    if (!savedSubject.ok) {
      return this.persistRecord(
        WorkflowContinuationRecordSchema.parse({
          ...base,
          status: 'failed',
          issues: [providerFailureIssue(generationFailureMessage(savedSubject.error))],
        }),
      );
    }
    const generated = await this.generateContinuation(fixture, repository.path, taskSnapshot);
    if (!generated.ok) {
      return this.persistRecord(
        WorkflowContinuationRecordSchema.parse({
          ...base,
          status: 'failed',
          issues: [providerFailureIssue(generationFailureMessage(generated.error))],
        }),
      );
    }

    const issues = this.validateCandidate(
      generated.value,
      parentWorkflow.value,
      repository.reference,
      planning.decision.request.requiredCapabilities,
    );
    if (generated.value.status !== 'ready' || issues.length > 0) {
      return this.persistRecord(
        WorkflowContinuationRecordSchema.parse({
          ...base,
          status: 'invalid',
          candidateTaskReference,
          issues:
            issues.length > 0
              ? issues
              : [
                  {
                    code: 'candidate_rejected',
                    message: 'The continuation candidate failed deterministic workflow validation.',
                    retryable: false,
                  },
                ],
        }),
      );
    }

    const graph = CompiledWorkflowSchema.parse(generated.value.view.workflow.graph);
    return this.persistRecord(
      WorkflowContinuationRecordSchema.parse({
        ...base,
        status: 'awaiting_review',
        candidate: {
          taskReference: candidateTaskReference,
          repositoryReference: repository.reference,
          workflowId: graph.metadata.workflowId,
          graphHash: generated.value.view.workflow.graphHash,
        },
      }),
    );
  }

  public review(
    parentTaskReference: string,
    commandInput: WorkflowContinuationReviewCommand,
  ): Outcome<WorkflowContinuationRecord, WorkflowContinuationError> {
    const command = WorkflowContinuationReviewCommandSchema.parse(commandInput);
    const reviewed = this.store.review(parentTaskReference, command);
    return reviewed.ok ? reviewed : err({ kind: 'store', error: reviewed.error });
  }

  public linkExecution(
    parentTaskReference: string,
    child: { readonly taskReference: string; readonly runId: string },
  ): Outcome<WorkflowContinuationRecord, WorkflowContinuationError> {
    const linked = this.store.linkExecution(parentTaskReference, child);
    return linked.ok ? linked : err({ kind: 'store', error: linked.error });
  }

  public supersedeWithPlan(
    parentTaskReference: string,
    implementationPlanArtifactId: string,
  ): Outcome<WorkflowContinuationRecord, WorkflowContinuationError> {
    const superseded = this.store.supersedeWithPlan(
      parentTaskReference,
      implementationPlanArtifactId,
    );
    return superseded.ok ? superseded : err({ kind: 'store', error: superseded.error });
  }

  public async retry(
    parentTaskReference: string,
  ): Promise<Outcome<WorkflowContinuationRecord, WorkflowContinuationError>> {
    const current = this.store.read(parentTaskReference);
    if (!current.ok) return err({ kind: 'store', error: current.error });
    if (
      current.value === null ||
      (current.value.status !== 'blocked' && current.value.status !== 'failed') ||
      !current.value.issues.some((issue) => issue.retryable)
    ) {
      return err({
        kind: 'store',
        error: { kind: 'continuation_not_retryable', parentTaskReference },
      });
    }
    const planning: WorkflowChangePlanningRecord = {
      attempt: current.value.source.attempt,
      artifactId: current.value.source.artifactId,
      decision: {
        status: 'workflow_change_required' as const,
        request: current.value.source.request,
      },
    };
    return this.proposeFromPlanning(parentTaskReference, current.value.parent.runId, planning, {
      retry: true,
    });
  }

  public decorateTask(task: OperatorTaskSummary): OperatorTaskSummary {
    const continuation = this.store.read(task.id);
    if (!continuation.ok || continuation.value === null) return task;
    const record = continuation.value;
    switch (record.status) {
      case 'awaiting_review':
        return {
          ...task,
          status: 'needs_attention',
          attention: 'operator',
          currentStage: 'Review workflow continuation',
          updatedAt: record.createdAt,
        };
      case 'accepted':
        return {
          ...task,
          status: 'waiting',
          attention: 'none',
          currentStage: 'Continuation accepted · linked execution pending',
          updatedAt: record.reviewedAt,
        };
      case 'linked':
        return {
          ...task,
          status: 'waiting',
          attention: 'none',
          currentStage: 'Linked continuation executing',
          updatedAt: record.linkedAt,
        };
      case 'rejected_by_operator':
        return {
          ...task,
          status: 'needs_attention',
          attention: 'operator',
          currentStage: 'Continuation rejected by operator',
          updatedAt: record.reviewedAt,
        };
      case 'superseded_by_plan':
        return task;
      case 'blocked':
        return {
          ...task,
          status: 'needs_attention',
          attention: 'operator',
          currentStage: `Continuation blocked · ${record.issues[0]?.code ?? 'repository'}`,
          updatedAt: record.createdAt,
        };
      case 'invalid':
        return {
          ...task,
          status: 'needs_attention',
          attention: 'operator',
          currentStage: 'Continuation validation failed',
          updatedAt: record.createdAt,
        };
      case 'failed':
        return {
          ...task,
          status: 'needs_attention',
          attention: 'operator',
          currentStage: 'Continuation generation failed',
          updatedAt: record.createdAt,
        };
    }
  }

  public readActivity(parentTaskReference: string): OperatorActivityResponse['entries'] {
    return this.store.listEvents(parentTaskReference).map((event) => {
      const common = {
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        source: 'planner' as const,
        level: 'info' as const,
      };
      switch (event.eventType) {
        case 'WorkflowContinuationProposed':
          return OperatorActivityEntrySchema.parse({
            ...common,
            title: 'Workflow continuation ready for review',
            detail:
              'A linked immutable graph passed deterministic validation; the parent run remains paused.',
          });
        case 'WorkflowContinuationBlocked':
          return OperatorActivityEntrySchema.parse({
            ...common,
            level: 'warning',
            title: 'Workflow continuation blocked',
            detail:
              'The required repository could not be resolved; the parent run and evidence were preserved.',
          });
        case 'WorkflowContinuationInvalid':
          return OperatorActivityEntrySchema.parse({
            ...common,
            level: 'error',
            title: 'Workflow continuation rejected by validator',
            detail: 'The candidate cannot replace or mutate the accepted parent graph.',
          });
        case 'WorkflowContinuationFailed':
          return OperatorActivityEntrySchema.parse({
            ...common,
            level: 'warning',
            title: 'Workflow continuation generation failed',
            detail: 'The failure is durable and the parent run can be retried without restarting.',
          });
        case 'WorkflowContinuationAccepted':
          return OperatorActivityEntrySchema.parse({
            ...common,
            source: 'operator',
            title: 'Workflow continuation accepted',
            detail: 'The immutable candidate is approved for a linked execution handoff.',
          });
        case 'WorkflowContinuationExecutionLinked':
          return OperatorActivityEntrySchema.parse({
            ...common,
            title: 'Workflow continuation execution linked',
            detail:
              'The accepted candidate now has a durable child run scheduled under the parent task.',
          });
        case 'WorkflowContinuationRejectedByOperator':
          return OperatorActivityEntrySchema.parse({
            ...common,
            source: 'operator',
            level: 'warning',
            title: 'Workflow continuation rejected by operator',
            detail:
              'The parent run remains recoverably blocked with the reviewed candidate preserved.',
          });
        case 'WorkflowContinuationSupersededByPlan':
          return OperatorActivityEntrySchema.parse({
            ...common,
            title: 'Workflow continuation replaced by revised plan',
            detail:
              'Operator guidance produced a parent implementation plan, so the linked candidate remains preserved but will not execute.',
          });
        default:
          throw new Error(`Unmapped workflow continuation event: ${event.eventType}`);
      }
    });
  }

  public listStreamEventsAfter(sequence: number): readonly OperatorStreamEvent[] {
    return this.store
      .listEvents()
      .filter((event) => event.sequence > sequence)
      .map((event) =>
        OperatorStreamEventSchema.parse({
          sequence: event.sequence,
          fixtureId: event.aggregateId.slice('workflow-continuation:'.length),
          eventType: event.eventType,
        }),
      );
  }

  private persistRecord(
    record: WorkflowContinuationRecord,
  ): Outcome<WorkflowContinuationRecord, WorkflowContinuationError> {
    const eventType =
      record.status === 'awaiting_review'
        ? 'WorkflowContinuationProposed'
        : record.status === 'blocked'
          ? 'WorkflowContinuationBlocked'
          : record.status === 'failed'
            ? 'WorkflowContinuationFailed'
            : 'WorkflowContinuationInvalid';
    const saved = this.store.save(record, eventType);
    return saved.ok ? saved : err({ kind: 'store', error: saved.error });
  }

  private async resolveRepository(
    subject: WorkflowGenerationSubject,
    requestedReference: string,
  ): Promise<
    | { readonly status: 'ready'; readonly reference: string; readonly path: string }
    | { readonly status: 'blocked'; readonly issue: WorkflowContinuationIssue }
  > {
    if (requestedReference === targetRepositoryFor(subject)) {
      return {
        status: 'ready',
        reference: requestedReference,
        path: subject.repositoryPath,
      };
    }
    if (this.repositories === undefined) {
      return {
        status: 'blocked',
        issue: WorkflowContinuationIssueSchema.parse({
          code: 'repository_catalog_unavailable',
          message: `No managed repository catalog can resolve ${requestedReference}.`,
          retryable: true,
        }),
      };
    }
    const resolution = await this.repositories.resolve(requestedReference);
    switch (resolution.status) {
      case 'found': {
        const reference = qualifiedAlias(resolution);
        return reference === null
          ? {
              status: 'blocked',
              issue: WorkflowContinuationIssueSchema.parse({
                code: 'repository_not_found',
                message: `Repository ${requestedReference} has no qualified project/repository alias.`,
                retryable: false,
              }),
            }
          : {
              status: 'ready',
              reference,
              path: resolution.repository.checkout.path,
            };
      }
      case 'not_found':
        return {
          status: 'blocked',
          issue: WorkflowContinuationIssueSchema.parse({
            code: 'repository_not_found',
            message: `Repository ${requestedReference} was not found.`,
            retryable: false,
          }),
        };
      case 'ambiguous':
        return {
          status: 'blocked',
          issue: WorkflowContinuationIssueSchema.parse({
            code: 'repository_ambiguous',
            message: `Repository ${requestedReference} resolves to multiple candidates.`,
            retryable: false,
          }),
        };
      case 'unavailable':
        return {
          status: 'blocked',
          issue: WorkflowContinuationIssueSchema.parse({
            code: 'repository_unavailable',
            message: resolution.problem.message,
            retryable: resolution.problem.retryable,
          }),
        };
    }
  }

  private async generateContinuation(
    fixture: TaskFixture,
    repositoryPath: string,
    taskSnapshot: JsonValue,
  ): Promise<Outcome<WorkflowResponse, M1ServiceError>> {
    const analyzerContext = createWorkflowAnalyzerContext(fixture, taskSnapshot);
    const evidence = await this.contextDiscovery.discover({
      taskReference: fixture.fixtureId,
      taskSnapshot,
      plannerContext: analyzerContext.plannerContext,
      repositoryReference: fixture.repository,
      repositoryPath,
    });
    if (!evidence.ok) {
      return err({
        kind: 'generation_blocked',
        taskReference: fixture.fixtureId,
        reason: `Continuation context discovery failed: ${evidence.error.kind}`,
      });
    }
    if (this.analyzer === undefined) return this.workflows.generateContinuationTask(fixture);
    const analyzed = await this.analyzer.analyze({
      ...analyzerContext,
      repositoryPath,
      evidenceBundle: evidence.value.bundle,
    });
    return analyzed.ok
      ? this.workflows.generateContinuationFromAnalyzerOutput(
          fixture,
          analyzed.value.output,
          analyzed.value.receipt,
        )
      : err({ kind: 'provider_failure', provider: 'codex_cli', failure: analyzed.error });
  }

  private validateCandidate(
    candidate: WorkflowResponse,
    parent: Extract<WorkflowResponse, { readonly status: 'ready' }>,
    repositoryReference: string,
    requiredCapabilities: readonly string[],
  ): readonly WorkflowContinuationIssue[] {
    if (candidate.status !== 'ready') {
      return [
        WorkflowContinuationIssueSchema.parse({
          code: 'candidate_rejected',
          message: candidate.view.workflow.validatorReport.issues
            .map((issue) => issue.message)
            .join('; '),
          retryable: false,
        }),
      ];
    }
    const issues: WorkflowContinuationIssue[] = [];
    if (candidate.view.workflow.graphHash === parent.view.workflow.graphHash) {
      issues.push(
        WorkflowContinuationIssueSchema.parse({
          code: 'candidate_matches_parent',
          message:
            'The candidate graph is identical to the parent and does not represent the requested change.',
          retryable: false,
        }),
      );
    }
    if (!JSON.stringify(candidate.view.workflow.graph).includes(repositoryReference)) {
      issues.push(
        WorkflowContinuationIssueSchema.parse({
          code: 'repository_not_represented',
          message: `The candidate graph does not reference ${repositoryReference}.`,
          retryable: false,
        }),
      );
    }
    const represented = new Set(candidate.view.workflow.capabilities.required);
    for (const capability of requiredCapabilities) {
      if (!represented.has(capability)) {
        issues.push(
          WorkflowContinuationIssueSchema.parse({
            code: 'capability_not_represented',
            message: `The candidate graph does not require ${capability}.`,
            retryable: false,
          }),
        );
      }
    }
    return issues;
  }
}

export const createWorkflowContinuationCoordinator = (input: {
  readonly ledger: LedgerRepository;
  readonly clock: Clock;
  readonly workflows: M1WorkflowService;
  readonly subjects: WorkflowGenerationSubjectSource;
  readonly analyzer?: WorkflowAnalyzer;
  readonly repositories?: RepositoryCatalog;
  readonly contextDiscovery?: WorkflowContextDiscovery;
}): WorkflowContinuationCoordinator =>
  new WorkflowContinuationCoordinator(
    new WorkflowContinuationStore(input.ledger, input.clock),
    input.clock,
    input.workflows,
    input.subjects,
    input.analyzer,
    input.repositories,
    input.contextDiscovery ??
      new ContextDiscoveryService(new EvidenceBundleStore(input.ledger, input.clock), input.clock),
  );
