import type { LedgerRepository } from '../ledger/repository.js';
import type {
  ArtifactWrite,
  EventRecord,
  EventWrite,
  JsonValue,
  LedgerConflict,
} from '../ledger/types.js';
import {
  WorkflowAnalyzerReceiptSchema,
  type WorkflowAnalyzerReceipt,
} from '../providers/contracts.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  WorkflowGenerationSubjectSchema,
  WorkflowViewSchema,
  type WorkflowGenerationSubject,
  type WorkflowView,
} from './m1-contracts.js';

export const M1_WORKFLOW_OPERATION_PROJECTION = 'm1_workflow_by_operation';
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

const asJson = (value: unknown): JsonValue => value as JsonValue;

const workflowAggregateId = (operationId: string): string => `workflow-operation:${operationId}`;

const isRecord = (value: JsonValue): value is Readonly<Record<string, JsonValue>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const eventBelongsToFixture = (event: EventRecord, fixtureId: string): boolean =>
  isRecord(event.payload) && event.payload.fixtureId === fixtureId;

const candidateAttempt = (operationId: string): number => {
  const match = /:workflow-candidate:(\d+)$/u.exec(operationId);
  return match?.[1] === undefined ? 1 : Number(match[1]);
};

export class M1WorkflowStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

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
    const events = this.ledger
      .listEvents()
      .filter((event) => event.aggregateId.startsWith('workflow-operation:'));
    return fixtureId === undefined
      ? events
      : events.filter((event) => eventBelongsToFixture(event, fixtureId));
  }

  public readAnalyzerSessionForEpisode(
    fixtureId: string,
    planningEpisodeId: string,
  ): Outcome<WorkflowAnalyzerReceipt | null, M1StoreError> {
    const event = this.listEvents(fixtureId).findLast(
      (candidate) =>
        candidate.eventType === 'WorkflowAnalyzed' &&
        isRecord(candidate.payload) &&
        typeof candidate.payload.operationId === 'string' &&
        candidate.payload.operationId.startsWith(`${planningEpisodeId}:`),
    );
    if (event === undefined || !isRecord(event.payload)) return ok(null);
    const operationId = event.payload.operationId;
    if (typeof operationId !== 'string') {
      return err({
        kind: 'projection_corrupt',
        fixtureId,
        issues: [`Planning episode ${planningEpisodeId} has no workflow operation`],
      });
    }
    const artifact = this.ledger.readArtifact(`analyzer-receipt:${operationId}`);
    if (artifact === null) {
      return err({
        kind: 'projection_corrupt',
        fixtureId,
        issues: [`Planning operation ${operationId} has no analyzer receipt`],
      });
    }
    const parsed = WorkflowAnalyzerReceiptSchema.safeParse(artifact.payload);
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

  public readPlanningOperation(
    fixtureId: string,
    operationId: string,
  ): Outcome<WorkflowView | null, M1StoreError> {
    const projection = this.ledger.readProjection(M1_WORKFLOW_OPERATION_PROJECTION, operationId);
    if (projection === null) return ok(null);
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
    return parsed.data.fixture.id === fixtureId ? ok(parsed.data) : ok(null);
  }

  public save(
    viewInput: WorkflowView,
    artifacts: M1WorkflowArtifacts,
    operationId: string,
    analyzerReceipt?: WorkflowAnalyzerReceipt,
  ): Outcome<M1StoreResult, M1StoreError> {
    const candidateView = WorkflowViewSchema.parse(viewInput);
    const completed = this.readPlanningOperation(candidateView.fixture.id, operationId);
    if (!completed.ok) return completed;
    if (completed.value !== null) {
      return ok({ disposition: 'already_exists', view: completed.value });
    }

    const fixtureId = candidateView.fixture.id;
    const aggregateId = workflowAggregateId(operationId);
    const proposalArtifactId = `proposal:${operationId}`;
    const view = WorkflowViewSchema.parse({
      ...candidateView,
      workflow: { ...candidateView.workflow, proposalId: proposalArtifactId },
    });
    const artifactWrites: ArtifactWrite[] = [
      {
        artifactId: proposalArtifactId,
        artifactKind: 'workflow_proposal',
        storageUri: `ledger://artifacts/${proposalArtifactId}`,
        payload: artifacts.proposal,
        metadata: { analyzer: artifacts.analyzerVersion, operationId },
      },
      {
        artifactId: `validator:${operationId}`,
        artifactKind: 'workflow_validator_report',
        storageUri: `ledger://artifacts/validator:${operationId}`,
        payload: artifacts.validatorReport,
        metadata: { workflowStatus: view.workflow.status, operationId },
        parentArtifactId: proposalArtifactId,
      },
    ];

    if (artifacts.compiledGraph !== undefined) {
      artifactWrites.push({
        artifactId: `graph:${operationId}`,
        artifactKind: 'compiled_workflow_graph',
        storageUri: `ledger://artifacts/graph:${operationId}`,
        payload: artifacts.compiledGraph,
        metadata: { graphHash: view.workflow.graphHash ?? 'rejected', operationId },
        parentArtifactId: proposalArtifactId,
      });
    }

    if (analyzerReceipt !== undefined) {
      artifactWrites.push({
        artifactId: `analyzer-receipt:${operationId}`,
        artifactKind: 'workflow_analyzer_receipt',
        storageUri: `ledger://artifacts/analyzer-receipt:${operationId}`,
        payload: asJson(analyzerReceipt),
        metadata: {
          analyzer: analyzerReceipt.analyzerVersion,
          provider: analyzerReceipt.provider,
          operationId,
        },
      });
    }

    const attempt = candidateAttempt(operationId);
    const events: EventWrite[] = [];
    if (analyzerReceipt !== undefined) {
      events.push({
        eventId: `event:workflow-analyzed:${operationId}`,
        eventType: 'WorkflowAnalyzed',
        eventSchemaVersion: 1,
        payload: asJson({
          analyzerVersion: analyzerReceipt.analyzerVersion,
          durationMs: analyzerReceipt.durationMs,
          fixtureId,
          attempt,
          operationId,
          sessionId: analyzerReceipt.sessionId,
          usage: analyzerReceipt.usage,
        }),
        actor: 'subscription_cli_analyzer',
      });
    }
    events.push({
      eventId: `event:workflow-planned:${operationId}`,
      eventType: view.workflow.status === 'valid' ? 'WorkflowPlanned' : 'WorkflowRejected',
      eventSchemaVersion: 1,
      payload: asJson({
        fixtureId,
        attempt,
        graphHash: view.workflow.graphHash,
        operationId,
        status: view.workflow.status,
      }),
      actor:
        artifacts.analyzerVersion === 'm1-deterministic@1'
          ? 'm1_deterministic_planner'
          : 'm1_planner',
    });

    const result = this.ledger.transact({
      aggregate: {
        aggregateId,
        expectedVersion: 0,
        events,
      },
      snapshots: [
        {
          snapshotId: `snapshot:${operationId}`,
          aggregateId,
          aggregateVersion: events.length,
          snapshotSchemaVersion: 1,
          payload: asJson(view),
        },
      ],
      projections: [
        {
          kind: 'upsert',
          projectionType: M1_WORKFLOW_OPERATION_PROJECTION,
          projectionId: operationId,
          payload: asJson(view),
        },
      ],
      artifacts: artifactWrites,
      timestamp: this.clock.now(),
    });

    if (!result.ok) {
      if (result.error.kind === 'version_conflict') {
        const concurrent = this.readPlanningOperation(fixtureId, operationId);
        if (!concurrent.ok) return concurrent;
        if (concurrent.value !== null) {
          return ok({ disposition: 'already_exists', view: concurrent.value });
        }
      }
      return err({ kind: 'ledger_conflict', conflict: result.error });
    }

    return ok({ disposition: 'saved', view });
  }
}
