import { afterEach, describe, expect, it } from 'vitest';

import { BlockReceiptStore } from '../../src/steps/index.js';
import { buildOperatorApi, createOperatorWorkflowService } from '../../src/server/index.js';
import { LedgerAgentInvocationReader } from '../../src/server/agent-invocation-reader.js';
import { PlanReviewStore } from '../../src/server/plan-review.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/store/index.js';
import { LedgerAgentInvocationRecorder } from '../../src/steps/agent-invocation.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { err, ok, type Outcome } from '../../src/shared/outcome.js';
import {
  BootstrapWorkflowInputSchema,
  BootstrapWorkflowPublicStateSchema,
  ExecutionWorkflowPublicStateSchema,
  type BootstrapWorkflowInput,
  type ResolveBootstrapWaitCommand,
  type TaskRunLifecycle,
  type TaskRunError,
  type TaskRunPublicState,
  type TaskRunService,
} from '../../src/kernel/index.js';

const resources: SqliteLedger[] = [];
const PLANNING_EPISODE_ID = 'tasker:v3:jira:AVIA-12045:run-1:planning';
const PLAN_ARTIFACT_ID = 'implementation-plan:task:attempt-1';
const TEST_CHECKSUM = 'a'.repeat(64);

afterEach(() => {
  for (const ledger of resources.splice(0)) ledger.close();
});

const waitingRun = (
  input: BootstrapWorkflowInput,
  runId: string,
  planning: Record<string, unknown> | null = null,
): TaskRunPublicState =>
  BootstrapWorkflowPublicStateSchema.parse({
    runtime: 'bootstrap',
    schemaVersion: 3,
    taskReference: input.taskReference,
    workflowId: `tasker:v3:${input.taskReference}`,
    runId,
    workflowHash: null,
    settings: input.settings,
    phase: 'plan_review',
    workspaceContext: null,
    context: null,
    draft: null,
    planning,
    activeTranscriptOperationId: null,
    freezeReceipt: null,
    executionWorkflowId: null,
    nodeStates: { plan_review: 'waiting' },
    attempts: { planning: 1 },
    status: 'waiting',
    currentNodeId: 'plan_review',
    wait: { nodeId: 'plan_review', waitKind: 'plan.approved@1' },
    outcome: null,
  });

const waitingPlanReviewRun = (input: BootstrapWorkflowInput, runId: string): TaskRunPublicState =>
  waitingRun(input, runId, {
    status: 'needs_clarification',
    planningEpisodeId: PLANNING_EPISODE_ID,
    commandId: 'planning-command-1',
    attempt: 1,
    evidenceBundle: {
      artifactId: 'evidence-bundle:1',
      checksum: TEST_CHECKSUM,
      revision: 1,
    },
    requestedStrategy: 'auto',
    selectedStrategy: 'fast',
    transcriptId: 'planning-transcript:1',
    artifactId: PLAN_ARTIFACT_ID,
    questions: [
      {
        id: 'scope',
        question: 'Which scope should the plan cover?',
        reason: 'The test only needs a planning episode id.',
      },
    ],
  });

class ContractTaskRunService implements TaskRunService {
  public readonly starts: BootstrapWorkflowInput[] = [];
  public readonly resolutions: ResolveBootstrapWaitCommand[] = [];
  private current: TaskRunPublicState | null = null;
  private sequence = 0;

  public setCurrent(current: TaskRunPublicState): void {
    this.current = current;
  }

  public start(inputValue: BootstrapWorkflowInput) {
    const input = BootstrapWorkflowInputSchema.parse(inputValue);
    this.sequence += 1;
    this.starts.push(input);
    this.current = waitingRun(input, `run-${String(this.sequence)}`);
    return Promise.resolve(ok(this.current));
  }

  public read() {
    return Promise.resolve(ok(this.current));
  }

  public readLifecycle() {
    const lifecycle: TaskRunLifecycle | null =
      this.current?.runtime === 'bootstrap' ? { bootstrap: this.current, execution: null } : null;
    return Promise.resolve(ok(lifecycle));
  }

