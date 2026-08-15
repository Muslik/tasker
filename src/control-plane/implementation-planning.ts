import { z } from 'zod';

import {
  applyHarnessPolicySkills,
  harnessPolicyAppliesToTask,
  loadHarnessPack,
  resolveAgentExecutionProfile,
  resolveImplementationPlannerProfile,
} from '../harness/index.js';
import type { LoadedHarnessPack, LoadedPrompt } from '../harness/index.js';
import type { EventRecord, JsonValue, LedgerConflict } from '../ledger/types.js';
import type { LedgerRepository } from '../ledger/repository.js';
import { checksumString } from '../ledger/checksum.js';
import {
  ImplementationPlanLinkSchema,
  PlanningClarificationAnswerCommandSchema,
  PlanningStrategySchema,
  validateAcceptanceVerificationLinks,
  type PlanningStrategy,
  type PlanningStrategyRequest,
  type PlanningQuestionAnswer,
  type ImplementationPlanLink,
} from '../planning/implementation-plan.js';
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
  PlanningSnapshotReferenceSchema,
  PlanningContextSnapshotSchema,
  ExecutionRunSnapshotSchema,
  RunPlanningSnapshotSchema,
} from '../planning/run-planning-snapshot.js';
import type { ImplementationPlanningFailureSchema } from '../planning/planning-failure.js';
import type {
  ImplementationPlanner,
  ImplementationPlannerDecisionSuccess,
  ImplementationPlannerFailure,
} from '../providers/implementation-planner.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { CompiledWorkflowSchema, JsonValueSchema } from '../workflow/schema.js';
import {
  OperatorActivityEntrySchema,
  OperatorStreamEventSchema,
  type OperatorActivityResponse,
  type OperatorStreamEvent,
  type OperatorTaskSummary,
} from './operator-contracts.js';
import {
  ImplementationPlanningRecordSchema,
  ValidatedPlanningCandidateSchema,
} from './implementation-planning-contracts.js';
import type {
  ImplementationPlanningRecord,
  PlanningEvidencePending,
  ReadyImplementationPlanningRecord,
  ValidatedPlanningCandidate,
} from './implementation-planning-contracts.js';
import {
  PlanningTranscriptStore,
  planningTranscriptIdFor,
  type PlanningTranscriptStoreError,
  type PlanningTranscriptView,
} from './planning-transcript.js';
import type { OperatorServiceError, OperatorWorkflowService } from './operator-service.js';
import { EvidenceBundleStore, type EvidenceBundleStoreError } from './evidence-bundle.js';
import type {
  PlanningEvidenceReaderRegistry,
  PlanningEvidenceReadError,
} from './planning-evidence.js';

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

const asJson = (value: unknown): JsonValue => JsonValueSchema.parse(value);
const aggregateIdFor = (planningEpisodeId: string): string =>
  `implementation-plan:${planningEpisodeId}`;

const PlanningActivityEventPayloadSchema = z.looseObject({
  attempt: z.number().int().positive(),
  episodeId: z.string().min(1).optional(),
  selectedStrategy: PlanningStrategySchema.optional(),
  strategy: PlanningStrategySchema.optional(),
});

type PlanningActivityStatus =
  'running' | 'ready' | 'needs_clarification' | 'investigation_required' | 'paused';

interface PlanningActivityEpisode {
  readonly attempts: Set<number>;
  strategy: PlanningStrategy;
  status: PlanningActivityStatus;
  sequence: number;
  occurredAt: string;
}

