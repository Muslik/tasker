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
import {
  WorkflowGenerationSubjectSchema,
  type WorkflowGenerationSubject,
} from '../planning/index.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { WorkflowViewSchema, type WorkflowView } from './operator-contracts.js';

export const OPERATOR_WORKFLOW_OPERATION_PROJECTION = 'operator_workflow_by_operation';
export const OPERATOR_GENERATION_SUBJECT_PROJECTION = 'operator_generation_subject';
export const OPERATOR_RUN_GENERATION_SUBJECT_PROJECTION = 'operator_run_generation_subject';

export interface OperatorWorkflowArtifacts {
  readonly analyzerVersion: string;
  readonly proposal: JsonValue;
  readonly validatorReport: JsonValue;
  readonly compiledGraph?: JsonValue | undefined;
}

export type OperatorStoreError =
  | {
      readonly kind: 'ledger_conflict';
      readonly conflict: LedgerConflict;
    }
  | {
      readonly kind: 'projection_corrupt';
      readonly taskReference: string;
      readonly issues: readonly string[];
    }
  | {
      readonly kind: 'generation_subject_conflict';
      readonly taskReference: string;
    };

export interface OperatorStoreResult {
  readonly disposition: 'already_exists' | 'saved';
  readonly view: WorkflowView;
}

export interface OperatorGenerationSubjectSaveResult {
  readonly disposition: 'already_exists' | 'saved';
  readonly subject: WorkflowGenerationSubject;
}

const asJson = (value: unknown): JsonValue => value as JsonValue;

const workflowAggregateId = (operationId: string): string => `workflow-operation:${operationId}`;

const isRecord = (value: JsonValue): value is Readonly<Record<string, JsonValue>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const eventBelongsToTask = (event: EventRecord, taskReference: string): boolean =>
  isRecord(event.payload) && event.payload.taskReference === taskReference;

const candidateAttempt = (operationId: string): number => {
  const match = /:workflow-candidate:(\d+)$/u.exec(operationId);
  return match?.[1] === undefined ? 1 : Number(match[1]);
};

