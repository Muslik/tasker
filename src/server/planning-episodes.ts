import { z } from 'zod';

import type {
  ImplementationPlannerDecisionSuccess,
  ImplementationPlannerFailure,
} from '../agents/implementation-planner.js';
import type {
  VALIDATION_PROCESS_COMMAND_REFERENCES,
  ValidationProcessCommandReference,
} from '../harness/index.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { CompiledWorkflowSchema, JsonValueSchema } from '../graph/schema.js';
import type { LedgerRepository } from '../store/repository.js';
import type { JsonValue, LedgerConflict } from '../store/types.js';
import type { EvidenceBundleReference } from '../planning/index.js';
import {
  PlanningClarificationAnswerCommandSchema,
  type PlanningQuestionAnswer,
  type PlanningStrategy,
  type PlanningStrategyRequest,
} from '../planning/implementation-plan.js';
import type { ImplementationPlanningFailure } from '../planning/planning-failure.js';
import type {
  PlanningSnapshotReference,
  RunPlanningSnapshot,
} from '../planning/run-planning-snapshot.js';
import {
  PlanningSnapshotReferenceSchema,
  RunPlanningSnapshotSchema,
} from '../planning/run-planning-snapshot.js';
import {
  ImplementationPlanningRecordSchema,
  ValidatedPlanningCandidateSchema,
} from './implementation-planning-contracts.js';
import type {
  ImplementationPlanningRecord,
  PlanningEvidencePending,
  ValidatedPlanningCandidate,
} from './implementation-planning-contracts.js';
import { planningTranscriptIdFor } from './planning-transcript.js';

export const IMPLEMENTATION_PLAN_PROJECTION = 'implementation_plan_by_episode';
export { ImplementationPlanningRecordSchema } from './implementation-planning-contracts.js';
export type {
  ImplementationPlanningRecord,
  ReadyImplementationPlanningRecord,
} from './implementation-planning-contracts.js';

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

interface ProjectValidationMissingFailure {
  readonly kind: 'project_validation_missing';
  readonly repositoryReference: string;
  readonly expectedKeys: typeof VALIDATION_PROCESS_COMMAND_REFERENCES;
  readonly missingKeys: readonly ValidationProcessCommandReference[];
}

type ImplementationPlanningFailureInput =
  ImplementationPlannerFailure | ProjectValidationMissingFailure;

const asJson = (value: unknown): JsonValue => JsonValueSchema.parse(value);
const DOCUMENT_KIND = 'implementation_planning';

const ArchivedExecutionSnapshotSchema = z.looseObject({
  kind: z.literal('execution'),
  workflow: z.looseObject({ graph: CompiledWorkflowSchema }),
});

