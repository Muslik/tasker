import { afterEach, describe, expect, it } from 'vitest';

import { BlockReceiptSchema, BlockReceiptStore, blockReceiptId } from '../../src/steps/index.js';
import { loadHarnessPack } from '../../src/harness/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/store/index.js';
import { systemClock } from '../../src/shared/clock.js';

const block = loadHarnessPack().steps.find(
  ({ reference }) => reference === 'fill-test-ops-plan@1',
)?.block;
if (block === undefined) throw new Error('Missing test-operations block');

const input = {
  block,
  taskReference: 'jira:AVIA-1',
  workflowId: 'tasker:jira:AVIA-1:execution',
  workflowRunId: 'run-1',
  workflowHash: 'a'.repeat(64),
  nodeId: 'test-plan',
  blockRun: 1,
  claim: {
    status: 'candidate_complete' as const,
    summary: 'Test plan ready',
    output: { summary: 'Test plan ready' },
    evidenceReferences: ['task-output:1'],
  },
  verdict: {
    status: 'accepted' as const,
    evidenceReferences: ['task-output:1'],
  },
  predicateFacts: {},
  evidence: [
    {
      kind: 'artifact' as const,
      reference: 'task-output:1',
      artifactKind: 'test-operations-plan',
      contentHash: 'b'.repeat(64),
    },
  ],
  transcriptReference: 'transcript:1',
  usageReference: null,
  usage: null,
};

describe('BlockReceiptStore', () => {
  let ledger: SqliteLedger;

  afterEach(() => {
    ledger.close();
  });

  it('restores an identical durable receipt and rejects conflicting redelivery', () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const store = new BlockReceiptStore(ledger.repository, systemClock);
    const receiptId = blockReceiptId(input);

    const first = store.record(input);
    const redelivered = store.record(input);
    const conflict = store.record({
      ...input,
      claim: { ...input.claim, summary: 'Different result' },
    });

    expect(first).toMatchObject({
      ok: true,
      value: {
        schemaVersion: 7,
        blockReference: 'fill-test-ops-plan@1',
        verdict: { status: 'accepted' },
      },
    });
    expect(redelivered).toEqual(first);
    expect(conflict).toEqual({
      ok: false,
      error: {
        kind: 'receipt_conflict',
        receiptId,
      },
    });

    const receiptRow = ledger.repository.readReceipt(receiptId);
    const artifact = ledger.repository.readArtifact(receiptId);

    expect(receiptRow).toMatchObject({
      taskReference: input.taskReference,
      workflowId: input.workflowId,
      runId: input.workflowRunId,
      nodeId: input.nodeId,
      blockRun: input.blockRun,
      blockReference: input.block.reference,
      verdict: input.verdict.status,
    });
    expect(BlockReceiptSchema.parse(receiptRow?.payload ?? null)).toMatchObject({
      receiptId,
      taskReference: input.taskReference,
    });
    expect(receiptRow?.completedAt).toBe(first.ok ? first.value.completedAt : null);
    expect(artifact).toMatchObject({
      artifactId: receiptId,
      artifactKind: 'block_receipt',
      taskReference: input.taskReference,
    });
    expect(artifact?.payload).toMatchObject({
      receiptId,
      taskReference: input.taskReference,
    });
    expect(artifact?.metadata).toMatchObject({ taskReference: input.taskReference });
  });

  it('reads block receipts from the receipts row rather than the artifact payload', () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const store = new BlockReceiptStore(ledger.repository, systemClock);
    const receiptId = blockReceiptId(input);

    const recorded = store.record(input);
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    ledger.database
      .prepare<[string, string]>(
        `
          UPDATE artifacts
          SET payload_json = ?
          WHERE artifact_id = ?
        `,
      )
      .run('{"schemaVersion":0}', receiptId);

    expect(store.read(receiptId)).toEqual(recorded);
  });
});
