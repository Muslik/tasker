import { z } from 'zod';

import { loadHarnessPack, type LoadedHarnessPack, type LoadedPrompt } from '../harness/index.js';
import type { EventRecord, JsonValue, LedgerConflict } from '../ledger/types.js';
import type { LedgerRepository } from '../ledger/repository.js';
import {
  ImplementationPlanningDecisionSchema,
  ImplementationPlanLinkSchema,
  PlanningClarificationAnswerCommandSchema,
  PlanningStrategyRequestSchema,
  PlanningStrategySchema,
  type PlanningStrategy,
  type PlanningStrategyRequest,
  type PlanningQuestionAnswer,
  type ImplementationPlanLink,
} from '../planning/implementation-plan.js';
import {
  PlanningSnapshotReferenceSchema,
  RunPlanningSnapshotSchema,
  type PlanningSnapshotReference,
  type RunPlanningSnapshot,
} from '../planning/run-planning-snapshot.js';
import type {
  ImplementationPlanner,
  ImplementationPlannerFailure,
} from '../providers/implementation-planner.js';
import { ImplementationPlannerReceiptSchema } from '../providers/contracts.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { CompiledWorkflowSchema, JsonValueSchema } from '../workflow/schema.js';
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
  commandId: z.string().min(1).nullable(),
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
  | { readonly kind: 'planning_attempt_not_current'; readonly taskReference: string }
  | { readonly kind: 'clarification_answer_conflict'; readonly taskReference: string }
  | {
      readonly kind: 'planning_snapshot_not_found';
      readonly artifactId: string;
    }
  | {
      readonly kind: 'planning_snapshot_corrupt';
      readonly artifactId: string;
      readonly issues: readonly string[];
    }
  | {
      readonly kind: 'planning_snapshot_checksum_mismatch';
      readonly artifactId: string;
      readonly expectedChecksum: string;
      readonly actualChecksum: string;
    };

const asJson = (value: unknown): JsonValue => JsonValueSchema.parse(value);
const aggregateIdFor = (taskReference: string): string => `implementation-plan:${taskReference}`;

