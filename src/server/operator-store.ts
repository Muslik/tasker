import type { LedgerRepository } from '../store/repository.js';
import type { ArtifactWrite, JsonValue, DocumentConflict, LedgerConflict } from '../store/types.js';
import {
  WorkflowAnalyzerReceiptSchema,
  type WorkflowAnalyzerReceipt,
} from '../agents/contracts.js';
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
const OPERATOR_WORKFLOW_DOCUMENT_KIND = OPERATOR_WORKFLOW_OPERATION_PROJECTION;
const OPERATOR_GENERATION_DOCUMENT_KIND = 'operator_generation_subject';
const OPERATOR_RUN_GENERATION_DOCUMENT_KIND = 'operator_run_generation_subject';

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

const ledgerConflictFromDocumentConflict = (conflict: DocumentConflict): LedgerConflict => ({
  kind: 'version_conflict',
  aggregateId: `document:${conflict.documentKind}:${conflict.documentId}`,
  expectedVersion: conflict.expectedRevision,
  actualVersion: conflict.actualRevision,
});

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
    const document = this.ledger.readDocument(OPERATOR_GENERATION_DOCUMENT_KIND, taskReference);
    if (document === null) return ok(null);

    const parsed = WorkflowGenerationSubjectSchema.safeParse(document.payload);
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

    const saved = this.ledger.appendDocument(
      OPERATOR_GENERATION_DOCUMENT_KIND,
      taskReference,
      0,
      asJson(subject),
      this.clock.now(),
    );
    if (saved.ok) return ok({ disposition: 'saved', subject });
    const concurrent = this.readGenerationSubject(taskReference);
    return concurrent.ok &&
      concurrent.value !== null &&
      JSON.stringify(concurrent.value) === JSON.stringify(subject)
      ? ok({ disposition: 'already_exists', subject: concurrent.value })
      : err({ kind: 'generation_subject_conflict', taskReference });
  }

  public readRunGenerationSubject(
    taskReference: string,
    workflowRunId: string,
  ): Outcome<WorkflowGenerationSubject | null, OperatorStoreError> {
    const projectionId = `${taskReference}:${workflowRunId}`;
    const document = this.ledger.readDocument(OPERATOR_RUN_GENERATION_DOCUMENT_KIND, projectionId);
    if (document === null) return ok(null);
    const parsed = WorkflowGenerationSubjectSchema.safeParse(document.payload);
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
    const saved = this.ledger.appendDocument(
      OPERATOR_RUN_GENERATION_DOCUMENT_KIND,
      subjectId,
      0,
      asJson(subject),
      this.clock.now(),
    );
    if (saved.ok) return ok({ disposition: 'saved', subject });
    const concurrent = this.readRunGenerationSubject(taskReference, workflowRunId);
    return concurrent.ok &&
      concurrent.value !== null &&
      JSON.stringify(concurrent.value) === JSON.stringify(subject)
      ? ok({ disposition: 'already_exists', subject: concurrent.value })
      : err({ kind: 'generation_subject_conflict', taskReference });
  }

  public listStreamEventsAfter(sequence: number) {
    return this.ledger.listStreamEventsAfter(sequence);
  }

  public readLatestStreamSequence(): number {
    return this.ledger.readLatestStreamEventSequence();
  }

  public readAnalyzerSessionForEpisode(
    taskReference: string,
    planningEpisodeId: string,
  ): Outcome<WorkflowAnalyzerReceipt | null, OperatorStoreError> {
    const event = this.ledger
      .listStreamEventsAfter(0)
      .findLast(
        (candidate) =>
          candidate.taskReference === taskReference &&
          candidate.eventType === 'WorkflowAnalyzed' &&
          typeof candidate.payload === 'object' &&
          candidate.payload !== null &&
          !Array.isArray(candidate.payload) &&
          typeof candidate.payload.operationId === 'string' &&
          candidate.payload.operationId.startsWith(`${planningEpisodeId}:`),
      );
    if (
      event === undefined ||
      typeof event.payload !== 'object' ||
      event.payload === null ||
      Array.isArray(event.payload) ||
      typeof event.payload.operationId !== 'string'
    )
      return ok(null);
    const operationId = event.payload.operationId;
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
    const document = this.ledger.readDocument(OPERATOR_WORKFLOW_DOCUMENT_KIND, operationId);
    if (document === null) return ok(null);
    const parsed = WorkflowViewSchema.safeParse(document.payload);
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
    const eventPayloads: Array<{ readonly eventType: string; readonly payload: JsonValue }> = [];
    if (analyzerReceipt !== undefined) {
      eventPayloads.push({
        eventType: 'WorkflowAnalyzed',
        payload: asJson({
          analyzerVersion: analyzerReceipt.analyzerVersion,
          durationMs: analyzerReceipt.durationMs,
          taskReference,
          attempt,
          operationId,
          sessionId: analyzerReceipt.sessionId,
          usage: analyzerReceipt.usage,
        }),
      });
    }
    eventPayloads.push({
      eventType: view.workflow.status === 'valid' ? 'WorkflowPlanned' : 'WorkflowRejected',
      payload: asJson({
        taskReference,
        attempt,
        graphHash: view.workflow.graphHash,
        operationId,
        status: view.workflow.status,
      }),
    });
    const timestamp = this.clock.now();
    for (const artifact of artifactWrites) this.ledger.insertArtifact(artifact);
    const saved = this.ledger.appendDocument(
      OPERATOR_WORKFLOW_DOCUMENT_KIND,
      operationId,
      0,
      asJson(view),
      timestamp,
    );
    if (!saved.ok) {
      const concurrent = this.readPlanningOperation(taskReference, operationId);
      if (!concurrent.ok) return concurrent;
      if (concurrent.value !== null)
        return ok({ disposition: 'already_exists', view: concurrent.value });
      return err({
        kind: 'ledger_conflict',
        conflict: ledgerConflictFromDocumentConflict(saved.error),
      });
    }
    for (const event of eventPayloads) {
      this.ledger.appendStreamEvent({
        taskReference,
        eventType: event.eventType,
        payload: event.payload,
        occurredAt: timestamp,
      });
    }
    return ok({ disposition: 'saved', view });
  }
}
