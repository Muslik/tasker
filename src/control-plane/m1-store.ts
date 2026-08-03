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
import { WorkflowViewSchema, type WorkflowView } from './m1-contracts.js';

export const M1_WORKFLOW_PROJECTION = 'm1_workflow';
export const M1_ANALYZER_PROJECTION = 'm1_analyzer';

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
    };

export interface M1StoreResult {
  readonly disposition: 'already_exists' | 'saved';
  readonly view: WorkflowView;
}

const asJson = (value: unknown): JsonValue => value as JsonValue;

const workflowAggregateId = (taskReference: string): string =>
  taskReference.startsWith('jira:') ? `workflow:${taskReference}` : `intake:${taskReference}`;

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
    projectionType: 'm1_analyzer' | 'm1_intake' | 'm1_run' | 'm1_task',
    projectionId: string,
  ): JsonValue | null {
    return this.ledger.readProjection(projectionType, projectionId)?.payload ?? null;
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

  public save(
    viewInput: WorkflowView,
    artifacts: M1WorkflowArtifacts,
    analyzerReceipt?: WorkflowAnalyzerReceipt,
    options: { readonly projectTask?: boolean } = {},
  ): Outcome<M1StoreResult, M1StoreError> {
    const candidateView = WorkflowViewSchema.parse(viewInput);
    const existing = this.read(candidateView.fixture.id);

    if (!existing.ok) {
      return existing;
    }

    if (existing.value?.workflow.status === 'valid') {
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
        actor: 'codex_cli_analyzer',
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
