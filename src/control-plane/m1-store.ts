import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import type { LedgerRepository } from '../ledger/repository.js';
import type { ArtifactWrite, JsonValue, LedgerConflict } from '../ledger/types.js';
import { WorkflowViewSchema, type WorkflowView } from './m1-contracts.js';

export const M1_WORKFLOW_PROJECTION = 'm1_workflow';

export interface M1WorkflowArtifacts {
  readonly proposal: JsonValue;
  readonly validatorReport: JsonValue;
  readonly diff: JsonValue;
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
    projectionType: 'm1_intake' | 'm1_run' | 'm1_task',
    projectionId: string,
  ): JsonValue | null {
    return this.ledger.readProjection(projectionType, projectionId)?.payload ?? null;
  }

  public save(
    viewInput: WorkflowView,
    artifacts: M1WorkflowArtifacts,
  ): Outcome<M1StoreResult, M1StoreError> {
    const view = WorkflowViewSchema.parse(viewInput);
    const existing = this.read(view.fixture.id);

    if (!existing.ok) {
      return existing;
    }

    if (existing.value !== null) {
      return ok({ disposition: 'already_exists', view: existing.value });
    }

    const fixtureId = view.fixture.id;
    const aggregateId = `intake:${fixtureId}`;
    const proposalArtifactId = `proposal:${fixtureId}`;
    const artifactWrites: ArtifactWrite[] = [
      {
        artifactId: proposalArtifactId,
        artifactKind: 'workflow_proposal',
        storageUri: `ledger://artifacts/${proposalArtifactId}`,
        payload: artifacts.proposal,
        metadata: { analyzer: 'm1-deterministic@1' },
      },
      {
        artifactId: `validator:${fixtureId}`,
        artifactKind: 'workflow_validator_report',
        storageUri: `ledger://artifacts/validator:${fixtureId}`,
        payload: artifacts.validatorReport,
        metadata: { workflowStatus: view.workflow.status },
        parentArtifactId: proposalArtifactId,
      },
      {
        artifactId: `diff:${fixtureId}`,
        artifactKind: 'workflow_template_diff',
        storageUri: `ledger://artifacts/diff:${fixtureId}`,
        payload: artifacts.diff,
        metadata: { templateId: view.workflow.templateId },
        parentArtifactId: proposalArtifactId,
      },
    ];

    if (artifacts.compiledGraph !== undefined) {
      artifactWrites.push({
        artifactId: `graph:${fixtureId}`,
        artifactKind: 'compiled_workflow_graph',
        storageUri: `ledger://artifacts/graph:${fixtureId}`,
        payload: artifacts.compiledGraph,
        metadata: { graphHash: view.workflow.graphHash ?? 'rejected' },
        parentArtifactId: proposalArtifactId,
      });
    }

    const persistedAt = this.clock.now();
    const result = this.ledger.transact({
      aggregate: {
        aggregateId,
        expectedVersion: 0,
        events: [
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
          {
            eventId: `event:workflow-planned:${fixtureId}`,
            eventType: view.workflow.status === 'valid' ? 'WorkflowPlanned' : 'WorkflowRejected',
            eventSchemaVersion: 1,
            payload: {
              fixtureId,
              graphHash: view.workflow.graphHash,
              status: view.workflow.status,
            },
            actor: 'm1_deterministic_planner',
          },
        ],
      },
      snapshots: [
        {
          snapshotId: `snapshot:${fixtureId}`,
          aggregateId,
          aggregateVersion: 3,
          snapshotSchemaVersion: 1,
          payload: asJson(view),
        },
      ],
      projections: [
        {
          kind: 'upsert',
          projectionType: 'm1_intake',
          projectionId: view.intake.id,
          payload: asJson({ fixture: view.fixture, intake: view.intake }),
        },
        {
          kind: 'upsert',
          projectionType: 'm1_task',
          projectionId: view.task.id,
          payload: asJson({ fixture: view.fixture, task: view.task }),
        },
        {
          kind: 'upsert',
          projectionType: M1_WORKFLOW_PROJECTION,
          projectionId: fixtureId,
          payload: asJson(view),
        },
      ],
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
