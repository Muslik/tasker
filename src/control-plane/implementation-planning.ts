import { z } from 'zod';

import type { EventRecord, JsonValue, LedgerConflict } from '../ledger/types.js';
import type { LedgerRepository } from '../ledger/repository.js';
import {
  ImplementationPlanningDecisionSchema,
  ImplementationPlanLinkSchema,
  PlanningStrategyRequestSchema,
  PlanningStrategySchema,
  type PlanningStrategy,
  type PlanningStrategyRequest,
  type ImplementationPlanLink,
} from '../planning/implementation-plan.js';
import type {
  ImplementationPlanner,
  ImplementationPlannerFailure,
} from '../providers/implementation-planner.js';
import { ImplementationPlannerReceiptSchema } from '../providers/contracts.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { JsonValueSchema } from '../workflow/schema.js';
import {
  OperatorActivityEntrySchema,
  OperatorStreamEventSchema,
  type OperatorActivityResponse,
  type OperatorStreamEvent,
  type OperatorTaskSummary,
} from './m1-contracts.js';
import type { M1ServiceError, M1WorkflowService } from './m1-service.js';
import type {
  WorkflowGenerationSubject,
  WorkflowGenerationSubjectSource,
} from './workflow-generator.js';

export const IMPLEMENTATION_PLAN_PROJECTION = 'implementation_plan_by_task';