  public restart(
    taskReference: string,
    expectedRunId: string,
  ): Promise<Outcome<TaskRunPublicState, TaskRunError>> {
    if (this.current === null || this.current.taskReference !== taskReference) {
      return Promise.resolve(err({ kind: 'run_not_found' as const, taskReference }));
    }
    if (this.current.runId !== expectedRunId) {
      return Promise.resolve(
        err({
          kind: 'stale_run' as const,
          taskReference,
          providedRunId: expectedRunId,
          activeRunId: this.current.runId,
        }),
      );
    }
    if (this.current.runtime !== 'bootstrap') {
      return Promise.resolve(err({ kind: 'run_not_restartable' as const, taskReference }));
    }
    const settings = this.current.settings;
    this.sequence += 1;
    this.current = waitingRun(
      BootstrapWorkflowInputSchema.parse({ schemaVersion: 3, taskReference, settings }),
      `run-${String(this.sequence)}`,
    );
    return Promise.resolve(ok(this.current));
  }

  public terminate(): Promise<Outcome<void, TaskRunError>> {
    this.current = null;
    return Promise.resolve(ok(undefined));
  }

  public resolveWait(
    taskReference: string,
    command: ResolveBootstrapWaitCommand,
  ): Promise<Outcome<TaskRunPublicState, TaskRunError>> {
    if (this.current === null || this.current.taskReference !== taskReference) {
      return Promise.resolve(err({ kind: 'run_not_found' as const, taskReference }));
    }
    if (this.current.runId !== command.runId) {
      return Promise.resolve(
        err({
          kind: 'stale_run' as const,
          taskReference,
          providedRunId: command.runId,
          activeRunId: this.current.runId,
        }),
      );
    }
    this.resolutions.push(command);
    return Promise.resolve(ok(this.current));
  }
}

const setup = (taskRemoval?: Parameters<typeof buildOperatorApi>[0]['taskRemoval']) => {
  const clock = makeAdjustableClock('2026-08-09T00:00:00.000Z');
  const ledger = openSqliteLedger({ filename: ':memory:', clock });
  resources.push(ledger);
  const runs = new ContractTaskRunService();
  const agentInvocations = new LedgerAgentInvocationReader(ledger.repository);
  const api = buildOperatorApi({
    service: createOperatorWorkflowService(ledger.repository, clock),
    agentInvocations,
    temporalRunService: runs,
    blockReceipts: new BlockReceiptStore(ledger.repository, clock),
    planReviews: new PlanReviewStore(ledger.repository, clock),
    ...(taskRemoval === undefined ? {} : { taskRemoval }),
  });
  return {
    api,
    runs,
    ledger,
    recorder: new LedgerAgentInvocationRecorder(ledger.repository, clock),
  };
};