export class ImplementationPlanningStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public now(): string {
    return this.clock.now();
  }

  public read(
    planningEpisodeId: string,
  ): Outcome<ImplementationPlanningRecord | null, ImplementationPlanningStoreError> {
    const document = this.ledger.readDocument(DOCUMENT_KIND, planningEpisodeId);
    if (document === null) return ok(null);
    const parsed = ImplementationPlanningRecordSchema.safeParse(document.payload);
    return parsed.success
      ? ok(parsed.data)
      : err({
          kind: 'projection_corrupt',
          taskReference: planningEpisodeId,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
  }

  public listStreamEventsAfter(sequence: number) {
    return this.ledger.listStreamEventsAfter(sequence);
  }

  public nextAgentInvocationNumber(planningEpisodeId: string, planningAttempt: number): number {
    return this.ledger.nextPlanningInvocationNumber(planningEpisodeId, planningAttempt);
  }

  public persistRunSnapshot(
    snapshotInput: RunPlanningSnapshot,
  ): Outcome<PlanningSnapshotReference, ImplementationPlanningStoreError> {
    const snapshot = RunPlanningSnapshotSchema.parse(snapshotInput);
    const snapshotHash =
      snapshot.kind === 'planning_context' ? snapshot.contextHash : snapshot.workflowHash;
    const artifactId = `planning-snapshot:${snapshot.taskReference}:${snapshot.repository.workspaceId}:${snapshot.kind}:${snapshotHash}`;
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

    const result = this.ledger.insertArtifact({
      artifactId,
      artifactKind: 'planning_run_snapshot',
      storageUri: `ledger://artifacts/${artifactId}`,
      payload: asJson(snapshot),
      metadata: asJson({
        taskReference: snapshot.taskReference,
        kind: snapshot.kind,
        snapshotHash,
        companyId: snapshot.harness.company.id,
        companyVersion: snapshot.harness.company.version,
      }),
      createdAt: snapshot.createdAt,
    });
    if (!result) {
      const concurrentlyCreated = this.ledger.readArtifact(artifactId);
      if (concurrentlyCreated !== null) {
        return ok(
          PlanningSnapshotReferenceSchema.parse({
            artifactId,
            checksum: concurrentlyCreated.checksum,
          }),
        );
      }
      return err({
        kind: 'ledger_conflict',
        conflict: {
          kind: 'version_conflict',
          aggregateId: artifactId,
          expectedVersion: 0,
          actualVersion: 1,
        },
      });
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

  public readArchivedExecutionGraph(
    referenceInput: PlanningSnapshotReference,
  ): Outcome<z.infer<typeof CompiledWorkflowSchema>, ImplementationPlanningStoreError> {
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
    const parsed = ArchivedExecutionSnapshotSchema.safeParse(artifact.payload);
    return parsed.success
      ? ok(parsed.data.workflow.graph)
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
    readonly planningEpisodeId: string;
    readonly commandId: string | null;
    readonly planningSnapshot: PlanningSnapshotReference | null;
    readonly evidenceBundle: EvidenceBundleReference;
    readonly requestedStrategy: PlanningStrategyRequest;
    readonly selectedStrategy: PlanningStrategy;
    readonly selectionReason: string;
    readonly operatorGuidance: string | null;
    readonly validationFeedback: readonly string[];
    readonly previousDecision:
      Extract<ImplementationPlanningRecord, { readonly status: 'ready' }>['decision'] | null;
  }): Outcome<ImplementationPlanningRecord, ImplementationPlanningStoreError> {
    const current = this.read(input.planningEpisodeId);
    if (!current.ok) return current;
    const attempt = (current.value?.attempt ?? 0) + 1;
    const startedAt = this.clock.now();
    const record = ImplementationPlanningRecordSchema.parse({
      schemaVersion: 3,
      status: 'planning',
      taskReference: input.taskReference,
      planningEpisodeId: input.planningEpisodeId,
      commandId: input.commandId,
      transcriptId: input.commandId === null ? null : planningTranscriptIdFor(input.commandId),
      planningSnapshot: input.planningSnapshot,
      evidenceBundle: input.evidenceBundle,
      evidenceRounds: [],
      attempt,
      requestedStrategy: input.requestedStrategy,
      selectedStrategy: input.selectedStrategy,
      selectionReason: input.selectionReason,
      startedAt,
      operatorGuidance: input.operatorGuidance,
      validationFeedback: input.validationFeedback,
      validationRevision: 0,
      previousDecision: input.previousDecision,
      pendingEvidence: null,
      validatedCandidate: null,
    });
    return this.persist(record, 'ImplementationPlanningStarted', {
      taskReference: input.taskReference,
      attempt,
      requestedStrategy: input.requestedStrategy,
      selectedStrategy: input.selectedStrategy,
      episodeId: input.planningEpisodeId,
    });
  }

  public complete(
    planning: Extract<ImplementationPlanningRecord, { readonly status: 'planning' }>,
    result: {
      readonly decision: NonNullable<ImplementationPlannerDecisionSuccess['decision']>;
      readonly receipt: ImplementationPlannerDecisionSuccess['receipt'];
    },
    materialized: {
      readonly workflowHash: string;
      readonly workflowOperationId: string;
      readonly executionSnapshot: PlanningSnapshotReference;
    } | null,
  ): Outcome<ImplementationPlanningRecord, ImplementationPlanningStoreError> {
    const current = this.read(planning.planningEpisodeId);
    if (!current.ok) return current;
    if (current.value?.status !== 'planning' || current.value.attempt !== planning.attempt) {
      return err({ kind: 'planning_attempt_not_current', taskReference: planning.taskReference });
    }
    if (current.value.pendingEvidence !== null) {
      return err({ kind: 'planning_attempt_not_current', taskReference: planning.taskReference });
    }
    const completedAt = this.clock.now();
    if (result.decision.status === 'ready' && materialized === null) {
      throw new Error('Ready planning decision has no validated execution workflow');
    }
    const artifactId = `implementation-plan:${planning.planningEpisodeId}:attempt-${String(planning.attempt)}`;
    const { pendingEvidence, validatedCandidate, ...completedPlanning } = current.value;
    void pendingEvidence;
    void validatedCandidate;
    const record = ImplementationPlanningRecordSchema.parse({
      ...completedPlanning,
      status: result.decision.status,
      completedAt,
      artifactId,
      decision: result.decision,
      receipt: result.receipt,
      ...(result.decision.status === 'ready'
        ? {
            workflowHash: materialized?.workflowHash,
            workflowOperationId: materialized?.workflowOperationId,
            executionSnapshot: materialized?.executionSnapshot,
          }
        : {}),
    });
    if (
      record.status !== 'ready' &&
      record.status !== 'needs_clarification' &&
      record.status !== 'investigation_required'
    ) {
      throw new Error('Planning completion did not produce a decision record');
    }
    const eventType =
      record.status === 'ready'
        ? 'ImplementationPlanReady'
        : record.status === 'needs_clarification'
          ? 'ImplementationPlanNeedsClarification'
          : 'ImplementationPlanInvestigationRequired';
    return this.persist(
      record,
      eventType,
      {
        taskReference: planning.taskReference,
        attempt: planning.attempt,
        selectedStrategy: planning.selectedStrategy,
        artifactId,
        episodeId: planning.planningEpisodeId,
      },
      {
        artifactId,
        artifactKind:
          record.status === 'ready'
            ? 'implementation_plan'
            : record.status === 'needs_clarification'
              ? 'planning_questions'
              : 'investigation_request',
        storageUri: `ledger://artifacts/${artifactId}`,
        payload: asJson(record.decision),
        metadata: asJson({
          taskReference: planning.taskReference,
          attempt: planning.attempt,
          strategy: planning.selectedStrategy,
          promptHash: result.receipt.promptHash,
          evidenceBundleArtifactId: current.value.evidenceBundle.artifactId,
        }),
        createdAt: completedAt,
      },
    );
  }

  public recordValidatedCandidate(
    planning: Extract<ImplementationPlanningRecord, { readonly status: 'planning' }>,
    candidateInput: ValidatedPlanningCandidate,
  ): Outcome<
    Extract<ImplementationPlanningRecord, { readonly status: 'planning' }>,
    ImplementationPlanningStoreError
  > {
    const current = this.read(planning.planningEpisodeId);
    if (!current.ok) return current;
    if (current.value?.status !== 'planning' || current.value.attempt !== planning.attempt) {
      return err({ kind: 'planning_attempt_not_current', taskReference: planning.taskReference });
    }
    const candidate = ValidatedPlanningCandidateSchema.parse(candidateInput);
    if (current.value.validatedCandidate !== null) {
      return JSON.stringify(current.value.validatedCandidate) === JSON.stringify(candidate)
        ? ok(current.value)
        : err({ kind: 'planning_attempt_not_current', taskReference: planning.taskReference });
    }
    const updated = ImplementationPlanningRecordSchema.parse({
      ...current.value,
      validatedCandidate: candidate,
    });
    if (updated.status !== 'planning') {
      throw new Error('Validated workflow candidate changed the planning state');
    }
    const artifactId = `implementation-plan:${planning.planningEpisodeId}:attempt-${String(planning.attempt)}:validated-candidate`;
    const saved = this.persist(
      updated,
      'ImplementationWorkflowCandidateValidated',
      {
        taskReference: planning.taskReference,
        attempt: planning.attempt,
        semanticHash: candidate.semanticHash,
        compilerVersion: candidate.compilerVersion,
        workflowHash: candidate.workflowHash,
        artifactId,
        episodeId: planning.planningEpisodeId,
      },
      {
        artifactId,
        artifactKind: 'implementation_plan_validated_candidate',
        storageUri: `ledger://artifacts/${artifactId}`,
        payload: asJson(candidate),
        metadata: asJson({
          taskReference: planning.taskReference,
          attempt: planning.attempt,
          semanticHash: candidate.semanticHash,
          compilerVersion: candidate.compilerVersion,
          workflowHash: candidate.workflowHash,
          promptHash: candidate.receipt.promptHash,
        }),
        createdAt: this.clock.now(),
      },
    );
    if (!saved.ok) return saved;
    if (saved.value.status !== 'planning') {
      throw new Error('Persisted validated candidate changed the planning state');
    }
    return ok(saved.value);
  }

  public recordEvidenceRequest(
    planning: Extract<ImplementationPlanningRecord, { readonly status: 'planning' }>,
    pending: PlanningEvidencePending,
  ): Outcome<
    Extract<ImplementationPlanningRecord, { readonly status: 'planning' }>,
    ImplementationPlanningStoreError
  > {
    const current = this.read(planning.planningEpisodeId);
    if (!current.ok) return current;
    if (current.value?.status !== 'planning' || current.value.attempt !== planning.attempt) {
      return err({ kind: 'planning_attempt_not_current', taskReference: planning.taskReference });
    }
    if (current.value.pendingEvidence !== null) {
      return current.value.pendingEvidence.operationId === pending.operationId
        ? ok(current.value)
        : err({ kind: 'planning_attempt_not_current', taskReference: planning.taskReference });
    }
    const updated = ImplementationPlanningRecordSchema.parse({
      ...current.value,
      pendingEvidence: pending,
    });
    if (updated.status !== 'planning') {
      throw new Error('Planning evidence update changed the planning state');
    }
    const artifactId = `implementation-plan:${planning.planningEpisodeId}:attempt-${String(planning.attempt)}:evidence-round-${String(pending.round)}`;
    const saved = this.persist(
      updated,
      'PlanningEvidenceRequested',
      {
        taskReference: planning.taskReference,
        attempt: planning.attempt,
        round: pending.round,
        operationId: pending.operationId,
        requestCount: pending.requests.length,
        artifactId,
        episodeId: planning.planningEpisodeId,
      },
      {
        artifactId,
        artifactKind: 'planning_evidence_request',
        storageUri: `ledger://artifacts/${artifactId}`,
        payload: asJson(pending),
        metadata: asJson({
          taskReference: planning.taskReference,
          attempt: planning.attempt,
          round: pending.round,
          promptHash: pending.receipt.promptHash,
          usage: pending.receipt.usage,
          apiCost: pending.receipt.apiCost,
        }),
        createdAt: pending.requestedAt,
      },
    );
    if (!saved.ok) return saved;
    if (saved.value.status !== 'planning') {
      throw new Error('Persisted planning evidence changed the planning state');
    }
    return ok(saved.value);
  }

  public completeEvidenceRequest(
    planning: Extract<ImplementationPlanningRecord, { readonly status: 'planning' }>,
    evidenceBundle: EvidenceBundleReference,
  ): Outcome<
    Extract<ImplementationPlanningRecord, { readonly status: 'planning' }>,
    ImplementationPlanningStoreError
  > {
    const current = this.read(planning.planningEpisodeId);
    if (!current.ok) return current;
    if (current.value?.status !== 'planning' || current.value.attempt !== planning.attempt) {
      return err({ kind: 'planning_attempt_not_current', taskReference: planning.taskReference });
    }
    if (current.value.pendingEvidence === null) {
      const completed = current.value.evidenceRounds.some(
        (round) => round.evidenceBundle.artifactId === evidenceBundle.artifactId,
      );
      return completed
        ? ok(current.value)
        : err({ kind: 'planning_attempt_not_current', taskReference: planning.taskReference });
    }
    const completedAt = this.clock.now();
    const round = {
      ...current.value.pendingEvidence,
      evidenceBundle,
      completedAt,
    };
    const updated = ImplementationPlanningRecordSchema.parse({
      ...current.value,
      evidenceBundle,
      evidenceRounds: [...current.value.evidenceRounds, round],
      pendingEvidence: null,
    });
    if (updated.status !== 'planning') {
      throw new Error('Planning evidence completion changed the planning state');
    }
    const saved = this.persist(updated, 'PlanningEvidenceAppended', {
      taskReference: planning.taskReference,
      attempt: planning.attempt,
      round: round.round,
      operationId: round.operationId,
      evidenceBundleArtifactId: evidenceBundle.artifactId,
      evidenceBundleRevision: evidenceBundle.revision,
      episodeId: planning.planningEpisodeId,
    });
    if (!saved.ok) return saved;
    if (saved.value.status !== 'planning') {
      throw new Error('Persisted planning evidence changed the planning state');
    }
    return ok(saved.value);
  }

  public recordValidationRejection(
    planning: Extract<ImplementationPlanningRecord, { readonly status: 'planning' }>,
    issues: readonly string[],
    rejectedDecision:
      Extract<ImplementationPlanningRecord, { readonly status: 'ready' }>['decision'] | null,
  ): Outcome<
    Extract<ImplementationPlanningRecord, { readonly status: 'planning' }>,
    ImplementationPlanningStoreError
  > {
    const current = this.read(planning.planningEpisodeId);
    if (!current.ok) return current;
    if (current.value?.status !== 'planning' || current.value.attempt !== planning.attempt) {
      return err({ kind: 'planning_attempt_not_current', taskReference: planning.taskReference });
    }
    const updated = ImplementationPlanningRecordSchema.parse({
      ...current.value,
      validationFeedback: [...new Set([...current.value.validationFeedback, ...issues])].slice(-50),
      validationRevision: current.value.validationRevision + 1,
      previousDecision: rejectedDecision,
    });
    if (updated.status !== 'planning') {
      throw new Error('Workflow validation feedback changed the planning state');
    }
    const saved = this.persist(updated, 'ImplementationWorkflowCandidateRejected', {
      taskReference: planning.taskReference,
      attempt: planning.attempt,
      issues: [...issues],
      episodeId: planning.planningEpisodeId,
    });
    if (!saved.ok) return saved;
    if (saved.value.status !== 'planning') {
      throw new Error('Persisted workflow validation feedback changed the planning state');
    }
    return ok(saved.value);
  }

  public recordClarificationAnswers(
    planning: Extract<ImplementationPlanningRecord, { readonly status: 'needs_clarification' }>,
    answers: readonly PlanningQuestionAnswer[],
  ): Outcome<{ readonly artifactId: string }, ImplementationPlanningStoreError> {
    const current = this.read(planning.planningEpisodeId);
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

    const artifactId = `planning-answers:${planning.planningEpisodeId}:attempt-${String(planning.attempt)}`;
    const payload = PlanningClarificationAnswerCommandSchema.parse({ answers });
    const existing = this.ledger.readArtifact(artifactId);
    if (existing !== null) {
      const parsed = PlanningClarificationAnswerCommandSchema.safeParse(existing.payload);
      return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(payload)
        ? ok({ artifactId })
        : err({ kind: 'clarification_answer_conflict', taskReference: planning.taskReference });
    }

    const recordedAt = this.clock.now();
    const result = this.ledger.insertArtifact({
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
    });
    if (result) {
      this.ledger.appendStreamEvent({
        taskReference: planning.taskReference,
        eventType: 'PlanningClarificationAnswered',
        payload: asJson({
          taskReference: planning.taskReference,
          attempt: planning.attempt,
          artifactId,
          questionCount: planning.decision.questions.length,
          episodeId: planning.planningEpisodeId,
        }),
        occurredAt: recordedAt,
      });
      return ok({ artifactId });
    }

    const concurrentlyRecorded = this.ledger.readArtifact(artifactId);
    const parsed = PlanningClarificationAnswerCommandSchema.safeParse(
      concurrentlyRecorded?.payload,
    );
    return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(payload)
      ? ok({ artifactId })
      : err({
          kind: 'ledger_conflict',
          conflict: {
            kind: 'version_conflict',
            aggregateId: artifactId,
            expectedVersion: 0,
            actualVersion: 1,
          },
        });
  }

  public fail(
    planning: Extract<ImplementationPlanningRecord, { readonly status: 'planning' }>,
    failure: ImplementationPlanningFailureInput,
    receipt: ImplementationPlannerDecisionSuccess['receipt'] | null = null,
  ): Outcome<ImplementationPlanningRecord, ImplementationPlanningStoreError> {
    const current = this.read(planning.planningEpisodeId);
    if (!current.ok) return current;
    if (current.value?.status !== 'planning' || current.value.attempt !== planning.attempt) {
      return err({ kind: 'planning_attempt_not_current', taskReference: planning.taskReference });
    }
    const { pendingEvidence, validatedCandidate, ...failedPlanning } = current.value;
    void pendingEvidence;
    void validatedCandidate;
    const record = ImplementationPlanningRecordSchema.parse({
      ...failedPlanning,
      status: 'failed',
      completedAt: this.clock.now(),
      failure: planningFailureView(failure),
      receipt,
    });
    if (record.status !== 'failed') {
      throw new Error('Planning failure did not produce a failed record');
    }
    const artifactId = `implementation-plan:${planning.planningEpisodeId}:attempt-${String(planning.attempt)}:failed-provider-output`;
    return this.persist(
      record,
      'ImplementationPlanningFailed',
      {
        taskReference: planning.taskReference,
        attempt: planning.attempt,
        selectedStrategy: planning.selectedStrategy,
        failureKind: failure.kind,
        episodeId: planning.planningEpisodeId,
        ...(receipt === null ? {} : { artifactId }),
      },
      receipt === null
        ? undefined
        : {
            artifactId,
            artifactKind: 'planning_failed_provider_output',
            storageUri: `ledger://artifacts/${artifactId}`,
            payload: asJson({ failure: record.failure, receipt }),
            metadata: asJson({
              taskReference: planning.taskReference,
              attempt: planning.attempt,
              promptHash: receipt.promptHash,
              usage: receipt.usage,
              apiCost: receipt.apiCost,
            }),
            createdAt: record.completedAt,
          },
    );
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
    const existing = this.ledger.readDocument(DOCUMENT_KIND, record.planningEpisodeId);
    const timestamp =
      'completedAt' in record
        ? record.completedAt
        : eventType === 'ImplementationPlanningStarted'
          ? record.startedAt
          : this.clock.now();
    if (artifact !== undefined) this.ledger.insertArtifact(artifact);
    const saved =
      existing === null
        ? this.ledger.insertDocument({
            kind: DOCUMENT_KIND,
            id: record.planningEpisodeId,
            revision: 1,
            payload: asJson(record),
            createdAt: timestamp,
            updatedAt: timestamp,
          })
        : this.ledger.appendDocument(
            DOCUMENT_KIND,
            record.planningEpisodeId,
            existing.revision,
            asJson(record),
            timestamp,
          ).ok;
    if (!saved) {
      return err({
        kind: 'ledger_conflict',
        conflict: {
          kind: 'version_conflict',
          aggregateId: record.planningEpisodeId,
          expectedVersion: existing?.revision ?? 0,
          actualVersion:
            this.ledger.readDocument(DOCUMENT_KIND, record.planningEpisodeId)?.revision ?? 0,
        },
      });
    }
    this.ledger.appendStreamEvent({
      taskReference: record.taskReference,
      eventType,
      payload,
      occurredAt: timestamp,
    });
    return ok(record);
  }
}

const planningFailureView = (
  failure: ImplementationPlanningFailureInput,
): ImplementationPlanningFailure => {
  switch (failure.kind) {
    case 'project_validation_missing':
      return {
        ...failure,
        expectedKeys: [...failure.expectedKeys],
        missingKeys: [...failure.missingKeys],
        message: `Project ${failure.repositoryReference} must declare ${failure.expectedKeys.join(', ')}; missing ${failure.missingKeys.join(', ')}.`,
        retryable: false,
      };
    case 'invalid_skill_selection':
      return { kind: failure.kind, message: failure.issues.join('; '), retryable: false };
    case 'invalid_skill_package':
    case 'skill_unavailable':
      return { kind: failure.kind, message: failure.message, retryable: false };
    case 'skill_materialization_failed':
      return { kind: failure.kind, message: failure.message, retryable: true };
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
      return { kind: failure.kind, message: failure.issues.join('; '), retryable: false };
  }
};