const PlanningFailureViewSchema = z
  .object({
    kind: z.enum([
      'provider_unavailable',
      'provider_timed_out',
      'provider_failed',
      'invalid_event_stream',
      'invalid_planner_output',
    ]),
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

const PlanningRecordBaseSchema = z.object({
  schemaVersion: z.literal(1),
  taskReference: z.string().min(1),
  attempt: z.number().int().positive(),
  requestedStrategy: PlanningStrategyRequestSchema,
  selectedStrategy: PlanningStrategySchema,
  selectionReason: z.string().min(1),
  startedAt: z.iso.datetime(),
  operatorGuidance: z.string().min(1).max(10_000).nullable(),
});

export const ImplementationPlanningRecordSchema = z.discriminatedUnion('status', [
  PlanningRecordBaseSchema.extend({ status: z.literal('planning') }).strict(),
  PlanningRecordBaseSchema.extend({
    status: z.literal('ready'),
    completedAt: z.iso.datetime(),
    artifactId: z.string().min(1),
    decision: ImplementationPlanningDecisionSchema.and(z.object({ status: z.literal('ready') })),
    receipt: ImplementationPlannerReceiptSchema,
  }).strict(),
  PlanningRecordBaseSchema.extend({
    status: z.literal('needs_clarification'),
    completedAt: z.iso.datetime(),
    artifactId: z.string().min(1),
    decision: ImplementationPlanningDecisionSchema.and(
      z.object({ status: z.literal('needs_clarification') }),
    ),
    receipt: ImplementationPlannerReceiptSchema,
  }).strict(),
  PlanningRecordBaseSchema.extend({
    status: z.literal('workflow_change_required'),
    completedAt: z.iso.datetime(),
    artifactId: z.string().min(1),
    decision: ImplementationPlanningDecisionSchema.and(
      z.object({ status: z.literal('workflow_change_required') }),
    ),
    receipt: ImplementationPlannerReceiptSchema,
  }).strict(),
  PlanningRecordBaseSchema.extend({
    status: z.literal('failed'),
    completedAt: z.iso.datetime(),
    failure: PlanningFailureViewSchema,
  }).strict(),
]);

export type ImplementationPlanningRecord = z.infer<typeof ImplementationPlanningRecordSchema>;
export type ReadyImplementationPlanningRecord = Extract<
  ImplementationPlanningRecord,
  { readonly status: 'ready' }
>;

export type ImplementationPlanningStoreError =
  | { readonly kind: 'ledger_conflict'; readonly conflict: LedgerConflict }
  | {
      readonly kind: 'projection_corrupt';
      readonly taskReference: string;
      readonly issues: readonly string[];
    }
  | { readonly kind: 'planning_attempt_not_current'; readonly taskReference: string };

const asJson = (value: unknown): JsonValue => JsonValueSchema.parse(value);
const aggregateIdFor = (taskReference: string): string => `implementation-plan:${taskReference}`;

export class ImplementationPlanningStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public read(
    taskReference: string,
  ): Outcome<ImplementationPlanningRecord | null, ImplementationPlanningStoreError> {
    const projection = this.ledger.readProjection(IMPLEMENTATION_PLAN_PROJECTION, taskReference);
    if (projection === null) return ok(null);
    const parsed = ImplementationPlanningRecordSchema.safeParse(projection.payload);
    return parsed.success
      ? ok(parsed.data)
      : err({
          kind: 'projection_corrupt',
          taskReference,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
  }

  public listEvents(taskReference?: string): readonly EventRecord[] {
    return taskReference === undefined
      ? this.ledger
          .listEvents()
          .filter((event) => event.aggregateId.startsWith('implementation-plan:'))
      : this.ledger.listEvents(aggregateIdFor(taskReference));
  }

  public begin(input: {
    readonly taskReference: string;
    readonly requestedStrategy: PlanningStrategyRequest;
    readonly selectedStrategy: PlanningStrategy;
    readonly selectionReason: string;
    readonly operatorGuidance: string | null;
  }): Outcome<ImplementationPlanningRecord, ImplementationPlanningStoreError> {
    const current = this.read(input.taskReference);
    if (!current.ok) return current;
    const attempt = (current.value?.attempt ?? 0) + 1;
    const startedAt = this.clock.now();
    const record = ImplementationPlanningRecordSchema.parse({
      schemaVersion: 1,
      status: 'planning',
      taskReference: input.taskReference,
      attempt,
      requestedStrategy: input.requestedStrategy,
      selectedStrategy: input.selectedStrategy,
      selectionReason: input.selectionReason,
      startedAt,
      operatorGuidance: input.operatorGuidance,
    });
    return this.persist(record, 'ImplementationPlanningStarted', {
      taskReference: input.taskReference,
      attempt,
      requestedStrategy: input.requestedStrategy,
      selectedStrategy: input.selectedStrategy,
    });
  }

  public complete(
    planning: Extract<ImplementationPlanningRecord, { readonly status: 'planning' }>,
    result: Awaited<ReturnType<ImplementationPlanner['plan']>> & { readonly ok: true },
  ): Outcome<ImplementationPlanningRecord, ImplementationPlanningStoreError> {
    const current = this.read(planning.taskReference);
    if (!current.ok) return current;
    if (current.value?.status !== 'planning' || current.value.attempt !== planning.attempt) {
      return err({ kind: 'planning_attempt_not_current', taskReference: planning.taskReference });
    }
    const completedAt = this.clock.now();
    const artifactId = `implementation-plan:${planning.taskReference}:attempt-${String(planning.attempt)}`;
    const record = ImplementationPlanningRecordSchema.parse({
      ...planning,
      status: result.value.decision.status,
      completedAt,
      artifactId,
      decision: result.value.decision,
      receipt: result.value.receipt,
    });
    if (
      record.status !== 'ready' &&
      record.status !== 'needs_clarification' &&
      record.status !== 'workflow_change_required'
    ) {
      throw new Error('Planning completion did not produce a decision record');
    }
    const eventType =
      record.status === 'ready'
        ? 'ImplementationPlanReady'
        : record.status === 'needs_clarification'
          ? 'ImplementationPlanNeedsClarification'
          : 'ImplementationPlanWorkflowChangeRequired';
    return this.persist(
      record,
      eventType,
      {
        taskReference: planning.taskReference,
        attempt: planning.attempt,
        strategy: planning.selectedStrategy,
        artifactId,
      },
      {
        artifactId,
        artifactKind:
          record.status === 'ready'
            ? 'implementation_plan'
            : record.status === 'needs_clarification'
              ? 'planning_questions'
              : 'workflow_change_request',
        storageUri: `ledger://artifacts/${artifactId}`,
        payload: asJson(record.decision),
        metadata: asJson({
          taskReference: planning.taskReference,
          attempt: planning.attempt,
          strategy: planning.selectedStrategy,
          promptHash: result.value.receipt.promptHash,
        }),
        createdAt: completedAt,
      },
    );
  }

  public fail(
    planning: Extract<ImplementationPlanningRecord, { readonly status: 'planning' }>,
    failure: ImplementationPlannerFailure,
  ): Outcome<ImplementationPlanningRecord, ImplementationPlanningStoreError> {
    const current = this.read(planning.taskReference);
    if (!current.ok) return current;
    if (current.value?.status !== 'planning' || current.value.attempt !== planning.attempt) {
      return err({ kind: 'planning_attempt_not_current', taskReference: planning.taskReference });
    }
    const record = ImplementationPlanningRecordSchema.parse({
      ...planning,
      status: 'failed',
      completedAt: this.clock.now(),
      failure: planningFailureView(failure),
    });
    return this.persist(record, 'ImplementationPlanningFailed', {
      taskReference: planning.taskReference,
      attempt: planning.attempt,
      strategy: planning.selectedStrategy,
      failureKind: failure.kind,
    });
  }

  private persist(
    record: ImplementationPlanningRecord,
    eventType: string,
    payload: JsonValue,
    artifact?: {
      readonly artifactId: string;
      readonly artifactKind: string;
      readonly storageUri: string;
      readonly payload: JsonValue;
      readonly metadata: JsonValue;
      readonly createdAt: string;
    },
  ): Outcome<ImplementationPlanningRecord, ImplementationPlanningStoreError> {
    const aggregateId = aggregateIdFor(record.taskReference);
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
            payload,
            actor: eventType === 'ImplementationPlanningStarted' ? 'planner_router' : 'planner',
          },
        ],
      },
      projections: [
        {
          kind: 'upsert',
          projectionType: IMPLEMENTATION_PLAN_PROJECTION,
          projectionId: record.taskReference,
          payload: asJson(record),
        },
      ],
      ...(artifact === undefined ? {} : { artifacts: [artifact] }),
      timestamp: 'completedAt' in record ? record.completedAt : record.startedAt,
    });
    return result.ok ? ok(record) : err({ kind: 'ledger_conflict', conflict: result.error });
  }
}

