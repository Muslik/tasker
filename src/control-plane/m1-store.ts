import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import type { LedgerRepository } from '../ledger/repository.js';
import type {
  ArtifactWrite,
  EventRecord,
  EventWrite,
  JsonValue,
  LedgerConflict,
  ProjectionMutation,
} from '../ledger/types.js';
import {
  WorkflowAnalyzerReceiptSchema,
  type WorkflowAnalyzerReceipt,
} from '../providers/contracts.js';
import {
  M1_VIEW_SCHEMA_VERSION,
  WorkflowGenerationSubjectSchema,
  WorkflowViewSchema,
  type WorkflowGenerationSubject,
  type WorkflowView,
} from './m1-contracts.js';

export const M1_WORKFLOW_PROJECTION = 'm1_workflow';
export const M1_ANALYZER_PROJECTION = 'm1_analyzer';
export const M1_GENERATION_SUBJECT_PROJECTION = 'm1_generation_subject';

export interface M1WorkflowArtifacts {
  readonly analyzerVersion: string;
  readonly proposal: JsonValue;
  readonly validatorReport: JsonValue;
  readonly compiledGraph?: JsonValue | undefined;
}

export type M1StoreError =
  | {
      readonly kind: 'ledger_conflict';
      readonly conflict: LedgerConflict;
    }
  | {
      readonly kind: 'projection_corrupt';
      readonly fixtureId: string;
      readonly issues: readonly string[];
    }
  | {
      readonly kind: 'generation_subject_conflict';
      readonly taskReference: string;
    };

export interface M1StoreResult {
  readonly disposition: 'already_exists' | 'saved';
  readonly view: WorkflowView;
}

export interface M1GenerationSubjectSaveResult {
  readonly disposition: 'already_exists' | 'saved';
  readonly subject: WorkflowGenerationSubject;
}

export interface M1WorkflowSaveOptions {
  readonly operationId?: string;
  readonly projectTask?: boolean;
  readonly replaceValid?: boolean;
}

const asJson = (value: unknown): JsonValue => value as JsonValue;

const workflowAggregateId = (taskReference: string): string =>
  taskReference.startsWith('jira:') ? `workflow:${taskReference}` : `intake:${taskReference}`;

