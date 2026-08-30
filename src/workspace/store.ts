import type { LedgerRepository } from '../store/repository.js';
import type { JsonValue, LedgerConflict } from '../store/types.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { JsonValueSchema } from '../graph/schema.js';
import {
  WorkspaceBootstrapReceiptSchema,
  WorkspaceLocatorSchema,
  type WorkspaceBootstrapReceipt,
  type WorkspaceLocator,
} from './contracts.js';

export const WORKSPACE_PROJECTION = 'workspace_by_run';
export const WORKSPACE_BOOTSTRAP_PROJECTION = 'workspace_bootstrap_by_workspace';

export type WorkspaceStoreError =
  | { readonly kind: 'ledger_conflict'; readonly conflict: LedgerConflict }
  | { readonly kind: 'aggregate_missing'; readonly workspaceId: string }
  | {
      readonly kind: 'projection_corrupt';
      readonly workspaceId: string;
      readonly issues: readonly string[];
    };

const asJson = (value: unknown): JsonValue => JsonValueSchema.parse(value);
const aggregateIdFor = (workspaceId: string): string => `workspace:${workspaceId}`;

export class WorkspaceStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public now(): string {
    return this.clock.now();
  }

  public read(workspaceId: string): Outcome<WorkspaceLocator | null, WorkspaceStoreError> {
    const projection = this.ledger.readProjection(WORKSPACE_PROJECTION, workspaceId);
    if (projection === null) return ok(null);
    const parsed = WorkspaceLocatorSchema.safeParse(projection.payload);
    return parsed.success
      ? ok(parsed.data)
      : err({
          kind: 'projection_corrupt',
          workspaceId,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
  }

  public listByTaskReference(
    taskReference: string,
  ): Outcome<readonly WorkspaceLocator[], WorkspaceStoreError> {
    const workspaces: WorkspaceLocator[] = [];
    for (const projection of this.ledger.listProjections(WORKSPACE_PROJECTION)) {
      const parsed = WorkspaceLocatorSchema.safeParse(projection.payload);
      if (!parsed.success) {
        return err({
          kind: 'projection_corrupt',
          workspaceId: projection.projectionId,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
      }
      if (parsed.data.taskReference === taskReference) workspaces.push(parsed.data);
    }
    return ok(workspaces);
  }

  public save(locatorInput: WorkspaceLocator): Outcome<WorkspaceLocator, WorkspaceStoreError> {
    const locator = WorkspaceLocatorSchema.parse(locatorInput);
    const existing = this.read(locator.workspaceId);
    if (!existing.ok) return existing;
    if (existing.value !== null) return ok(existing.value);
    const aggregateId = aggregateIdFor(locator.workspaceId);
    const committed = this.ledger.transact({
      aggregate: {
        aggregateId,
        expectedVersion: 0,
        events: [
          {
            eventId: `event:${aggregateId}:1`,
            eventType: 'WorkspacePrepared',
            eventSchemaVersion: 1,
            payload: asJson({
              workspaceId: locator.workspaceId,
              taskReference: locator.taskReference,
              workflowId: locator.workflowId,
              workflowRunId: locator.workflowRunId,
              repositoryReference: locator.repository.reference,
              baseCommit: locator.repository.baseCommit,
              branch: locator.branch,
              path: locator.path,
            }),
            actor: 'workspace_manager',
          },
        ],
      },
      projections: [
        {
          kind: 'upsert',
          projectionType: WORKSPACE_PROJECTION,
          projectionId: locator.workspaceId,
          payload: asJson(locator),
        },
      ],
      timestamp: locator.preparedAt,
    });
    if (committed.ok) return ok(locator);
    const concurrent = this.read(locator.workspaceId);
    return concurrent.ok && concurrent.value !== null
      ? ok(concurrent.value)
      : err({ kind: 'ledger_conflict', conflict: committed.error });
  }

  public retire(workspaceId: string): Outcome<void, WorkspaceStoreError> {
    const existing = this.read(workspaceId);
    if (!existing.ok) return existing;
    if (existing.value === null) return ok(undefined);
    const aggregateId = aggregateIdFor(workspaceId);
    const head = this.ledger.readAggregateHead(aggregateId);
    if (head === null) return err({ kind: 'aggregate_missing', workspaceId });
    const retiredAt = this.clock.now();
    const committed = this.ledger.transact({
      aggregate: {
        aggregateId,
        expectedVersion: head.version,
        events: [
          {
            eventId: `event:${aggregateId}:${String(head.version + 1)}`,
            eventType: 'WorkspaceRetired',
            eventSchemaVersion: 1,
            payload: asJson({ workspaceId }),
            actor: 'workspace_manager',
          },
        ],
      },
      projections: [
        { kind: 'delete', projectionType: WORKSPACE_PROJECTION, projectionId: workspaceId },
        {
          kind: 'delete',
          projectionType: WORKSPACE_BOOTSTRAP_PROJECTION,
          projectionId: workspaceId,
        },
      ],
      timestamp: retiredAt,
    });
    return committed.ok
      ? ok(undefined)
      : err({ kind: 'ledger_conflict', conflict: committed.error });
  }
}

export class WorkspaceBootstrapStore {
  public constructor(private readonly ledger: LedgerRepository) {}

  public read(workspaceId: string): Outcome<WorkspaceBootstrapReceipt | null, WorkspaceStoreError> {
    const projection = this.ledger.readProjection(WORKSPACE_BOOTSTRAP_PROJECTION, workspaceId);
    if (projection === null) return ok(null);
    const parsed = WorkspaceBootstrapReceiptSchema.safeParse(projection.payload);
    return parsed.success
      ? ok(parsed.data)
      : err({
          kind: 'projection_corrupt',
          workspaceId,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
  }

  public save(
    receiptInput: WorkspaceBootstrapReceipt,
  ): Outcome<WorkspaceBootstrapReceipt, WorkspaceStoreError> {
    const receipt = WorkspaceBootstrapReceiptSchema.parse(receiptInput);
    const existing = this.read(receipt.workspaceId);
    if (!existing.ok) return existing;
    if (existing.value !== null) return ok(existing.value);
    const aggregateId = `workspace-bootstrap:${receipt.workspaceId}`;
    const committed = this.ledger.transact({
      aggregate: {
        aggregateId,
        expectedVersion: 0,
        events: [
          {
            eventId: `event:${aggregateId}:1`,
            eventType: 'WorkspaceBootstrapPrepared',
            eventSchemaVersion: 1,
            payload: asJson({
              operationId: receipt.operationId,
              workspaceId: receipt.workspaceId,
              adapterId: receipt.adapterId,
              adapterVersion: receipt.adapterVersion,
              profile: receipt.profile,
              files: receipt.files,
            }),
            actor: 'workspace_bootstrap',
          },
        ],
      },
      projections: [
        {
          kind: 'upsert',
          projectionType: WORKSPACE_BOOTSTRAP_PROJECTION,
          projectionId: receipt.workspaceId,
          payload: asJson(receipt),
        },
      ],
      timestamp: receipt.completedAt,
    });
    if (committed.ok) return ok(receipt);
    const concurrent = this.read(receipt.workspaceId);
    return concurrent.ok && concurrent.value !== null
      ? ok(concurrent.value)
      : err({ kind: 'ledger_conflict', conflict: committed.error });
  }
}
