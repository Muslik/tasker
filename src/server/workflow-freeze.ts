import type { LedgerRepository } from '../store/repository.js';
import type { JsonValue } from '../store/types.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  FreezeTaskWorkflowInputSchema,
  WorkflowFreezeReceiptSchema,
  type FreezeTaskWorkflowInput,
  type WorkflowFreezeReceipt,
} from '../kernel/freeze-contracts.js';
import { JsonValueSchema } from '../graph/schema.js';

export type WorkflowFreezeStoreError =
  | { readonly kind: 'ledger_conflict' }
  | { readonly kind: 'receipt_conflict'; readonly receiptId: string }
  | {
      readonly kind: 'receipt_corrupt';
      readonly receiptId: string;
      readonly issues: readonly string[];
    };

const asJson = (value: unknown): JsonValue => JsonValueSchema.parse(value);
const receiptIdFor = (input: FreezeTaskWorkflowInput): string =>
  `workflow-freeze:${input.workflowId}:${input.workflowRunId}`;
const receiptIdFromRun = (workflowId: string, workflowRunId: string): string =>
  `workflow-freeze:${workflowId}:${workflowRunId}`;

const parseReceipt = (
  receiptId: string,
  payload: JsonValue,
): Outcome<WorkflowFreezeReceipt, WorkflowFreezeStoreError> => {
  const parsed = WorkflowFreezeReceiptSchema.safeParse(payload);
  return parsed.success
    ? ok(parsed.data)
    : err({
        kind: 'receipt_corrupt',
        receiptId,
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
        ),
      });
};

const matchesInput = (receipt: WorkflowFreezeReceipt, input: FreezeTaskWorkflowInput): boolean =>
  receipt.taskReference === input.taskReference &&
  receipt.workflowId === input.workflowId &&
  receipt.workflowRunId === input.workflowRunId &&
  receipt.workflowHash === input.workflowHash &&
  receipt.semanticHash === input.semanticHash &&
  receipt.compilerVersion === input.compilerVersion &&
  receipt.harnessSnapshotHash === input.harnessSnapshotHash &&
  receipt.planningAttempt === input.planningAttempt &&
  receipt.planningArtifactId === input.planningArtifactId &&
  receipt.planningSnapshot.artifactId === input.planningSnapshot.artifactId &&
  receipt.planningSnapshot.checksum === input.planningSnapshot.checksum &&
  receipt.evidenceBundle.artifactId === input.evidenceBundle.artifactId &&
  receipt.evidenceBundle.checksum === input.evidenceBundle.checksum &&
  receipt.evidenceBundle.revision === input.evidenceBundle.revision &&
  receipt.approval.kind === input.approval.kind;

export class WorkflowFreezeStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public read(
    workflowId: string,
    workflowRunId: string,
  ): Outcome<WorkflowFreezeReceipt | null, WorkflowFreezeStoreError> {
    const receiptId = receiptIdFromRun(workflowId, workflowRunId);
    const artifact = this.ledger.readArtifact(receiptId);
    return artifact === null ? ok(null) : parseReceipt(receiptId, artifact.payload);
  }

  public readLatest(
    taskReference: string,
  ): Outcome<WorkflowFreezeReceipt | null, WorkflowFreezeStoreError> {
    for (const artifact of this.ledger
      .listArtifacts({ artifactKind: 'workflow_freeze_receipt', taskReference })
      .toReversed()) {
      const receipt = parseReceipt(artifact.artifactId, artifact.payload);
      if (!receipt.ok) return receipt;
      if (receipt.value.taskReference === taskReference) {
        return receipt;
      }
    }
    return ok(null);
  }

  public record(
    inputValue: FreezeTaskWorkflowInput,
  ): Outcome<WorkflowFreezeReceipt, WorkflowFreezeStoreError> {
    const input = FreezeTaskWorkflowInputSchema.parse(inputValue);
    const receiptId = receiptIdFor(input);
    const existing = this.ledger.readArtifact(receiptId);
    if (existing !== null) return this.restoreExact(receiptId, existing.payload, input);

    const frozenAt = this.clock.now();
    const receipt = WorkflowFreezeReceiptSchema.parse({
      ...input,
      schemaVersion: 1,
      receiptId,
      frozenAt,
    });
    const committed = this.ledger.insertArtifact({
      artifactId: receiptId,
      artifactKind: 'workflow_freeze_receipt',
      storageUri: `ledger://artifacts/${receiptId}`,
      payload: asJson(receipt),
      metadata: asJson({
        taskReference: receipt.taskReference,
        workflowId: receipt.workflowId,
        workflowRunId: receipt.workflowRunId,
        workflowHash: receipt.workflowHash,
        semanticHash: receipt.semanticHash,
        compilerVersion: receipt.compilerVersion,
        harnessSnapshotHash: receipt.harnessSnapshotHash,
        planningArtifactId: receipt.planningArtifactId,
        evidenceBundleArtifactId: receipt.evidenceBundle.artifactId,
        approval: receipt.approval.kind,
      }),
      createdAt: frozenAt,
    });
    if (committed) return ok(receipt);

    const concurrent = this.ledger.readArtifact(receiptId);
    return concurrent === null
      ? err({ kind: 'ledger_conflict' })
      : this.restoreExact(receiptId, concurrent.payload, input);
  }

  private restoreExact(
    receiptId: string,
    payload: JsonValue,
    input: FreezeTaskWorkflowInput,
  ): Outcome<WorkflowFreezeReceipt, WorkflowFreezeStoreError> {
    const parsed = parseReceipt(receiptId, payload);
    if (!parsed.ok) return parsed;
    return matchesInput(parsed.value, input)
      ? parsed
      : err({ kind: 'receipt_conflict', receiptId });
  }
}