const planningActivityDetail = (episode: PlanningActivityEpisode): string => {
  const status =
    episode.status === 'running'
      ? 'Running'
      : episode.status === 'ready'
        ? 'Ready'
        : episode.status === 'needs_clarification'
          ? 'Waiting for clarification'
          : episode.status === 'investigation_required'
            ? 'Investigation required'
            : 'Paused after provider failure';
  const attempts = episode.attempts.size;
  return `${status} · ${episode.strategy} · ${String(attempts)} provider ${attempts === 1 ? 'attempt' : 'attempts'}.`;
};

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
    const projection = this.ledger.readProjection(
      IMPLEMENTATION_PLAN_PROJECTION,
      planningEpisodeId,
    );
    if (projection === null) return ok(null);
    const parsed = ImplementationPlanningRecordSchema.safeParse(projection.payload);
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

  public listEvents(planningEpisodeId?: string): readonly EventRecord[] {
    return planningEpisodeId === undefined
      ? this.ledger
          .listEvents()
          .filter((event) => event.aggregateId.startsWith('implementation-plan:'))
      : this.ledger.listEvents(aggregateIdFor(planningEpisodeId));
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

    const aggregateId = artifactId;
    const result = this.ledger.transact({
      aggregate: {
        aggregateId,
        expectedVersion: 0,
        events: [
          {
            eventId: `event:${aggregateId}:1`,
            eventType: 'PlanningRunSnapshotCreated',
            eventSchemaVersion: 1,
            payload: asJson({ artifactId, kind: snapshot.kind, snapshotHash }),
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
            kind: snapshot.kind,
            snapshotHash,
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
      schemaVersion: 2,
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
        strategy: planning.selectedStrategy,
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
          hypotheticalApiCostUsd: pending.receipt.hypotheticalApiCostUsd,
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
    rejectedDecision: Extract<
      ImplementationPlanningRecord,
      { readonly status: 'ready' }
    >['decision'],
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

    const aggregateId = aggregateIdFor(planning.planningEpisodeId);
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
              episodeId: planning.planningEpisodeId,
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
        strategy: planning.selectedStrategy,
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
              hypotheticalApiCostUsd: receipt.hypotheticalApiCostUsd,
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
    const aggregateId = aggregateIdFor(record.planningEpisodeId);
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
          projectionId: record.planningEpisodeId,
          payload: asJson(record),
        },
      ],
      ...(artifact === undefined ? {} : { artifacts: [artifact] }),
      timestamp:
        'completedAt' in record
          ? record.completedAt
          : eventType === 'ImplementationPlanningStarted'
            ? record.startedAt
            : this.clock.now(),
    });
    return result.ok ? ok(record) : err({ kind: 'ledger_conflict', conflict: result.error });
  }
}

