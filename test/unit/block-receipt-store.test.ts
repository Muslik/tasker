import { afterEach, describe, expect, it } from 'vitest';

import { BlockReceiptStore } from '../../src/blocks/index.js';
import { loadHarnessPack } from '../../src/harness/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
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

    const first = store.record(input);
    const redelivered = store.record(input);
    const conflict = store.record({
      ...input,
      claim: { ...input.claim, summary: 'Different result' },
    });

    expect(first).toMatchObject({
      ok: true,
      value: {
        schemaVersion: 4,
        blockReference: 'fill-test-ops-plan@1',
        verdict: { status: 'accepted' },
      },
    });
    expect(redelivered).toEqual(first);
    expect(conflict).toEqual({
      ok: false,
      error: {
        kind: 'receipt_conflict',
        receiptId: 'block-receipt:tasker:jira:AVIA-1:execution:run-1:test-plan:run-1',
      },
    });
  });
});