const isRecord = (value: JsonValue): value is Readonly<Record<string, JsonValue>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export class M1WorkflowStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public read(fixtureId: string): Outcome<WorkflowView | null, M1StoreError> {
    const projection = this.ledger.readProjection(M1_WORKFLOW_PROJECTION, fixtureId);

    if (projection === null) {
      return ok(null);
    }

    if (
      isRecord(projection.payload) &&
      typeof projection.payload.schemaVersion === 'number' &&
      projection.payload.schemaVersion !== M1_VIEW_SCHEMA_VERSION
    ) {
      const discarded = this.ledger.transact({
        projections: [
          {
            kind: 'delete',
            projectionType: M1_WORKFLOW_PROJECTION,
            projectionId: fixtureId,
          },
        ],
        timestamp: this.clock.now(),
      });
      return discarded.ok ? ok(null) : err({ kind: 'ledger_conflict', conflict: discarded.error });
    }

    const parsed = WorkflowViewSchema.safeParse(projection.payload);
    if (!parsed.success) {
      return err({
        kind: 'projection_corrupt',
        fixtureId,
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
        ),
      });
    }

    return ok(parsed.data);
  }

  public readProjection(
    projectionType: 'm1_analyzer' | 'm1_intake' | 'm1_task',
    projectionId: string,
  ): JsonValue | null {
    return this.ledger.readProjection(projectionType, projectionId)?.payload ?? null;
  }

  public readGenerationSubject(
    taskReference: string,
  ): Outcome<WorkflowGenerationSubject | null, M1StoreError> {
    const projection = this.ledger.readProjection(M1_GENERATION_SUBJECT_PROJECTION, taskReference);
    if (projection === null) return ok(null);

    const parsed = WorkflowGenerationSubjectSchema.safeParse(projection.payload);
    return parsed.success
      ? ok(parsed.data)
      : err({
          kind: 'projection_corrupt',
          fixtureId: taskReference,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
  }

  public saveGenerationSubject(
    taskReference: string,
    subjectInput: WorkflowGenerationSubject,
  ): Outcome<M1GenerationSubjectSaveResult, M1StoreError> {
    const subject = WorkflowGenerationSubjectSchema.parse(subjectInput);
    const existing = this.readGenerationSubject(taskReference);
    if (!existing.ok) return existing;
    if (existing.value !== null) {
      return JSON.stringify(existing.value) === JSON.stringify(subject)
        ? ok({ disposition: 'already_exists', subject: existing.value })
        : err({ kind: 'generation_subject_conflict', taskReference });
    }

    const aggregateId = `workflow-subject:${taskReference}`;
    const saved = this.ledger.transact({
      aggregate: {
        aggregateId,
        expectedVersion: 0,
        events: [
          {
            eventId: `event:workflow-subject:${taskReference}`,
            eventType: 'WorkflowGenerationSubjectSaved',
            eventSchemaVersion: 1,
            payload: asJson({ taskReference, repository: subject.task.repository }),
            actor: 'workflow_continuation_planner',
          },
        ],
      },
      projections: [
        {
          kind: 'upsert',
          projectionType: M1_GENERATION_SUBJECT_PROJECTION,
          projectionId: taskReference,
          payload: asJson(subject),
        },
      ],
      timestamp: this.clock.now(),
    });
    if (saved.ok) return ok({ disposition: 'saved', subject });

    if (saved.error.kind === 'version_conflict') {
      const concurrent = this.readGenerationSubject(taskReference);
      if (
        concurrent.ok &&
        concurrent.value !== null &&
        JSON.stringify(concurrent.value) === JSON.stringify(subject)
      ) {
        return ok({ disposition: 'already_exists', subject: concurrent.value });
      }
      if (concurrent.ok && concurrent.value !== null) {
        return err({ kind: 'generation_subject_conflict', taskReference });
      }
    }

    return err({ kind: 'ledger_conflict', conflict: saved.error });
  }

  public listEvents(fixtureId?: string): readonly EventRecord[] {
    return this.ledger.listEvents(
      fixtureId === undefined ? undefined : workflowAggregateId(fixtureId),
    );
  }

  public readAnalyzerSession(
    fixtureId: string,
  ): Outcome<WorkflowAnalyzerReceipt | null, M1StoreError> {
    const projection = this.ledger.readProjection(M1_ANALYZER_PROJECTION, fixtureId);
    if (projection === null) {
      return ok(null);
    }

    const parsed = WorkflowAnalyzerReceiptSchema.safeParse(projection.payload);
    if (!parsed.success) {
      return err({
        kind: 'projection_corrupt',
        fixtureId,
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
        ),
      });
    }

    return ok(parsed.data);
  }

  public readPlanningOperation(
    fixtureId: string,
    operationId: string,
  ): Outcome<WorkflowView | null, M1StoreError> {
    const event = this.ledger
      .listEvents(workflowAggregateId(fixtureId))
      .find(
        (candidate) =>
          (candidate.eventType === 'WorkflowPlanned' ||
            candidate.eventType === 'WorkflowRejected') &&
          isRecord(candidate.payload) &&
          candidate.payload.operationId === operationId,
      );
    if (event === undefined || !isRecord(event.payload)) return ok(null);
    const attempt = event.payload.attempt;
    if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
      return err({
        kind: 'projection_corrupt',
        fixtureId,
        issues: [`Planning operation ${operationId} has no valid attempt number`],
      });
    }
    const suffix = attempt === 1 ? '' : `:attempt-${String(attempt)}`;
    const snapshot = this.ledger.readSnapshot(`snapshot:${fixtureId}${suffix}`);
    if (snapshot === null) {
      return err({
        kind: 'projection_corrupt',
        fixtureId,
        issues: [`Planning operation ${operationId} has no snapshot`],
      });
    }
    const parsed = WorkflowViewSchema.safeParse(snapshot.payload);
    return parsed.success
      ? ok(parsed.data)
      : err({
          kind: 'projection_corrupt',
          fixtureId,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
  }

  public save(
    viewInput: WorkflowView,
    artifacts: M1WorkflowArtifacts,
    analyzerReceipt?: WorkflowAnalyzerReceipt,
    options: M1WorkflowSaveOptions = {},
  ): Outcome<M1StoreResult, M1StoreError> {
    const candidateView = WorkflowViewSchema.parse(viewInput);
    if (options.operationId !== undefined) {
      const completed = this.readPlanningOperation(candidateView.fixture.id, options.operationId);
      if (!completed.ok) return completed;
      if (completed.value !== null) {
        return ok({ disposition: 'already_exists', view: completed.value });
      }
    }
    const existing = this.read(candidateView.fixture.id);

    if (!existing.ok) {
      return existing;
    }

    if (existing.value?.workflow.status === 'valid' && options.replaceValid !== true) {
      return ok({ disposition: 'already_exists', view: existing.value });
    }

    const fixtureId = candidateView.fixture.id;
    const aggregateId = workflowAggregateId(fixtureId);
    const existingEvents = this.ledger.listEvents(aggregateId);
    const attempt =
      existingEvents.filter(
        (event) => event.eventType === 'WorkflowPlanned' || event.eventType === 'WorkflowRejected',
      ).length + 1;
    const attemptSuffix = attempt === 1 ? '' : `:attempt-${String(attempt)}`;
    const proposalArtifactId = `proposal:${fixtureId}${attemptSuffix}`;
    const view =
      attempt === 1
        ? candidateView
        : WorkflowViewSchema.parse({
            ...candidateView,
            workflow: { ...candidateView.workflow, proposalId: proposalArtifactId },
          });
    const artifactWrites: ArtifactWrite[] = [
      {
        artifactId: proposalArtifactId,
        artifactKind: 'workflow_proposal',
        storageUri: `ledger://artifacts/${proposalArtifactId}`,
        payload: artifacts.proposal,
        metadata: { analyzer: artifacts.analyzerVersion },
      },
      {
        artifactId: `validator:${fixtureId}${attemptSuffix}`,
        artifactKind: 'workflow_validator_report',
        storageUri: `ledger://artifacts/validator:${fixtureId}${attemptSuffix}`,
        payload: artifacts.validatorReport,
        metadata: { workflowStatus: view.workflow.status },
        parentArtifactId: proposalArtifactId,
      },
    ];

    if (artifacts.compiledGraph !== undefined) {
      artifactWrites.push({
        artifactId: `graph:${fixtureId}${attemptSuffix}`,
        artifactKind: 'compiled_workflow_graph',
        storageUri: `ledger://artifacts/graph:${fixtureId}${attemptSuffix}`,
        payload: artifacts.compiledGraph,
        metadata: { graphHash: view.workflow.graphHash ?? 'rejected' },
        parentArtifactId: proposalArtifactId,
      });
    }

    if (analyzerReceipt !== undefined) {
      artifactWrites.push({
        artifactId: `analyzer-receipt:${fixtureId}${attemptSuffix}`,
        artifactKind: 'workflow_analyzer_receipt',
        storageUri: `ledger://artifacts/analyzer-receipt:${fixtureId}${attemptSuffix}`,
        payload: asJson(analyzerReceipt),
        metadata: {
          analyzer: analyzerReceipt.analyzerVersion,
          provider: analyzerReceipt.provider,
        },
      });
    }

    const persistedAt = this.clock.now();
    const events: EventWrite[] =
      fixtureId.startsWith('jira:') || existingEvents.length > 0
        ? []
        : [
            {
              eventId: `event:intake-accepted:${fixtureId}`,
              eventType: 'IntakeAccepted',
              eventSchemaVersion: 1,
              payload: { fixtureId, intakeId: view.intake.id },
              actor: 'm1_local_fixture',
            },
            {
              eventId: `event:task-created:${fixtureId}`,
              eventType: 'TaskCreated',
              eventSchemaVersion: 1,
              payload: { fixtureId, taskId: view.task.id },
              actor: 'm1_local_fixture',
            },
          ];

    if (analyzerReceipt !== undefined) {
      events.push({
        eventId: `event:workflow-analyzed:${fixtureId}${attemptSuffix}`,
        eventType: 'WorkflowAnalyzed',
        eventSchemaVersion: 1,
        payload: {
          analyzerVersion: analyzerReceipt.analyzerVersion,
          durationMs: analyzerReceipt.durationMs,
          fixtureId,
          attempt,
          sessionId: analyzerReceipt.sessionId,
          usage: asJson(analyzerReceipt.usage),
        },
        actor: 'subscription_cli_analyzer',
      });
    }

    events.push({
      eventId: `event:workflow-planned:${fixtureId}${attemptSuffix}`,
      eventType: view.workflow.status === 'valid' ? 'WorkflowPlanned' : 'WorkflowRejected',
      eventSchemaVersion: 1,
      payload: {
        fixtureId,
        attempt,
        graphHash: view.workflow.graphHash,
        operationId: options.operationId ?? null,
        status: view.workflow.status,
      },
      actor:
        artifacts.analyzerVersion === 'm1-deterministic@1'
          ? 'm1_deterministic_planner'
          : 'm1_planner',
    });

    const projections: ProjectionMutation[] = [
      {
        kind: 'upsert',
        projectionType: 'm1_intake',
        projectionId: view.intake.id,
        payload: asJson({ fixture: view.fixture, intake: view.intake }),
      },
      {
        kind: 'upsert',
        projectionType: M1_WORKFLOW_PROJECTION,
        projectionId: fixtureId,
        payload: asJson(view),
      },
    ];

    if (options.projectTask !== false) {
      projections.push({
        kind: 'upsert',
        projectionType: 'm1_task',
        projectionId: view.task.id,
        payload: asJson({ fixture: view.fixture, task: view.task }),
      });
    }

    if (analyzerReceipt !== undefined) {
      projections.push({
        kind: 'upsert',
        projectionType: M1_ANALYZER_PROJECTION,
        projectionId: fixtureId,
        payload: asJson(analyzerReceipt),
      });
    }

    const result = this.ledger.transact({
      aggregate: {
        aggregateId,
        expectedVersion: existingEvents.length,
        events,
      },
      snapshots: [
        {
          snapshotId: `snapshot:${fixtureId}${attemptSuffix}`,
          aggregateId,
          aggregateVersion: existingEvents.length + events.length,
          snapshotSchemaVersion: 1,
          payload: asJson(view),
        },
      ],
      projections,
      artifacts: artifactWrites,
      timestamp: persistedAt,
    });

    if (!result.ok) {
      if (result.error.kind === 'version_conflict') {
        if (options.operationId !== undefined) {
          const completed = this.readPlanningOperation(fixtureId, options.operationId);
          if (!completed.ok) return completed;
          if (completed.value !== null) {
            return ok({ disposition: 'already_exists', view: completed.value });
          }
          return err({ kind: 'ledger_conflict', conflict: result.error });
        }
        const concurrent = this.read(fixtureId);
        if (concurrent.ok && concurrent.value !== null) {
          return ok({ disposition: 'already_exists', view: concurrent.value });
        }
      }

      return err({ kind: 'ledger_conflict', conflict: result.error });
    }

    return ok({ disposition: 'saved', view });
  }
}