const planningFailureView = (
  failure: ImplementationPlannerFailure,
): z.infer<typeof PlanningFailureViewSchema> => {
  switch (failure.kind) {
    case 'provider_unavailable':
      return { kind: failure.kind, message: failure.message, retryable: true };
    case 'provider_timed_out':
      return {
        kind: failure.kind,
        message: `Planner timed out after ${String(Math.round(failure.durationMs))} ms`,
        retryable: true,
      };
    case 'provider_failed':
      return { kind: failure.kind, message: failure.message, retryable: true };
    case 'invalid_event_stream':
      return { kind: failure.kind, message: failure.message, retryable: true };
    case 'invalid_planner_output':
      return { kind: failure.kind, message: failure.issues.join('; '), retryable: true };
  }
};

export type ImplementationPlanningError =
  | { readonly kind: 'subject'; readonly error: M1ServiceError }
  | { readonly kind: 'workflow_not_ready'; readonly taskReference: string }
  | { readonly kind: 'store'; readonly error: ImplementationPlanningStoreError };

const countWorkflowNodes = (value: JsonValue): number => {
  if (Array.isArray(value)) {
    return value.reduce<number>((total, child) => total + countWorkflowNodes(child), 0);
  }
  if (value === null || typeof value !== 'object') return 0;
  const ownNode = typeof value.kind === 'string' ? 1 : 0;
  return (
    ownNode +
    Object.values(value).reduce<number>((total, child) => total + countWorkflowNodes(child), 0)
  );
};

