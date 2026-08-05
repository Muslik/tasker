import type { LedgerRepository } from '../ledger/repository.js';
import type { JsonValue } from '../ledger/types.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  FreezeTaskWorkflowInputSchema,
  WorkflowFreezeReceiptSchema,
  type FreezeTaskWorkflowInput,
  type WorkflowFreezeReceipt,
} from '../temporal/freeze-contracts.js';
import { JsonValueSchema } from '../workflow/schema.js';

export const WORKFLOW_FREEZE_PROJECTION = 'workflow_freeze_by_task';

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
  receipt.planningAttempt === input.planningAttempt &&
  receipt.planningArtifactId === input.planningArtifactId &&
  receipt.planningSnapshot.artifactId === input.planningSnapshot.artifactId &&
  receipt.planningSnapshot.checksum === input.planningSnapshot.checksum &&
  receipt.approval.kind === input.approval.kind;

export class WorkflowFreezeStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public read(
    taskReference: string,
  ): Outcome<WorkflowFreezeReceipt | null, WorkflowFreezeStoreError> {
    const projection = this.ledger.readProjection(WORKFLOW_FREEZE_PROJECTION, taskReference);
    return projection === null
      ? ok(null)
      : parseReceipt(`projection:${taskReference}`, projection.payload);
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
    const committed = this.ledger.transact({
      aggregate: {
        aggregateId: receiptId,
        expectedVersion: 0,
        events: [
          {
            eventId: `event:${receiptId}:1`,
            eventType: 'TaskWorkflowFrozen',
            eventSchemaVersion: 1,
            payload: asJson({ receiptId, workflowHash: receipt.workflowHash }),
            actor: 'kernel',
          },
        ],
      },
      projections: [
        {
          kind: 'upsert',
          projectionType: WORKFLOW_FREEZE_PROJECTION,
          projectionId: receipt.taskReference,
          payload: asJson(receipt),
        },
      ],
      artifacts: [
        {
          artifactId: receiptId,
          artifactKind: 'workflow_freeze_receipt',
          storageUri: `ledger://artifacts/${receiptId}`,
          payload: asJson(receipt),
          metadata: asJson({
            taskReference: receipt.taskReference,
            workflowId: receipt.workflowId,
            workflowRunId: receipt.workflowRunId,
            workflowHash: receipt.workflowHash,
            planningArtifactId: receipt.planningArtifactId,
            approval: receipt.approval.kind,
          }),
          createdAt: frozenAt,
        },
      ],
      timestamp: frozenAt,
    });
    if (committed.ok) return ok(receipt);

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
