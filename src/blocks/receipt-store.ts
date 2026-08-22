import { checksumString } from '../ledger/checksum.js';
import type { LedgerRepository } from '../ledger/repository.js';
import type { JsonValue } from '../ledger/types.js';
import type { Clock } from '../shared/clock.js';
import type { AgentInvocationUsage } from '../providers/agent-usage.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { JsonValueSchema } from '../workflow/schema.js';
import {
  BlockDefinitionSchema,
  BlockReceiptSchema,
  type AgentClaim,
  type BlockDefinition,
  type BlockReceipt,
  type CompletionEvidence,
  type CompletionVerdict,
} from './contracts.js';

export interface RecordBlockReceiptInput {
  readonly block: BlockDefinition;
  readonly taskReference: string;
  readonly workflowId: string;
  readonly workflowRunId: string;
  readonly workflowHash: string;
  readonly nodeId: string;
  readonly blockRun: number;
  readonly claim: AgentClaim;
  readonly verdict: CompletionVerdict;
  readonly predicateFacts: Readonly<Record<string, boolean>>;
  readonly evidence: readonly CompletionEvidence[];
  readonly transcriptReference: string | null;
  readonly usageReference: string | null;
  readonly usage: AgentInvocationUsage | null;
}

export type BlockReceiptStoreError =
  | { readonly kind: 'ledger_conflict' }
  | { readonly kind: 'receipt_conflict'; readonly receiptId: string }
  | { readonly kind: 'receipt_corrupt'; readonly receiptId: string; readonly issues: string[] };

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
};

const asJson = (value: unknown): JsonValue => JsonValueSchema.parse(value);

export const blockDefinitionHash = (block: BlockDefinition): string =>
  checksumString(canonicalJson(BlockDefinitionSchema.parse(block)));

export const blockReceiptId = (input: {
  readonly workflowId: string;
  readonly workflowRunId: string;
  readonly nodeId: string;
  readonly blockRun: number;
}): string =>
  `block-receipt:${input.workflowId}:${input.workflowRunId}:${input.nodeId}:run-${String(input.blockRun)}`;

const comparableReceipt = (receipt: BlockReceipt) => ({
  blockReference: receipt.blockReference,
  blockDefinitionHash: receipt.blockDefinitionHash,
  taskReference: receipt.taskReference,
  workflowId: receipt.workflowId,
  workflowRunId: receipt.workflowRunId,
  workflowHash: receipt.workflowHash,
  nodeId: receipt.nodeId,
  blockRun: receipt.blockRun,
  claim: receipt.claim,
  verdict: receipt.verdict,
  predicateFacts: receipt.predicateFacts,
  evidence: receipt.evidence,
  transcriptReference: receipt.transcriptReference,
  usageReference: receipt.usageReference,
  usage: receipt.usage,
});

const comparableInput = (input: RecordBlockReceiptInput) => ({
  blockReference: input.block.reference,
  blockDefinitionHash: blockDefinitionHash(input.block),
  taskReference: input.taskReference,
  workflowId: input.workflowId,
  workflowRunId: input.workflowRunId,
  workflowHash: input.workflowHash,
  nodeId: input.nodeId,
  blockRun: input.blockRun,
  claim: input.claim,
  verdict: input.verdict,
  predicateFacts: input.predicateFacts,
  evidence: input.evidence,
  transcriptReference: input.transcriptReference,
  usageReference: input.usageReference,
  usage: input.usage,
});

export class BlockReceiptStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public read(receiptId: string): Outcome<BlockReceipt | null, BlockReceiptStoreError> {
    const artifact = this.ledger.readArtifact(receiptId);
    if (artifact === null) return ok(null);
    const parsed = BlockReceiptSchema.safeParse(artifact.payload);
    return parsed.success
      ? ok(parsed.data)
      : err({
          kind: 'receipt_corrupt',
          receiptId,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
  }

  public record(input: RecordBlockReceiptInput): Outcome<BlockReceipt, BlockReceiptStoreError> {
    const receiptId = blockReceiptId(input);
    const existing = this.read(receiptId);
    if (!existing.ok) return existing;
    if (existing.value !== null) return this.restoreExact(receiptId, existing.value, input);

    const completedAt = this.clock.now();
    const receipt = BlockReceiptSchema.parse({
      schemaVersion: 5,
      receiptId,
      ...comparableInput(input),
      completedAt,
    });
    const committed = this.ledger.transact({
      aggregate: {
        aggregateId: receiptId,
        expectedVersion: 0,
        events: [
          {
            eventId: `event:${receiptId}:1`,
            eventType: 'BlockReceiptRecorded',
            eventSchemaVersion: 1,
            payload: asJson({
              receiptId,
              blockReference: receipt.blockReference,
              verdict: receipt.verdict.status,
            }),
            actor: 'kernel',
          },
        ],
      },
      artifacts: [
        {
          artifactId: receiptId,
          artifactKind: 'block_receipt',
          storageUri: `ledger://artifacts/${receiptId}`,
          payload: asJson(receipt),
          metadata: asJson({
            taskReference: receipt.taskReference,
            workflowId: receipt.workflowId,
            workflowRunId: receipt.workflowRunId,
            nodeId: receipt.nodeId,
            blockRun: receipt.blockRun,
            blockReference: receipt.blockReference,
            verdict: receipt.verdict.status,
          }),
          createdAt: completedAt,
        },
      ],
      timestamp: completedAt,
    });
    if (committed.ok) return ok(receipt);

    const concurrent = this.read(receiptId);
    if (!concurrent.ok) return concurrent;
    return concurrent.value === null
      ? err({ kind: 'ledger_conflict' })
      : this.restoreExact(receiptId, concurrent.value, input);
  }

  private restoreExact(
    receiptId: string,
    receipt: BlockReceipt,
    input: RecordBlockReceiptInput,
  ): Outcome<BlockReceipt, BlockReceiptStoreError> {
    return canonicalJson(comparableReceipt(receipt)) === canonicalJson(comparableInput(input))
      ? ok(receipt)
      : err({ kind: 'receipt_conflict', receiptId });
  }
}