const selectStrategy = (
  requested: PlanningStrategyRequest,
  subject: WorkflowGenerationSubject,
  workflow: JsonValue,
): { readonly strategy: PlanningStrategy; readonly reason: string } => {
  if (requested !== 'auto') {
    return { strategy: requested, reason: `The operator explicitly selected ${requested}.` };
  }
  const nodeCount = countWorkflowNodes(workflow);
  if (subject.task.family === 'shared_component') {
    return {
      strategy: 'ralplan',
      reason: 'The task crosses repository/publication boundaries and requires consensus planning.',
    };
  }
  return {
    strategy: 'fast',
    reason: `The task stays in one repository and its compiled workflow has ${String(nodeCount)} bounded nodes.`,
  };
};

export class ImplementationPlanningCoordinator {
  private readonly inFlight = new Map<
    string,
    Promise<Outcome<ImplementationPlanningRecord, ImplementationPlanningError>>
  >();

  public constructor(
    private readonly store: ImplementationPlanningStore,
    private readonly workflows: M1WorkflowService,
    private readonly subjects: WorkflowGenerationSubjectSource,
    private readonly planner: ImplementationPlanner,
  ) {}

  public read(
    taskReference: string,
  ): Outcome<ImplementationPlanningRecord | null, ImplementationPlanningError> {
    const record = this.store.read(taskReference);
    return record.ok ? record : err({ kind: 'store', error: record.error });
  }

  public prepare(
    taskReference: string,
    requestedStrategy: PlanningStrategyRequest,
    operatorGuidance: string | null = null,
  ): Promise<Outcome<ImplementationPlanningRecord, ImplementationPlanningError>> {
    const current = this.inFlight.get(taskReference);
    if (current !== undefined) return current;
    const pending = this.prepareOnce(taskReference, requestedStrategy, operatorGuidance).finally(
      () => {
        this.inFlight.delete(taskReference);
      },
    );
    this.inFlight.set(taskReference, pending);
    return pending;
  }

  public link(record: ReadyImplementationPlanningRecord): ImplementationPlanLink {
    return ImplementationPlanLinkSchema.parse({
      artifactId: record.artifactId,
      attempt: record.attempt,
      requestedStrategy: record.requestedStrategy,
      selectedStrategy: record.selectedStrategy,
    });
  }

  public decorateTask(task: OperatorTaskSummary): OperatorTaskSummary {
    const planning = this.store.read(task.id);
    if (!planning.ok || planning.value === null) return task;
    const record = planning.value;
    if (record.status === 'planning') {
      return {
        ...task,
        status: 'running',
        attention: 'none',
        currentStage: `Planning · ${record.selectedStrategy}`,
        updatedAt: record.startedAt,
      };
    }
    if (record.status === 'failed') {
      return {
        ...task,
        status: 'needs_attention',
        attention: 'operator',
        currentStage: `Planning failed · ${record.failure.kind}`,
        updatedAt: record.completedAt,
      };
    }
    if (record.status === 'needs_clarification') {
      return {
        ...task,
        status: 'needs_attention',
        attention: 'operator',
        currentStage: 'Planning needs clarification',
        updatedAt: record.completedAt,
      };
    }
    if (record.status === 'workflow_change_required') {
      return {
        ...task,
        status: 'needs_attention',
        attention: 'operator',
        currentStage: 'Workflow change required',
        updatedAt: record.completedAt,
      };
    }
    return task;
  }

