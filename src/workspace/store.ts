import type { LedgerRepository } from '../store/repository.js';
import type { DocumentConflict, LedgerConflict } from '../store/types.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  WorkspaceBootstrapReceiptSchema,
  WorkspaceLocatorSchema,
  type WorkspaceBootstrapReceipt,
  type WorkspaceLocator,
} from './contracts.js';

export const WORKSPACE_PROJECTION = 'workspace';
export const WORKSPACE_BOOTSTRAP_PROJECTION = 'workspace_bootstrap';

export type WorkspaceStoreError =
  | { readonly kind: 'ledger_conflict'; readonly conflict: LedgerConflict }
  | { readonly kind: 'aggregate_missing'; readonly workspaceId: string }
  | {
      readonly kind: 'projection_corrupt';
      readonly workspaceId: string;
      readonly issues: readonly string[];
    };

const ledgerConflictFromDocumentConflict = (conflict: DocumentConflict): LedgerConflict => ({
  kind: 'version_conflict',
  aggregateId: `document:${conflict.documentKind}:${conflict.documentId}`,
  expectedVersion: conflict.expectedRevision,
  actualVersion: conflict.actualRevision,
});

export class WorkspaceStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public now(): string {
    return this.clock.now();
  }

  public read(workspaceId: string): Outcome<WorkspaceLocator | null, WorkspaceStoreError> {
    const document = this.ledger.readDocument(WORKSPACE_PROJECTION, workspaceId);
    if (document === null) return ok(null);
    const parsed = WorkspaceLocatorSchema.safeParse(document.payload);
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
    for (const document of this.ledger.listDocuments(WORKSPACE_PROJECTION)) {
      const parsed = WorkspaceLocatorSchema.safeParse(document.payload);
      if (!parsed.success) {
        return err({
          kind: 'projection_corrupt',
          workspaceId: document.id,
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
    const committed = this.ledger.appendDocument(
      WORKSPACE_PROJECTION,
      locator.workspaceId,
      0,
      locator,
      locator.preparedAt,
    );
    if (committed.ok) return ok(locator);
    const concurrent = this.read(locator.workspaceId);
    return concurrent.ok && concurrent.value !== null
      ? ok(concurrent.value)
      : err({
          kind: 'ledger_conflict',
          conflict: ledgerConflictFromDocumentConflict(committed.error),
        });
  }

  public retire(workspaceId: string): Outcome<void, WorkspaceStoreError> {
    const existing = this.read(workspaceId);
    if (!existing.ok) return existing;
    if (existing.value === null) return ok(undefined);
    this.ledger.deleteDocuments(WORKSPACE_PROJECTION, workspaceId);
    this.ledger.deleteDocuments(WORKSPACE_BOOTSTRAP_PROJECTION, workspaceId);
    return ok(undefined);
  }
}

export class WorkspaceBootstrapStore {
  public constructor(private readonly ledger: LedgerRepository) {}

  public read(workspaceId: string): Outcome<WorkspaceBootstrapReceipt | null, WorkspaceStoreError> {
    const document = this.ledger.readDocument(WORKSPACE_BOOTSTRAP_PROJECTION, workspaceId);
    if (document === null) return ok(null);
    const parsed = WorkspaceBootstrapReceiptSchema.safeParse(document.payload);
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
    const committed = this.ledger.appendDocument(
      WORKSPACE_BOOTSTRAP_PROJECTION,
      receipt.workspaceId,
      0,
      receipt,
      receipt.completedAt,
    );
    if (committed.ok) return ok(receipt);
    const concurrent = this.read(receipt.workspaceId);
    return concurrent.ok && concurrent.value !== null
      ? ok(concurrent.value)
      : err({
          kind: 'ledger_conflict',
          conflict: ledgerConflictFromDocumentConflict(committed.error),
        });
  }
}
