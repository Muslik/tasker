import { afterEach, describe, expect, it } from 'vitest';

import { makeAdjustableClock } from '../../src/shared/clock.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/store/index.js';

const resources: SqliteLedger[] = [];

afterEach(() => {
  for (const ledger of resources.splice(0)) ledger.close();
});

const openLedger = () => {
  const clock = makeAdjustableClock('2026-08-30T00:00:00.000Z');
  const ledger = openSqliteLedger({ filename: ':memory:', clock });
  resources.push(ledger);
  return { clock, ledger };
};

describe('domain store', () => {
  it('reads transcript chunks after a sequence with a bounded limit', () => {
    const { ledger } = openLedger();
    const repository = ledger.repository;
    for (const [providerAttempt, content] of ['first', 'second', 'third'].entries()) {
      repository.appendTranscript({
        idPrefix: `planning-transcript:operation-1:provider-attempt-${String(providerAttempt + 1)}`,
        taskReference: 'jira:AVIA-1',
        operationId: 'operation-1',
        stream: 'stdout',
        content,
      });
    }

    const range = repository.listTranscripts('operation-1', { afterSeq: 1, limit: 1 });

    expect(range).toMatchObject([
      {
        seq: 2,
        content: 'second',
        byteLength: 6,
      },
    ]);
    expect(range[0]?.id).toContain('provider-attempt-2');
    expect(repository.listEvents()).toEqual([]);
    expect(repository.listArtifacts({ artifactKind: 'planning_transcript_chunk' })).toEqual([]);
  });

  it('resumes stream reads strictly after the cursor in sequence order', () => {
    const { ledger } = openLedger();
    const first = ledger.repository.appendStreamEvent({
      taskReference: 'jira:AVIA-1',
      eventType: 'First',
      payload: {},
    });
    const second = ledger.repository.appendStreamEvent({
      taskReference: 'jira:AVIA-1',
      eventType: 'Second',
      payload: {},
    });
    const third = ledger.repository.appendStreamEvent({
      taskReference: 'jira:AVIA-1',
      eventType: 'Third',
      payload: {},
    });

    const resumed = ledger.repository.listStreamEventsAfter(first.seq);

    expect(resumed.map(({ seq, eventType }) => ({ seq, eventType }))).toEqual([
      { seq: second.seq, eventType: 'Second' },
      { seq: third.seq, eventType: 'Third' },
    ]);
    expect(ledger.repository.listStreamEventsAfter(second.seq, 1)).toMatchObject([
      { seq: third.seq, eventType: 'Third' },
    ]);
  });

  it('inserts receipts once with the full task-scoped artifact', () => {
    const { ledger } = openLedger();
    const receipt = {
      receiptId: 'receipt-1',
      taskReference: 'jira:AVIA-1',
      workflowId: 'workflow-1',
      runId: 'run-1',
      nodeId: 'deliver',
      blockRun: 1,
      blockReference: 'deliver@1',
      verdict: 'accepted',
      payload: { summary: 'done' },
    } as const;
    const artifact = {
      artifactId: receipt.receiptId,
      artifactKind: 'block_receipt',
      taskReference: receipt.taskReference,
      storageUri: `ledger://artifacts/${receipt.receiptId}`,
      payload: receipt.payload,
    } as const;

    const inserted = ledger.repository.insertReceipt(receipt, artifact);
    const duplicate = ledger.repository.insertReceipt(receipt, artifact);

    expect(inserted).toBe(true);
    expect(duplicate).toBe(false);
    expect(ledger.repository.readReceipt(receipt.receiptId)?.payload).toEqual(receipt.payload);
    expect(ledger.repository.readArtifact(receipt.receiptId)?.taskReference).toBe(
      receipt.taskReference,
    );
  });

  it('aggregates finished invocation usage and cost in SQL', () => {
    const { ledger } = openLedger();
    ledger.repository.startAgentInvocation({
      invocationId: 'invocation-1',
      taskReference: 'jira:AVIA-1',
      nodeId: null,
      blockRun: 1,
      episodeId: 'episode-1',
    });
    ledger.repository.finishAgentInvocation(
      {
        invocationId: 'invocation-1',
        taskReference: 'jira:AVIA-1',
        nodeId: null,
        blockRun: 1,
        episodeId: 'episode-1',
        status: 'completed',
        model: 'gpt-5.4',
        profile: 'planner',
        promptBytes: 100,
        durationMs: 1_000,
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
          reasoningOutputTokens: 1,
        },
        cost: { source: 'price_table', amountUsd: 0.25 },
        startedAt: '2026-08-30T00:00:00.000Z',
      },
      {
        artifactId: 'invocation-1',
        artifactKind: 'agent_invocation',
        taskReference: 'jira:AVIA-1',
        storageUri: 'ledger://artifacts/invocation-1',
        payload: {},
      },
    );

    const totals = ledger.repository.readAgentInvocationTotals('jira:AVIA-1');

    expect(totals).toEqual({
      invocationCount: 1,
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
      reasoningOutputTokens: 1,
      totalTokens: 14,
      costUsd: 0.25,
      unratedCount: 0,
    });
  });
});