export class OperatorWorkflowStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public readGenerationSubject(
    taskReference: string,
  ): Outcome<WorkflowGenerationSubject | null, OperatorStoreError> {
    const projection = this.ledger.readProjection(
      OPERATOR_GENERATION_SUBJECT_PROJECTION,
      taskReference,
    );
    if (projection === null) return ok(null);

    const parsed = WorkflowGenerationSubjectSchema.safeParse(projection.payload);
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

  public saveGenerationSubject(
    taskReference: string,
    subjectInput: WorkflowGenerationSubject,
  ): Outcome<OperatorGenerationSubjectSaveResult, OperatorStoreError> {
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
          projectionType: OPERATOR_GENERATION_SUBJECT_PROJECTION,
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

  public readRunGenerationSubject(
    taskReference: string,
    workflowRunId: string,
  ): Outcome<WorkflowGenerationSubject | null, OperatorStoreError> {
    const projectionId = `${taskReference}:${workflowRunId}`;
    const projection = this.ledger.readProjection(
      OPERATOR_RUN_GENERATION_SUBJECT_PROJECTION,
      projectionId,
    );
    if (projection === null) return ok(null);
    const parsed = WorkflowGenerationSubjectSchema.safeParse(projection.payload);
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

  public captureRunGenerationSubject(
    taskReference: string,
    workflowRunId: string,
    subjectInput: WorkflowGenerationSubject,
  ): Outcome<OperatorGenerationSubjectSaveResult, OperatorStoreError> {
    const subject = WorkflowGenerationSubjectSchema.parse(subjectInput);
    const existing = this.readRunGenerationSubject(taskReference, workflowRunId);
    if (!existing.ok) return existing;
    if (existing.value !== null) {
      return JSON.stringify(existing.value) === JSON.stringify(subject)
        ? ok({ disposition: 'already_exists', subject: existing.value })
        : err({ kind: 'generation_subject_conflict', taskReference });
    }

    const subjectId = `${taskReference}:${workflowRunId}`;
    const saved = this.ledger.transact({
      aggregate: {
        aggregateId: `workflow-run-subject:${subjectId}`,
        expectedVersion: 0,
        events: [
          {
            eventId: `event:workflow-run-subject:${subjectId}`,
            eventType: 'WorkflowRunGenerationSubjectCaptured',
            eventSchemaVersion: 1,
            payload: asJson({ taskReference, workflowRunId, repository: subject.task.repository }),
            actor: 'temporal_bootstrap',
          },
        ],
      },
      projections: [
        {
          kind: 'upsert',
          projectionType: OPERATOR_RUN_GENERATION_SUBJECT_PROJECTION,
          projectionId: subjectId,
          payload: asJson(subject),
        },
      ],
      timestamp: this.clock.now(),
    });
    if (saved.ok) return ok({ disposition: 'saved', subject });

    if (saved.error.kind === 'version_conflict') {
      const concurrent = this.readRunGenerationSubject(taskReference, workflowRunId);
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

  public listEvents(taskReference?: string): readonly EventRecord[] {
    const events = this.ledger
      .listEvents()
      .filter((event) => event.aggregateId.startsWith('workflow-operation:'));
    return taskReference === undefined
      ? events
      : events.filter((event) => eventBelongsToTask(event, taskReference));
  }

  public readAnalyzerSessionForEpisode(
    taskReference: string,
    planningEpisodeId: string,
  ): Outcome<WorkflowAnalyzerReceipt | null, OperatorStoreError> {
    const event = this.listEvents(taskReference).findLast(
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
        taskReference,
        issues: [`Planning episode ${planningEpisodeId} has no workflow operation`],
      });
    }
    const artifact = this.ledger.readArtifact(`analyzer-receipt:${operationId}`);
    if (artifact === null) {
      return err({
        kind: 'projection_corrupt',
        taskReference,
        issues: [`Planning operation ${operationId} has no analyzer receipt`],
      });
    }
    const parsed = WorkflowAnalyzerReceiptSchema.safeParse(artifact.payload);
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

  public readPlanningOperation(
    taskReference: string,
    operationId: string,
  ): Outcome<WorkflowView | null, OperatorStoreError> {
    const projection = this.ledger.readProjection(
      OPERATOR_WORKFLOW_OPERATION_PROJECTION,
      operationId,
    );
    if (projection === null) return ok(null);
    const parsed = WorkflowViewSchema.safeParse(projection.payload);
    if (!parsed.success) {
      return err({
        kind: 'projection_corrupt',
        taskReference,
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
        ),
      });
    }
    return parsed.data.taskSummary.reference === taskReference ? ok(parsed.data) : ok(null);
  }

  public save(
    viewInput: WorkflowView,
    artifacts: OperatorWorkflowArtifacts,
    operationId: string,
    analyzerReceipt?: WorkflowAnalyzerReceipt,
  ): Outcome<OperatorStoreResult, OperatorStoreError> {
    const candidateView = WorkflowViewSchema.parse(viewInput);
    const completed = this.readPlanningOperation(candidateView.taskSummary.reference, operationId);
    if (!completed.ok) return completed;
    if (completed.value !== null) {
      return ok({ disposition: 'already_exists', view: completed.value });
    }

    const taskReference = candidateView.taskSummary.reference;
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
          taskReference,
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
        taskReference,
        attempt,
        graphHash: view.workflow.graphHash,
        operationId,
        status: view.workflow.status,
      }),
      actor: 'workflow_planner',
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
          projectionType: OPERATOR_WORKFLOW_OPERATION_PROJECTION,
          projectionId: operationId,
          payload: asJson(view),
        },
      ],
      artifacts: artifactWrites,
      timestamp: this.clock.now(),
    });

    if (!result.ok) {
      if (result.error.kind === 'version_conflict') {
        const concurrent = this.readPlanningOperation(taskReference, operationId);
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
