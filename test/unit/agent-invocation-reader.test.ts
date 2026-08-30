import { afterEach, describe, expect, it } from 'vitest';

import { LedgerAgentInvocationReader } from '../../src/control-plane/agent-invocation-reader.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { LedgerAgentInvocationRecorder } from '../../src/observability/agent-invocation.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';

const resources: SqliteLedger[] = [];

afterEach(() => {
  for (const ledger of resources.splice(0)) ledger.close();
});

describe('agent invocation reader', () => {
  it('aggregates token and cost totals across finished invocations', () => {
    const clock = makeAdjustableClock('2026-08-09T00:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    resources.push(ledger);
    const recorder = new LedgerAgentInvocationRecorder(ledger.repository, clock);
    const reader = new LedgerAgentInvocationReader(ledger.repository);

    recorder.start({
      invocationId: 'agent-invocation:1',
      taskReference: 'jira:AVIA-12045',
      references: {
        kind: 'planning',
        planningEpisodeId: 'planning-episode-1',
        planningAttempt: 1,
        invocationNumber: 1,
        operationId: 'planning-operation-1',
        transcriptId: 'planning-transcript-1',
        outputArtifactIds: [],
        receiptArtifactId: null,
      },
      startedAt: '2026-08-09T00:00:10.000Z',
    });
    recorder.finish({
      schemaVersion: 1,
      invocationId: 'agent-invocation:1',
      taskReference: 'jira:AVIA-12045',
      prompt: 'Plan',
      promptBytes: 100,
      provider: 'codex',
      profile: 'planner',
      profileSha256: 'a'.repeat(64),
      model: 'gpt-5.4',
      effort: 'medium',
      serviceTier: 'fast',
      argv: ['codex'],
      skills: [],
      inputEvidenceArtifactIds: [],
      startedAt: '2026-08-09T00:00:10.000Z',
      finishedAt: '2026-08-09T00:00:20.000Z',
      durationMs: 10_000,
      status: 'completed',
      exitStatus: { kind: 'exited', exitCode: 0 },
      usage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 30,
        reasoningOutputTokens: 10,
      },
      cost: { source: 'price_table', amountUsd: 0.5, pricingVersion: '2026-08-01' },
      references: {
        kind: 'planning',
        planningEpisodeId: 'planning-episode-1',
        planningAttempt: 1,
        invocationNumber: 1,
        operationId: 'planning-operation-1',
        transcriptId: 'planning-transcript-1',
        outputArtifactIds: [],
        receiptArtifactId: null,
      },
    });
    recorder.start({
      invocationId: 'agent-invocation:2',
      taskReference: 'jira:AVIA-12045',
      references: {
        kind: 'execution',
        workflowId: 'workflow-1',
        runId: 'run-1',
        nodeId: 'deliver',
        blockRun: 2,
        providerAttempt: 1,
        transcriptId: 'execution-transcript-1',
        outputArtifactIds: [],
        receiptArtifactId: 'receipt-1',
      },
      startedAt: '2026-08-09T00:01:00.000Z',
    });
    recorder.finish({
      schemaVersion: 1,
      invocationId: 'agent-invocation:2',
      taskReference: 'jira:AVIA-12045',
      prompt: 'Deliver',
      promptBytes: 200,
      provider: 'claude',
      profile: 'delivery',
      profileSha256: 'b'.repeat(64),
      model: 'claude-opus',
      effort: 'high',
      serviceTier: null,
      argv: ['claude'],
      skills: [],
      inputEvidenceArtifactIds: [],
      startedAt: '2026-08-09T00:01:00.000Z',
      finishedAt: '2026-08-09T00:01:30.000Z',
      durationMs: 30_000,
      status: 'waiting',
      exitStatus: { kind: 'timed_out' },
      usage: {
        inputTokens: 40,
        cachedInputTokens: 5,
        outputTokens: 15,
        reasoningOutputTokens: 8,
      },
      cost: { source: 'unrated' },
      references: {
        kind: 'execution',
        workflowId: 'workflow-1',
        runId: 'run-1',
        nodeId: 'deliver',
        blockRun: 2,
        providerAttempt: 1,
        transcriptId: 'execution-transcript-1',
        outputArtifactIds: [],
        receiptArtifactId: 'receipt-1',
      },
    });

    const listed = reader.list('jira:AVIA-12045');

    expect(listed.totals).toEqual({
      invocationCount: 2,
      inputTokens: 140,
      cachedInputTokens: 25,
      outputTokens: 45,
      reasoningOutputTokens: 18,
      totalTokens: 185,
      costUsd: 0.5,
      unratedCount: 1,
    });
    expect(listed.invocations.map(({ invocationId }) => invocationId)).toEqual([
      'agent-invocation:2',
      'agent-invocation:1',
    ]);
    expect(reader.listStreamEventsAfter(0).map(({ eventType }) => eventType)).toEqual([
      'AgentInvocationStarted',
      'AgentInvocationFinished',
      'AgentInvocationStarted',
      'AgentInvocationFinished',
    ]);
  });
});
