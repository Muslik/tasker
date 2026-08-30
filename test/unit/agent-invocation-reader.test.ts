import { afterEach, describe, expect, it } from 'vitest';

import { LedgerAgentInvocationReader } from '../../src/server/agent-invocation-reader.js';
import { ImplementationPlanningStore } from '../../src/server/planning-episodes.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/store/index.js';
import { LedgerAgentInvocationRecorder } from '../../src/steps/agent-invocation.js';
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

  it('reads running and finished invocations from domain rows', () => {
    const clock = makeAdjustableClock('2026-08-30T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    resources.push(ledger);
    const recorder = new LedgerAgentInvocationRecorder(ledger.repository, clock);
    const reader = new LedgerAgentInvocationReader(ledger.repository);
    const planningStore = new ImplementationPlanningStore(ledger.repository, clock);

    recorder.start({
      invocationId: 'agent-invocation:planning-1',
      taskReference: 'jira:AVIA-13235',
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
      startedAt: '2026-08-30T12:00:01.000Z',
    });
    recorder.finish({
      schemaVersion: 1,
      invocationId: 'agent-invocation:planning-1',
      taskReference: 'jira:AVIA-13235',
      prompt: 'Plan',
      promptBytes: 120,
      provider: 'codex',
      profile: 'planner',
      profileSha256: 'a'.repeat(64),
      model: 'gpt-5.4',
      effort: 'medium',
      serviceTier: 'fast',
      argv: ['codex'],
      skills: ['plan'],
      inputEvidenceArtifactIds: [],
      startedAt: '2026-08-30T12:00:01.000Z',
      finishedAt: '2026-08-30T12:00:05.000Z',
      durationMs: 4_000,
      status: 'completed',
      exitStatus: { kind: 'exited', exitCode: 0 },
      usage: {
        inputTokens: 11,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 3,
      },
      cost: { source: 'price_table', amountUsd: 0.21, pricingVersion: '2026-08-01' },
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
      invocationId: 'agent-invocation:planning-2',
      taskReference: 'jira:AVIA-13235',
      references: {
        kind: 'planning',
        planningEpisodeId: 'planning-episode-1',
        planningAttempt: 1,
        invocationNumber: 2,
        operationId: 'planning-operation-2',
        transcriptId: 'planning-transcript-2',
        outputArtifactIds: [],
        receiptArtifactId: null,
      },
      startedAt: '2026-08-30T12:00:06.000Z',
    });
    recorder.start({
      invocationId: 'agent-invocation:execution-1',
      taskReference: 'jira:AVIA-13235',
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
      startedAt: '2026-08-30T12:01:00.000Z',
    });
    recorder.finish({
      schemaVersion: 1,
      invocationId: 'agent-invocation:execution-1',
      taskReference: 'jira:AVIA-13235',
      prompt: 'Deliver',
      promptBytes: 220,
      provider: 'claude',
      profile: 'delivery',
      profileSha256: 'b'.repeat(64),
      model: 'claude-opus',
      effort: 'high',
      serviceTier: null,
      argv: ['claude'],
      skills: ['deliver-pr'],
      inputEvidenceArtifactIds: [],
      startedAt: '2026-08-30T12:01:00.000Z',
      finishedAt: '2026-08-30T12:01:30.000Z',
      durationMs: 30_000,
      status: 'waiting',
      exitStatus: { kind: 'timed_out' },
      usage: {
        inputTokens: 7,
        cachedInputTokens: 1,
        outputTokens: 4,
        reasoningOutputTokens: 2,
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

    expect(planningStore.nextAgentInvocationNumber('planning-episode-1', 1)).toBe(3);
    expect(reader.list('jira:AVIA-13235')).toMatchObject({
      taskReference: 'jira:AVIA-13235',
      invocations: [
        { invocationId: 'agent-invocation:execution-1', scope: 'execution', status: 'waiting' },
        { invocationId: 'agent-invocation:planning-1', scope: 'planning', status: 'completed' },
      ],
      totals: {
        invocationCount: 2,
        inputTokens: 18,
        cachedInputTokens: 3,
        outputTokens: 9,
        reasoningOutputTokens: 5,
        totalTokens: 27,
        costUsd: 0.21,
        unratedCount: 1,
      },
    });
    expect(reader.read('jira:AVIA-13235', 'agent-invocation:planning-1')).toMatchObject({
      invocationId: 'agent-invocation:planning-1',
      prompt: 'Plan',
      references: { kind: 'planning', planningEpisodeId: 'planning-episode-1' },
    });
    expect(
      reader.readLatestExecutionInvocation({
        taskReference: 'jira:AVIA-13235',
        workflowId: 'workflow-1',
        runId: 'run-1',
        nodeId: 'deliver',
        blockRun: 2,
      }),
    ).toEqual({
      invocationId: 'agent-invocation:execution-1',
      blockRun: 2,
      startedAt: '2026-08-30T12:01:00.000Z',
      finishedAt: '2026-08-30T12:01:30.000Z',
    });
    expect(
      reader.readLatestPlanningInvocation({
        taskReference: 'jira:AVIA-13235',
        planningEpisodeId: 'planning-episode-1',
        planningAttempt: 1,
      }),
    ).toEqual({
      invocationId: 'agent-invocation:planning-2',
      blockRun: 1,
      startedAt: '2026-08-30T12:00:06.000Z',
      finishedAt: null,
    });
    expect(reader.listStreamEventsAfter(0).map(({ eventType }) => eventType)).toEqual([
      'AgentInvocationStarted',
      'AgentInvocationFinished',
      'AgentInvocationStarted',
      'AgentInvocationStarted',
      'AgentInvocationFinished',
    ]);
  });
});