export class ImplementationPlanningStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public now(): string {
    return this.clock.now();
  }

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

  public createRunSnapshot(
    snapshotInput: RunPlanningSnapshot,
  ): Outcome<PlanningSnapshotReference, ImplementationPlanningStoreError> {
    const snapshot = RunPlanningSnapshotSchema.parse(snapshotInput);
    const artifactId = `planning-snapshot:${snapshot.taskReference}:${snapshot.workflowHash}`;
    const existing = this.ledger.readArtifact(artifactId);
    if (existing !== null) {
      const parsed = RunPlanningSnapshotSchema.safeParse(existing.payload);
      return parsed.success
        ? ok(PlanningSnapshotReferenceSchema.parse({ artifactId, checksum: existing.checksum }))
        : err({
            kind: 'planning_snapshot_corrupt',
            artifactId,
            issues: parsed.error.issues.map(
              (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
            ),
          });
    }

    const aggregateId = `planning-snapshot:${snapshot.taskReference}:${snapshot.workflowHash}`;
    const result = this.ledger.transact({
      aggregate: {
        aggregateId,
        expectedVersion: 0,
        events: [
          {
            eventId: `event:${aggregateId}:1`,
            eventType: 'PlanningRunSnapshotCreated',
            eventSchemaVersion: 1,
            payload: asJson({ artifactId, workflowHash: snapshot.workflowHash }),
            actor: 'kernel',
          },
        ],
      },
      artifacts: [
        {
          artifactId,
          artifactKind: 'planning_run_snapshot',
          storageUri: `ledger://artifacts/${artifactId}`,
          payload: asJson(snapshot),
          metadata: asJson({
            taskReference: snapshot.taskReference,
            workflowHash: snapshot.workflowHash,
            companyId: snapshot.harness.company.id,
            companyVersion: snapshot.harness.company.version,
          }),
          createdAt: snapshot.createdAt,
        },
      ],
      timestamp: snapshot.createdAt,
    });
    if (!result.ok) {
      const concurrentlyCreated = this.ledger.readArtifact(artifactId);
      if (concurrentlyCreated !== null) {
        return ok(
          PlanningSnapshotReferenceSchema.parse({
            artifactId,
            checksum: concurrentlyCreated.checksum,
          }),
        );
      }
      return err({ kind: 'ledger_conflict', conflict: result.error });
    }
    const created = this.ledger.readArtifact(artifactId);
    if (created === null) return err({ kind: 'planning_snapshot_not_found', artifactId });
    return ok(PlanningSnapshotReferenceSchema.parse({ artifactId, checksum: created.checksum }));
  }

  public readRunSnapshot(
    referenceInput: PlanningSnapshotReference,
  ): Outcome<RunPlanningSnapshot, ImplementationPlanningStoreError> {
    const reference = PlanningSnapshotReferenceSchema.parse(referenceInput);
    const artifact = this.ledger.readArtifact(reference.artifactId);
    if (artifact === null) {
      return err({ kind: 'planning_snapshot_not_found', artifactId: reference.artifactId });
    }
    if (artifact.checksum !== reference.checksum) {
      return err({
        kind: 'planning_snapshot_checksum_mismatch',
        artifactId: reference.artifactId,
        expectedChecksum: reference.checksum,
        actualChecksum: artifact.checksum,
      });
    }
    const parsed = RunPlanningSnapshotSchema.safeParse(artifact.payload);
    return parsed.success
      ? ok(parsed.data)
      : err({
          kind: 'planning_snapshot_corrupt',
          artifactId: reference.artifactId,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
  }

  public begin(input: {
    readonly taskReference: string;
    readonly commandId: string | null;
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
      commandId: input.commandId,
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

  public recordClarificationAnswers(
    planning: Extract<ImplementationPlanningRecord, { readonly status: 'needs_clarification' }>,
    answers: readonly PlanningQuestionAnswer[],
  ): Outcome<{ readonly artifactId: string }, ImplementationPlanningStoreError> {
    const current = this.read(planning.taskReference);
    if (!current.ok) return current;
    if (
      current.value?.status !== 'needs_clarification' ||
      current.value.attempt !== planning.attempt
    ) {
      return err({
        kind: 'planning_attempt_not_current',
        taskReference: planning.taskReference,
      });
    }

    const artifactId = `planning-answers:${planning.taskReference}:attempt-${String(planning.attempt)}`;
    const payload = PlanningClarificationAnswerCommandSchema.parse({ answers });
    const existing = this.ledger.readArtifact(artifactId);
    if (existing !== null) {
      const parsed = PlanningClarificationAnswerCommandSchema.safeParse(existing.payload);
      return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(payload)
        ? ok({ artifactId })
        : err({ kind: 'clarification_answer_conflict', taskReference: planning.taskReference });
    }

    const aggregateId = aggregateIdFor(planning.taskReference);
    const expectedVersion = this.ledger.readAggregateHead(aggregateId)?.version ?? 0;
    const recordedAt = this.clock.now();
    const result = this.ledger.transact({
      aggregate: {
        aggregateId,
        expectedVersion,
        events: [
          {
            eventId: `event:${aggregateId}:${String(expectedVersion + 1)}`,
            eventType: 'PlanningClarificationAnswered',
            eventSchemaVersion: 1,
            payload: asJson({
              taskReference: planning.taskReference,
              attempt: planning.attempt,
              artifactId,
              questionCount: planning.decision.questions.length,
            }),
            actor: 'operator',
          },
        ],
      },
      artifacts: [
        {
          artifactId,
          artifactKind: 'planning_clarification_answers',
          storageUri: `ledger://artifacts/${artifactId}`,
          payload: asJson(payload),
          metadata: asJson({
            taskReference: planning.taskReference,
            sourceAttempt: planning.attempt,
            questionArtifactId: planning.artifactId,
          }),
          createdAt: recordedAt,
        },
      ],
      timestamp: recordedAt,
    });
    if (result.ok) return ok({ artifactId });

    const concurrentlyRecorded = this.ledger.readArtifact(artifactId);
    const parsed = PlanningClarificationAnswerCommandSchema.safeParse(
      concurrentlyRecorded?.payload,
    );
    return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(payload)
      ? ok({ artifactId })
      : err({ kind: 'ledger_conflict', conflict: result.error });
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

const snapshotPrompt = (prompt: LoadedPrompt) => ({
  relativePath: prompt.relativePath,
  content: prompt.content,
  contentSha256: prompt.contentSha256,
});

const snapshotHarness = (
  pack: LoadedHarnessPack,
  repositoryReference: string,
  workflowGraph: JsonValue,
) => {
  const graph = CompiledWorkflowSchema.parse(workflowGraph);
  const referencedSteps = new Set(graph.metadata.references.stepTypes);
  const steps = pack.steps
    .filter((step) => referencedSteps.has(step.reference))
    .map((step) => {
      if (step.execution.kind === 'agent') {
        if (step.prompt === null) {
          throw new Error(`Agent block ${step.reference} has no loaded prompt`);
        }
        return {
          reference: step.reference,
          execution: {
            kind: 'agent' as const,
            skills: step.execution.skills,
            prompt: snapshotPrompt(step.prompt),
          },
        };
      }
      return {
        reference: step.reference,
        execution:
          step.execution.kind === 'process'
            ? { kind: 'process' as const, executor: step.execution.executor }
            : { kind: 'integration' as const, adapter: step.execution.adapter },
      };
    });
  const project = pack.projects.find((candidate) => candidate.repository === repositoryReference);
  const snapshottedProject = (() => {
    if (project === undefined) return null;
    const { guidance, ...manifest } = project;
    return {
      manifest,
      guidance: guidance === null ? null : snapshotPrompt(guidance),
    };
  })();

  return {
    company: pack.company,
    project: snapshottedProject,
    implementationPlannerPrompt: snapshotPrompt(pack.prompts.implementationPlanner),
    steps,
  };
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
    private readonly harnessPackSource: () => LoadedHarnessPack,
  ) {}

  public createRunSnapshot(
    taskReference: string,
    expectedWorkflowHash: string,
  ): Outcome<PlanningSnapshotReference, ImplementationPlanningError> {
    const subject = this.subjects.resolve(taskReference);
    if (!subject.ok) return err({ kind: 'subject', error: subject.error });
    const workflow = this.workflows.read(taskReference);
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
    const snapshot = RunPlanningSnapshotSchema.parse({
      schemaVersion: 1,
      taskReference,
      workflowHash: expectedWorkflowHash,
      task: subject.value.task,
      taskSnapshot: subject.value.taskSnapshot,
      workflow: JsonValueSchema.parse(workflow.value.view.workflow),
      repository: {
        reference: subject.value.task.repository,
        path: subject.value.repositoryPath,
      },
      harness: snapshotHarness(this.harnessPackSource(), subject.value.task.repository, graph.data),
      createdAt: this.store.now(),
    });
    const stored = this.store.createRunSnapshot(snapshot);
    return stored.ok ? stored : err({ kind: 'store', error: stored.error });
  }

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
    commandId: string | null = null,
    expectedWorkflowHash: string | null = null,
    snapshotReference: PlanningSnapshotReference | null = null,
  ): Promise<Outcome<ImplementationPlanningRecord, ImplementationPlanningError>> {
    const inFlightKey = `${taskReference}:${commandId ?? 'legacy'}`;
    const current = this.inFlight.get(inFlightKey);
    if (current !== undefined) return current;
    const pending = this.prepareOnce(
      taskReference,
      requestedStrategy,
      operatorGuidance,
      commandId,
      expectedWorkflowHash,
      snapshotReference,
    ).finally(() => {
      this.inFlight.delete(inFlightKey);
    });
    this.inFlight.set(inFlightKey, pending);
    return pending;
  }

  public answer(
    taskReference: string,
    answersInput: readonly PlanningQuestionAnswer[],
    commandId: string | null = null,
    expectedWorkflowHash: string | null = null,
    snapshotReference: PlanningSnapshotReference | null = null,
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
    const current = this.store.read(taskReference);
    if (!current.ok) return Promise.resolve(err({ kind: 'store', error: current.error }));
    if (commandId !== null && current.value?.commandId === commandId) {
      if (current.value.status === 'failed' || current.value.status === 'planning') {
        return this.prepare(
          taskReference,
          current.value.requestedStrategy,
          current.value.operatorGuidance,
          commandId,
          expectedWorkflowHash,
          snapshotReference,
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
      guidance,
      commandId,
      expectedWorkflowHash,
      snapshotReference,
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
        case 'PlanningClarificationAnswered':
          return OperatorActivityEntrySchema.parse({
            ...common,
            source: 'operator',
            title: 'Planning clarification answered',
            detail: 'The typed answers were persisted and a new planning attempt can begin.',
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
    commandId: string | null,
    expectedWorkflowHash: string | null,
    snapshotReference: PlanningSnapshotReference | null,
  ): Promise<Outcome<ImplementationPlanningRecord, ImplementationPlanningError>> {
    const existing = this.store.read(taskReference);
    if (!existing.ok) return err({ kind: 'store', error: existing.error });
    if (
      commandId !== null &&
      existing.value?.commandId === commandId &&
      existing.value.status !== 'planning' &&
      existing.value.status !== 'failed'
    ) {
      return ok(existing.value);
    }
    if (
      commandId === null &&
      operatorGuidance === null &&
      existing.value !== null &&
      existing.value.status !== 'failed' &&
      existing.value.status !== 'planning' &&
      existing.value.requestedStrategy === requestedStrategy
    ) {
      return ok(existing.value);
    }

    const planningInput = (() => {
      if (snapshotReference !== null) {
        const loaded = this.store.readRunSnapshot(snapshotReference);
        if (!loaded.ok) return err({ kind: 'store' as const, error: loaded.error });
        if (
          loaded.value.taskReference !== taskReference ||
          (expectedWorkflowHash !== null && loaded.value.workflowHash !== expectedWorkflowHash)
        ) {
          return err({
            kind: 'workflow_snapshot_mismatch' as const,
            taskReference,
            expectedHash: expectedWorkflowHash ?? loaded.value.workflowHash,
            actualHash: loaded.value.workflowHash,
          });
        }
        return ok({
          subject: {
            repositoryPath: loaded.value.repository.path,
            task: loaded.value.task,
            taskSnapshot: loaded.value.taskSnapshot,
          },
          workflowJson: loaded.value.workflow,
          promptTemplate: loaded.value.harness.implementationPlannerPrompt.content,
        });
      }

      const subject = this.subjects.resolve(taskReference);
      if (!subject.ok) return err({ kind: 'subject' as const, error: subject.error });
      const workflow = this.workflows.read(taskReference);
      if (!workflow.ok) return err({ kind: 'subject' as const, error: workflow.error });
      if (workflow.value?.status !== 'ready') {
        return err({ kind: 'workflow_not_ready' as const, taskReference });
      }
      if (
        expectedWorkflowHash !== null &&
        workflow.value.view.workflow.graphHash !== expectedWorkflowHash
      ) {
        return err({
          kind: 'workflow_snapshot_mismatch' as const,
          taskReference,
          expectedHash: expectedWorkflowHash,
          actualHash: workflow.value.view.workflow.graphHash,
        });
      }
      return ok({
        subject: subject.value,
        workflowJson: JsonValueSchema.parse(workflow.value.view.workflow),
        promptTemplate: this.harnessPackSource().prompts.implementationPlanner.content,
      });
    })();
    if (!planningInput.ok) return planningInput;
    const selection = selectStrategy(
      requestedStrategy,
      planningInput.value.subject,
      planningInput.value.workflowJson,
    );
    const begun =
      commandId !== null &&
      existing.value?.commandId === commandId &&
      existing.value.status === 'planning'
        ? ok(existing.value)
        : this.store.begin({
            taskReference,
            commandId,
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
      repositoryPath: planningInput.value.subject.repositoryPath,
      strategy: selection.strategy,
      context: {
        taskSnapshot: planningInput.value.subject.taskSnapshot,
        workflow: planningInput.value.workflowJson,
        repositoryReference: planningInput.value.subject.task.repository,
        operatorGuidance,
      },
      promptTemplate: planningInput.value.promptTemplate,
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
    input.planner,
    harnessPackSource,
  );
};