const planningFailureView = (
  failure: ImplementationPlannerFailure,
): z.infer<typeof ImplementationPlanningFailureSchema> => {
  switch (failure.kind) {
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

const snapshotPrompt = (prompt: LoadedPrompt) => ({
  relativePath: prompt.relativePath,
  content: prompt.content,
  contentSha256: prompt.contentSha256,
});

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
        step.block.executor.kind !== 'process' ||
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

const resolveSnapshottedProcess = (
  executor: string,
  pack: LoadedHarnessPack,
  project: LoadedHarnessPack['projects'][number] | undefined,
): LoadedHarnessPack['company']['processCommands'][string] | null =>
  project?.processCommands[executor] ?? pack.company.processCommands[executor] ?? null;

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
    const contextHash = checksumString(
      JSON.stringify({
        task: subject.value.task,
        taskSnapshot: subject.value.taskSnapshot,
        repository: workspace,
        harness,
      }),
    );
    const snapshot: PlanningContextSnapshot = PlanningContextSnapshotSchema.parse({
      schemaVersion: 9,
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
      schemaVersion: 9,
      kind: 'execution',
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
        steps: planningContext.value.harness.steps.filter(({ reference }) =>
          referencedSteps.has(reference),
        ),
      },
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

  public prepare(
    taskReference: string,
    requestedStrategy: PlanningStrategyRequest,
    commandId: string,
    planningEpisodeId: string,
    snapshotReference: PlanningSnapshotReference,
    evidenceReference: EvidenceBundleReference,
    operatorGuidance: string | null = null,
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
      graph: graph.data,
      planningSnapshot: record.executionSnapshot,
      evidenceBundle: record.evidenceBundle,
    });
  }

  public decorateTask(task: OperatorTaskSummary): OperatorTaskSummary {
    return task;
  }

  public readActivity(planningEpisodeId: string): OperatorActivityResponse['entries'] {
    const entries: Array<OperatorActivityResponse['entries'][number]> = [];
    const episodes = new Map<string, PlanningActivityEpisode>();
    let legacyEpisodeId: string | null = null;

    const recordEpisode = (
      event: EventRecord,
      status: PlanningActivityStatus,
      terminal: boolean,
    ): void => {
      const payload = PlanningActivityEventPayloadSchema.safeParse(event.payload);
      if (!payload.success) {
        throw new Error(`Invalid implementation planning event payload: ${event.eventType}`);
      }
      const strategy = payload.data.selectedStrategy ?? payload.data.strategy;
      if (strategy === undefined) {
        throw new Error(`Implementation planning event has no strategy: ${event.eventType}`);
      }
      const explicitEpisodeId = payload.data.episodeId;
      const episodeId = explicitEpisodeId ?? legacyEpisodeId ?? `legacy:${String(event.sequence)}`;
      if (explicitEpisodeId === undefined && legacyEpisodeId === null) {
        legacyEpisodeId = episodeId;
      }
      const existing = episodes.get(episodeId);
      if (existing === undefined) {
        episodes.set(episodeId, {
          attempts: new Set([payload.data.attempt]),
          strategy,
          status,
          sequence: event.sequence,
          occurredAt: event.occurredAt,
        });
      } else {
        existing.attempts.add(payload.data.attempt);
        existing.strategy = strategy;
        existing.status = status;
        existing.sequence = event.sequence;
        existing.occurredAt = event.occurredAt;
      }
      if (terminal && explicitEpisodeId === undefined) legacyEpisodeId = null;
    };

    const planningEvents = this.store.listEvents(planningEpisodeId);
    for (const event of planningEvents) {
      switch (event.eventType) {
        case 'ImplementationPlanningStarted':
          recordEpisode(event, 'running', false);
          continue;
        case 'ImplementationPlanReady':
          recordEpisode(event, 'ready', true);
          continue;
        case 'ImplementationPlanNeedsClarification':
          recordEpisode(event, 'needs_clarification', true);
          continue;
        case 'ImplementationPlanInvestigationRequired':
          recordEpisode(event, 'investigation_required', true);
          continue;
        case 'ImplementationPlanningFailed':
          recordEpisode(event, 'paused', false);
          continue;
        case 'ImplementationWorkflowCandidateValidated':
          continue;
      }

      const common = {
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        source: 'planner' as const,
        level: 'info' as const,
      };
      switch (event.eventType) {
        case 'PlanningEvidenceRequested':
          entries.push(
            OperatorActivityEntrySchema.parse({
              ...common,
              title: 'Planner requested additional evidence',
              detail:
                'The request and provider cost receipt were persisted before the external read.',
            }),
          );
          break;
        case 'PlanningEvidenceAppended':
          entries.push(
            OperatorActivityEntrySchema.parse({
              ...common,
              title: 'Planning evidence appended',
              detail:
                'Tasker recorded the mediated result with provenance and resumed the same plan.',
            }),
          );
          break;
        case 'PlanningClarificationAnswered':
          entries.push(
            OperatorActivityEntrySchema.parse({
              ...common,
              source: 'operator',
              title: 'Planning clarification answered',
              detail: 'The typed answers were persisted and the same planning episode resumed.',
            }),
          );
          break;
        case 'ImplementationWorkflowCandidateRejected': {
          const corrected = planningEvents.some(
            (candidate) =>
              candidate.sequence > event.sequence &&
              candidate.eventType === 'ImplementationWorkflowCandidateValidated',
          );
          entries.push(
            OperatorActivityEntrySchema.parse({
              ...common,
              level: corrected ? 'info' : 'warning',
              title: corrected ? 'Workflow candidate corrected' : 'Workflow candidate rejected',
              detail: corrected
                ? 'The validator returned exact feedback, and the same planner produced a valid candidate.'
                : 'The deterministic validator returned exact feedback to the same planner.',
            }),
          );
          break;
        }
        default:
          throw new Error(`Unmapped implementation planning event: ${event.eventType}`);
      }
    }

    for (const episode of episodes.values()) {
      entries.push(
        OperatorActivityEntrySchema.parse({
          sequence: episode.sequence,
          occurredAt: episode.occurredAt,
          source: 'planner',
          level:
            episode.status === 'paused' ||
            episode.status === 'needs_clarification' ||
            episode.status === 'investigation_required'
              ? 'warning'
              : 'info',
          title: 'Implementation planning',
          detail: planningActivityDetail(episode),
        }),
      );
    }

    return entries.sort((left, right) => left.sequence - right.sequence);
  }

  public listStreamEventsAfter(sequence: number): readonly OperatorStreamEvent[] {
    return this.store
      .listEvents()
      .filter((event) => event.sequence > sequence)
      .flatMap((event) => {
        const payload = z
          .looseObject({ taskReference: z.string().min(1) })
          .safeParse(event.payload);
        return payload.success
          ? [
              OperatorStreamEventSchema.parse({
                sequence: event.sequence,
                taskReference: payload.data.taskReference,
                eventType: event.eventType,
              }),
            ]
          : [];
      });
  }

  private async prepareOnce(
    taskReference: string,
    requestedStrategy: PlanningStrategyRequest,
    commandId: string,
    planningEpisodeId: string,
    snapshotReference: PlanningSnapshotReference,
    evidenceReference: EvidenceBundleReference,
    operatorGuidance: string | null,
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
          repositoryReference: planningInput.subject.task.repository,
          operatorGuidance,
          validationFeedback: planning.validationFeedback,
          previousDecision: planning.previousDecision,
        },
        promptTemplate: planningInput.promptTemplate,
      });
      if (!result.ok) {
        const failed = this.store.fail(planning, result.error);
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
          const acceptanceIssues = validateAcceptanceVerificationLinks(result.value.decision);
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
            result.value.decision.workflow,
            operationId,
          );
          if (!assembled.ok) {
            const failed = this.store.fail(
              planning,
              {
                kind: 'invalid_planner_output',
                issues: [`Workflow assembly failed: ${assembled.error.kind}`],
              },
              result.value.receipt,
            );
            return failed.ok ? failed : err({ kind: 'store', error: failed.error });
          }
          if (
            assembled.value.status !== 'ready' ||
            assembled.value.view.workflow.graphHash === null
          ) {
            const issues = assembled.value.view.workflow.validatorReport.issues.map(
              ({ message }) => message,
            );
            if (planning.validationRevision >= 2) {
              const failed = this.store.fail(
                planning,
                { kind: 'invalid_planner_output', issues },
                result.value.receipt,
              );
              return failed.ok ? failed : err({ kind: 'store', error: failed.error });
            }
            const rejected = this.store.recordValidationRejection(
              planning,
              issues,
              result.value.decision,
            );
            if (!rejected.ok) return err({ kind: 'store', error: rejected.error });
            planning = rejected.value;
            continue;
          }
          const workflowHash = assembled.value.view.workflow.graphHash;
          const graph = CompiledWorkflowSchema.safeParse(assembled.value.view.workflow.graph);
          if (!graph.success) {
            const failed = this.store.fail(
              planning,
              { kind: 'invalid_planner_output', issues: ['Compiled workflow graph is corrupt.'] },
              result.value.receipt,
            );
            return failed.ok ? failed : err({ kind: 'store', error: failed.error });
          }
          const blockByReference = new Map(
            planningInput.blocks.map((block) => [block.reference, block] as const),
          );
          const phaseIssues = graph.data.metadata.references.stepTypes.flatMap((reference) => {
            const block = blockByReference.get(reference);
            return block?.availableDuring.includes('execution') === true
              ? []
              : [`Block ${reference} is not available during execution.`];
          });
          if (phaseIssues.length > 0) {
            if (planning.validationRevision >= 2) {
              const failed = this.store.fail(
                planning,
                { kind: 'invalid_planner_output', issues: phaseIssues },
                result.value.receipt,
              );
              return failed.ok ? failed : err({ kind: 'store', error: failed.error });
            }
            const rejected = this.store.recordValidationRejection(
              planning,
              phaseIssues,
              result.value.decision,
            );
            if (!rejected.ok) return err({ kind: 'store', error: rejected.error });
            planning = rejected.value;
            continue;
          }
          const checkpointed = this.store.recordValidatedCandidate(planning, {
            decision: result.value.decision,
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
      asJson({
        artifactId: `implementation-plan:${planning.planningEpisodeId}:attempt-${String(planning.attempt)}`,
        attempt: planning.attempt,
        selectedStrategy: planning.selectedStrategy,
        plan: candidate.decision.plan,
      }),
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