describe('Temporal bootstrap HTTP contract', () => {
  it('accepts plan review annotations and forwards combined guidance to Temporal', async () => {
    const { api, runs, ledger } = setup();
    const input = BootstrapWorkflowInputSchema.parse({
      schemaVersion: 3,
      taskReference: 'jira:AVIA-12045',
      settings: { planReview: 'required', planningStrategy: 'fast' },
    });
    runs.setCurrent(waitingPlanReviewRun(input, 'run-1'));

    const response = await api.inject({
      method: 'POST',
      url: '/api/workflows/jira:AVIA-12045/plan-review',
      payload: {
        expectedRunId: 'run-1',
        reviewId: 'review-1',
        planArtifactId: PLAN_ARTIFACT_ID,
        planAttempt: 1,
        decision: 'request_changes',
        annotations: [
          {
            quote: 'Run the full suite',
            note: 'Use the targeted payment checks instead.',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runs.resolutions).toEqual([
      {
        runId: 'run-1',
        nodeId: 'plan_review',
        waitKind: 'plan.approved@1',
        resolution: {
          decision: 'request_changes',
          guidance: '«Фрагмент: "Run the full suite" — Use the targeted payment checks instead.»',
        },
      },
    ]);
    expect(
      ledger.repository.readDocument('plan_review', `${PLANNING_EPISODE_ID}:review-1`)?.payload,
    ).toMatchObject({
      reviewId: 'review-1',
      planArtifactId: PLAN_ARTIFACT_ID,
      guidance: null,
      annotations: [{ quote: 'Run the full suite' }],
    });
    await api.close();
  });

  it('lists agent invocations newest first with aggregated totals', async () => {
    const { api, ledger, recorder } = setup();
    ledger.repository.transact({
      artifacts: [
        {
          artifactId: 'input-evidence-1',
          artifactKind: 'evidence_bundle',
          storageUri: 'memory://input-evidence-1',
          payload: { note: 'Jira snapshot' },
          metadata: { taskReference: 'jira:AVIA-12045' },
          createdAt: '2026-08-09T00:00:05.000Z',
        },
      ],
    });
    recorder.start({
      invocationId: 'agent-invocation:planning-1',
      taskReference: 'jira:AVIA-12045',
      references: {
        kind: 'planning',
        planningEpisodeId: 'tasker:v3:jira:AVIA-12045:run-1:planning',
        planningAttempt: 1,
        invocationNumber: 1,
        operationId: 'tasker:v3:jira:AVIA-12045:run-1:planning:1',
        transcriptId: 'planning-transcript:1',
        outputArtifactIds: [],
        receiptArtifactId: null,
      },
      startedAt: '2026-08-09T00:00:10.000Z',
    });
    recorder.finish({
      schemaVersion: 1,
      invocationId: 'agent-invocation:planning-1',
      taskReference: 'jira:AVIA-12045',
      prompt: 'Plan the task',
      promptBytes: 120,
      provider: 'codex',
      profile: 'planner',
      profileSha256: 'a'.repeat(64),
      model: 'gpt-5.4',
      effort: 'medium',
      serviceTier: 'fast',
      argv: ['codex', 'exec'],
      skills: ['plan'],
      inputEvidenceArtifactIds: ['input-evidence-1'],
      startedAt: '2026-08-09T00:00:10.000Z',
      finishedAt: '2026-08-09T00:00:20.000Z',
      durationMs: 10_000,
      status: 'completed',
      exitStatus: { kind: 'exited', exitCode: 0 },
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 3,
        reasoningOutputTokens: 1,
      },
      cost: { source: 'price_table', amountUsd: 0.12, pricingVersion: '2026-08-01' },
      references: {
        kind: 'planning',
        planningEpisodeId: 'tasker:v3:jira:AVIA-12045:run-1:planning',
        planningAttempt: 1,
        invocationNumber: 1,
        operationId: 'tasker:v3:jira:AVIA-12045:run-1:planning:1',
        transcriptId: 'planning-transcript:1',
        outputArtifactIds: [],
        receiptArtifactId: null,
      },
    });
    recorder.start({
      invocationId: 'agent-invocation:execution-1',
      taskReference: 'jira:AVIA-12045',
      references: {
        kind: 'execution',
        workflowId: 'tasker:execution:v2:jira:AVIA-12045:run-1',
        runId: 'execution-run-1',
        nodeId: 'deliver',
        blockRun: 1,
        providerAttempt: 1,
        transcriptId: 'execution-transcript:1',
        outputArtifactIds: [],
        receiptArtifactId: 'receipt:1',
      },
      startedAt: '2026-08-09T00:01:00.000Z',
    });
    recorder.finish({
      schemaVersion: 1,
      invocationId: 'agent-invocation:execution-1',
      taskReference: 'jira:AVIA-12045',
      prompt: 'Deliver the change',
      promptBytes: 240,
      provider: 'claude',
      profile: 'delivery',
      profileSha256: 'b'.repeat(64),
      model: 'claude-opus',
      effort: 'high',
      serviceTier: null,
      argv: ['claude', '--print'],
      skills: ['deliver-pr'],
      inputEvidenceArtifactIds: [],
      startedAt: '2026-08-09T00:01:00.000Z',
      finishedAt: '2026-08-09T00:01:15.000Z',
      durationMs: 15_000,
      status: 'waiting',
      exitStatus: { kind: 'timed_out' },
      usage: {
        inputTokens: 20,
        cachedInputTokens: 5,
        outputTokens: 7,
        reasoningOutputTokens: 4,
      },
      cost: { source: 'unrated' },
      references: {
        kind: 'execution',
        workflowId: 'tasker:execution:v2:jira:AVIA-12045:run-1',
        runId: 'execution-run-1',
        nodeId: 'deliver',
        blockRun: 1,
        providerAttempt: 1,
        transcriptId: 'execution-transcript:1',
        outputArtifactIds: [],
        receiptArtifactId: 'receipt:1',
      },
    });

    const response = await api.inject({
      method: 'GET',
      url: '/api/operator/tasks/jira:AVIA-12045/invocations',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      taskReference: 'jira:AVIA-12045',
      invocations: [
        {
          invocationId: 'agent-invocation:execution-1',
          scope: 'execution',
          nodeId: 'deliver',
          blockRun: 1,
          status: 'waiting',
        },
        {
          invocationId: 'agent-invocation:planning-1',
          scope: 'planning',
          planningEpisodeId: 'tasker:v3:jira:AVIA-12045:run-1:planning',
          blockRun: null,
          status: 'completed',
        },
      ],
      totals: {
        invocationCount: 2,
        inputTokens: 30,
        cachedInputTokens: 7,
        outputTokens: 10,
        reasoningOutputTokens: 5,
        totalTokens: 40,
        costUsd: 0.12,
        unratedCount: 1,
      },
    });
    await api.close();
  });

  it('returns invocation detail with exact evidence and references', async () => {
    const { api, ledger, recorder } = setup();
    ledger.repository.transact({
      artifacts: [
        {
          artifactId: 'input-evidence-2',
          artifactKind: 'evidence_bundle',
          storageUri: 'memory://input-evidence-2',
          payload: { issueKey: 'AVIA-12045' },
          metadata: { source: 'jira' },
          createdAt: '2026-08-09T00:00:05.000Z',
        },
      ],
    });
    recorder.start({
      invocationId: 'agent-invocation:detail-1',
      taskReference: 'jira:AVIA-12045',
      references: {
        kind: 'execution',
        workflowId: 'tasker:execution:v2:jira:AVIA-12045:run-1',
        runId: 'execution-run-1',
        nodeId: 'implement',
        blockRun: 2,
        providerAttempt: 1,
        transcriptId: 'execution-transcript:2',
        outputArtifactIds: ['output-artifact-1'],
        receiptArtifactId: 'receipt:2',
      },
      startedAt: '2026-08-09T00:02:00.000Z',
    });
    recorder.finish({
      schemaVersion: 1,
      invocationId: 'agent-invocation:detail-1',
      taskReference: 'jira:AVIA-12045',
      prompt: 'Implement the fix',
      promptBytes: 512,
      provider: 'codex',
      profile: 'implementer',
      profileSha256: 'c'.repeat(64),
      model: 'gpt-5.4',
      effort: 'high',
      serviceTier: 'flex',
      argv: ['codex', '--model', 'gpt-5.4'],
      skills: ['implement'],
      inputEvidenceArtifactIds: ['input-evidence-2'],
      startedAt: '2026-08-09T00:02:00.000Z',
      finishedAt: '2026-08-09T00:02:30.000Z',
      durationMs: 30_000,
      status: 'failed',
      exitStatus: { kind: 'spawn_failed', message: 'sandbox refused command' },
      usage: {
        inputTokens: 40,
        cachedInputTokens: 10,
        outputTokens: 12,
        reasoningOutputTokens: 8,
      },
      cost: { source: 'provider_reported', amountUsd: 0.45 },
      references: {
        kind: 'execution',
        workflowId: 'tasker:execution:v2:jira:AVIA-12045:run-1',
        runId: 'execution-run-1',
        nodeId: 'implement',
        blockRun: 2,
        providerAttempt: 1,
        transcriptId: 'execution-transcript:2',
        outputArtifactIds: ['output-artifact-1'],
        receiptArtifactId: 'receipt:2',
      },
    });

    const detail = await api.inject({
      method: 'GET',
      url: '/api/operator/tasks/jira:AVIA-12045/invocations/agent-invocation:detail-1',
    });
    const missing = await api.inject({
      method: 'GET',
      url: '/api/operator/tasks/jira:AVIA-12045/invocations/missing',
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      invocationId: 'agent-invocation:detail-1',
      prompt: 'Implement the fix',
      argv: ['codex', '--model', 'gpt-5.4'],
      skills: ['implement'],
      inputEvidenceArtifactIds: ['input-evidence-2'],
      references: {
        kind: 'execution',
        nodeId: 'implement',
        blockRun: 2,
        outputArtifactIds: ['output-artifact-1'],
      },
      exitStatus: { kind: 'spawn_failed', message: 'sandbox refused command' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'invocation_not_found' });
    await api.close();
  });

  it('requires the Jira key before removing a task', async () => {
    const removed: string[] = [];
    const { api } = setup({
      remove: (taskReference) => {
        removed.push(taskReference);
        return Promise.resolve(ok(undefined));
      },
    });
    const rejected = await api.inject({
      method: 'DELETE',
      url: '/api/operator/tasks/jira:FC-2244',
      payload: { confirmation: 'WRONG-1' },
    });
    const accepted = await api.inject({
      method: 'DELETE',
      url: '/api/operator/tasks/jira:FC-2244',
      payload: { confirmation: 'FC-2244' },
    });

    expect(rejected.statusCode).toBe(400);
    expect(accepted.statusCode).toBe(200);
    expect(removed).toEqual(['jira:FC-2244']);
    await api.close();
  });

  it('starts a durable run from a neutral task reference', async () => {
    const { api, runs } = setup();
    const response = await api.inject({
      method: 'POST',
      url: '/api/workflows/jira:AVIA-12045/generate',
      payload: {
        settings: {
          planReview: 'automatic',
          planningStrategy: 'fast',
          trackerStatusUpdates: 'disabled',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ taskReference: 'jira:AVIA-12045', runId: 'run-1' });
    expect(runs.starts).toHaveLength(1);
    expect(runs.starts[0]?.settings.trackerStatusUpdates).toBe('disabled');
    await api.close();
  });

  it('rejects restart commands for an obsolete run', async () => {
    const { api, runs } = setup();
    await api.inject({ method: 'POST', url: '/api/workflows/jira:AVIA-12045/generate' });
    const stale = await api.inject({
      method: 'POST',
      url: '/api/workflows/jira:AVIA-12045/restart',
      payload: { expectedRunId: 'old-run', confirmation: 'restart_from_scratch' },
    });
    const current = await api.inject({
      method: 'POST',
      url: '/api/workflows/jira:AVIA-12045/restart',
      payload: { expectedRunId: 'run-1', confirmation: 'restart_from_scratch' },
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'stale_run' });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ runId: 'run-2' });
    expect(runs.starts[0]?.settings.trackerStatusUpdates).toBe('enabled');
    await api.close();
  });

  it('reviews only the exact continuation waiting in the active execution run', async () => {
    const { api, runs } = setup();
    const continuationId = 'execution-run:continuation-1';
    runs.setCurrent(
      ExecutionWorkflowPublicStateSchema.parse({
        runtime: 'execution',
        schemaVersion: 2,
        taskReference: 'jira:AVIA-12045',
        workflowId: 'tasker:execution:v2:jira:AVIA-12045:run-1',
        runId: 'execution-run',
        workflowHash: 'a'.repeat(64),
        nodeStates: { delivery: 'running', deliver: 'waiting' },
        blockRuns: { deliver: 1 },
        loopIterations: {},
        continuations: [
          {
            continuationId,
            attempt: 1,
            parentNodeId: 'deliver',
            requestReference: 'artifact:workflow-change',
            reason: 'CI exposed a task-caused change',
            evidenceBundle: {
              artifactId: 'evidence:continuation-1',
              checksum: 'd'.repeat(64),
              revision: 1,
            },
            transcriptOperationId: `${continuationId}:planner`,
            analyzerReceiptReference: 'receipt:continuation-1',
            usage: {
              provider: 'codex',
              profile: 'test',
              profileSha256: 'e'.repeat(64),
              model: 'test-model',
              effort: 'low',
              serviceTier: 'fast',
              sessionId: 'session-1',
              durationMs: 10,
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              reasoningOutputTokens: 0,
              apiCost: { source: 'unrated' },
            },
            semanticHash: 'b'.repeat(64),
            workflowHash: 'c'.repeat(64),
            graph: {
              metadata: {
                compilerVersion: 4,
                irVersion: 'workflow-ir-v1',
                references: { predicates: [], stepTypes: [], waits: [] },
                workflowId: continuationId,
                workflowVersion: 1,
              },
              root: {
                kind: 'sequence',
                id: 'continuation-1--delivery',
                children: [
                  { kind: 'finalize', id: 'continuation-1--finished', outcome: 'continued' },
                ],
              },
            },
            status: 'awaiting_review',
          },
        ],
        retrospective: 'disabled',
        status: 'waiting',
        currentNodeId: 'deliver',
        wait: {
          nodeId: 'deliver',
          waitKind: 'workflow_change.review@1',
          reason: `Review continuation ${continuationId}`,
        },
        outcome: null,
      }),
    );

    const mismatch = await api.inject({
      method: 'POST',
      url: '/api/workflows/jira:AVIA-12045/workflow-change-review',
      payload: {
        expectedRunId: 'execution-run',
        continuationId: 'different-continuation',
        decision: 'accept',
      },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(runs.resolutions).toHaveLength(0);

    const accepted = await api.inject({
      method: 'POST',
      url: '/api/workflows/jira:AVIA-12045/workflow-change-review',
      payload: { expectedRunId: 'execution-run', continuationId, decision: 'accept' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(runs.resolutions).toEqual([
      expect.objectContaining({
        runId: 'execution-run',
        nodeId: 'deliver',
        waitKind: 'workflow_change.review@1',
        resolution: { decision: 'accept', continuationId },
      }),
    ]);
    await api.close();
  });
});