  public readActivity(taskReference: string): OperatorActivityResponse['entries'] {
    return this.store.listEvents(taskReference).map((event) => {
      const common = {
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        source: 'planner' as const,
        level: 'info' as const,
      };
      switch (event.eventType) {
        case 'ImplementationPlanningStarted':
          return OperatorActivityEntrySchema.parse({
            ...common,
            title: 'Implementation planning started',
            detail:
              'The selected subscription planner is inspecting the task and read-only repository.',
          });
        case 'ImplementationPlanReady':
          return OperatorActivityEntrySchema.parse({
            ...common,
            title: 'Implementation plan ready',
            detail: 'The typed plan and provider receipt were persisted before workflow execution.',
          });
        case 'ImplementationPlanNeedsClarification':
          return OperatorActivityEntrySchema.parse({
            ...common,
            level: 'warning',
            title: 'Planning needs clarification',
            detail: 'Execution is blocked until the operator answers the persisted questions.',
          });
        case 'ImplementationPlanWorkflowChangeRequired':
          return OperatorActivityEntrySchema.parse({
            ...common,
            level: 'warning',
            title: 'Workflow change required',
            detail: 'The grounded plan requires capabilities outside the compiled workflow.',
          });
        case 'ImplementationPlanningFailed':
          return OperatorActivityEntrySchema.parse({
            ...common,
            level: 'warning',
            title: 'Implementation planning paused',
            detail:
              'The provider attempt failed recoverably; retrying will not regenerate the workflow.',
          });
        default:
          throw new Error(`Unmapped implementation planning event: ${event.eventType}`);
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
          fixtureId: event.aggregateId.slice('implementation-plan:'.length),
          eventType: event.eventType,
        }),
      );
  }

  private async prepareOnce(
    taskReference: string,
    requestedStrategy: PlanningStrategyRequest,
    operatorGuidance: string | null,
  ): Promise<Outcome<ImplementationPlanningRecord, ImplementationPlanningError>> {
    const existing = this.store.read(taskReference);
    if (!existing.ok) return err({ kind: 'store', error: existing.error });
    if (
      operatorGuidance === null &&
      existing.value !== null &&
      existing.value.status !== 'failed' &&
      existing.value.status !== 'planning' &&
      existing.value.requestedStrategy === requestedStrategy
    ) {
      return ok(existing.value);
    }

    const subject = this.subjects.resolve(taskReference);
    if (!subject.ok) return err({ kind: 'subject', error: subject.error });
    const workflow = this.workflows.read(taskReference);
    if (!workflow.ok) return err({ kind: 'subject', error: workflow.error });
    if (workflow.value?.status !== 'ready') {
      return err({ kind: 'workflow_not_ready', taskReference });
    }
    const workflowJson = JsonValueSchema.parse(workflow.value.view.workflow);
    const selection = selectStrategy(requestedStrategy, subject.value, workflowJson);
    const begun = this.store.begin({
      taskReference,
      requestedStrategy,
      selectedStrategy: selection.strategy,
      selectionReason: selection.reason,
      operatorGuidance,
    });
    if (!begun.ok) return err({ kind: 'store', error: begun.error });
    if (begun.value.status !== 'planning') {
      throw new Error('Planning begin did not produce a planning record');
    }

    const result = await this.planner.plan({
      repositoryPath: subject.value.repositoryPath,
      strategy: selection.strategy,
      context: {
        taskSnapshot: subject.value.taskSnapshot,
        workflow: workflowJson,
        repositoryReference: subject.value.task.repository,
        operatorGuidance,
      },
    });
    const saved = result.ok
      ? this.store.complete(begun.value, result)
      : this.store.fail(begun.value, result.error);
    return saved.ok ? saved : err({ kind: 'store', error: saved.error });
  }
}

export const createImplementationPlanningCoordinator = (input: {
  readonly ledger: LedgerRepository;
  readonly clock: Clock;
  readonly workflows: M1WorkflowService;
  readonly subjects: WorkflowGenerationSubjectSource;
  readonly planner: ImplementationPlanner;
}): ImplementationPlanningCoordinator =>
  new ImplementationPlanningCoordinator(
    new ImplementationPlanningStore(input.ledger, input.clock),
    input.workflows,
    input.subjects,
    input.planner,
  );
