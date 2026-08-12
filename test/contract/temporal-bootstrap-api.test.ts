import { afterEach, describe, expect, it } from 'vitest';

import { BlockReceiptStore } from '../../src/blocks/index.js';
import {
  buildM1Api,
  createM1WorkflowService,
  ExecutionRunViewSchema,
  OperatorTaskListResponseSchema,
  OperatorWorkflowProjectionSchema,
} from '../../src/control-plane/index.js';
import { PlanReviewStore } from '../../src/control-plane/plan-review.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { findTaskFixture } from '../../src/planning/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { err, ok } from '../../src/shared/outcome.js';
import {
  BootstrapWorkflowInputSchema,
  BootstrapWorkflowPublicStateSchema,
  type BootstrapWorkflowInput,
  type ResolveBootstrapWaitCommand,
  type TaskRunPublicState,
  type TaskRunService,
} from '../../src/temporal/index.js';

const resources: SqliteLedger[] = [];

afterEach(() => {
  for (const ledger of resources.splice(0)) ledger.close();
});

const bootstrapWait = (
  input: BootstrapWorkflowInput,
  waitKind = 'plan.approved@1',
): TaskRunPublicState =>
  BootstrapWorkflowPublicStateSchema.parse(
    (() => {
      const workflowId = `tasker:v3:${input.taskReference}`;
      const runId = `run:${input.taskReference}`;
      const planningEpisodeId = `${workflowId}:${runId}:planning`;
      const evidenceBundle = {
        artifactId: `evidence-bundle:${planningEpisodeId}:r1`,
        checksum: '0'.repeat(64),
        revision: 1,
      };
      const planningSnapshot = {
        artifactId: `planning-snapshot:${planningEpisodeId}`,
        checksum: '1'.repeat(64),
      };
      const graph = {
        metadata: {
          compilerVersion: 4,
          irVersion: 'm2',
          workflowId: `${input.taskReference}-workflow`,
          workflowVersion: 1,
          references: { predicates: [], stepTypes: [], waits: [] },
        },
        root: { kind: 'finalize', id: 'accepted', outcome: 'accepted' },
      };
      const draft = {
        workflowHash: '2'.repeat(64),
        graph,
        planningSnapshot,
        evidenceBundle,
      };
      return {
        runtime: 'bootstrap',
        schemaVersion: 3,
        taskReference: input.taskReference,
        workflowId,
        runId,
        workflowHash: draft.workflowHash,
        settings: input.settings,
        phase: waitKind === 'plan.approved@1' ? 'plan_review' : 'planning',
        workspaceContext: null,
        context: null,
        draft,
        planning: {
          status: 'ready',
          planningEpisodeId,
          commandId: `${planningEpisodeId}:1`,
          transcriptId: `planning-transcript:${planningEpisodeId}:1`,
          attempt: 1,
          artifactId: 'plan:attempt-1',
          workflowOperationId: `${planningEpisodeId}:1:workflow-candidate:1`,
          evidenceBundle,
          requestedStrategy: input.settings.planningStrategy,
          selectedStrategy: input.settings.planningStrategy === 'ralplan' ? 'ralplan' : 'fast',
          draft,
          receipt: {
            status: 'completed',
            provider: 'deterministic',
            plannerVersion: 'implementation-planner@3',
            profile: 'contract',
            profileSha256: '3'.repeat(64),
            cliVersion: 'contract@1',
            model: 'deterministic',
            effort: 'low',
            serviceTier: null,
            strategy: input.settings.planningStrategy === 'ralplan' ? 'ralplan' : 'fast',
            sessionId: `${planningEpisodeId}:session`,
            promptHash: '4'.repeat(64),
            durationMs: 0,
            usage: {
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
            },
            hypotheticalApiCostUsd: 0,
          },
        },
        freezeReceipt: null,
        executionWorkflowId: null,
        nodeStates: { plan_review: 'waiting' },
        attempts: { planning: 1 },
        status: 'waiting',
        currentNodeId: 'plan_review',
        wait: { nodeId: 'plan_review', waitKind },
        outcome: null,
      };
    })(),
  );

class ContractTaskRunService implements TaskRunService {
  public readonly starts: BootstrapWorkflowInput[] = [];
  public readonly restarts: string[] = [];
  public readonly resolutions: ResolveBootstrapWaitCommand[] = [];
  private current: TaskRunPublicState | null = null;

  public start(inputValue: BootstrapWorkflowInput) {
    const input = BootstrapWorkflowInputSchema.parse(inputValue);
    this.starts.push(input);
    this.current = bootstrapWait(input);
    return Promise.resolve(ok(this.current));
  }

  public read() {
    return Promise.resolve(ok(this.current));
  }

  public readLifecycle() {
    return Promise.resolve(
      ok(
        this.current?.runtime === 'bootstrap' ? { bootstrap: this.current, execution: null } : null,
      ),
    );
  }

  public restart(taskReference: string) {
    if (this.current === null || this.current.taskReference !== taskReference) {
      return Promise.resolve(err({ kind: 'run_not_found' as const, taskReference }));
    }
    if (this.current.runtime !== 'bootstrap') {
      return Promise.resolve(err({ kind: 'run_not_restartable' as const, taskReference }));
    }
    this.restarts.push(taskReference);
    const input = BootstrapWorkflowInputSchema.parse({
      schemaVersion: 3,
      taskReference,
      settings: this.current.settings,
    });
    this.current = BootstrapWorkflowPublicStateSchema.parse({
      ...bootstrapWait(input),
      runId: `restarted:${taskReference}`,
    });
    return Promise.resolve(ok(this.current));
  }

  public resolveWait(taskReference: string, command: ResolveBootstrapWaitCommand) {
    if (this.current === null || this.current.taskReference !== taskReference) {
      return Promise.resolve(err({ kind: 'run_not_found' as const, taskReference }));
    }
    this.resolutions.push(command);
    return Promise.resolve(ok(this.current));
  }
}

const setup = () => {
  const clock = makeAdjustableClock('2026-08-09T00:00:00.000Z');
  const ledger = openSqliteLedger({
    filename: ':memory:',
    clock,
  });
  resources.push(ledger);
  const service = createM1WorkflowService(ledger.repository, clock, {
    includeTestFixtures: true,
  });
  const runs = new ContractTaskRunService();
  const api = buildM1Api({
    service,
    temporalRunService: runs,
    blockReceipts: new BlockReceiptStore(ledger.repository, clock),
    planReviews: new PlanReviewStore(ledger.repository, clock),
  });
  return { api, runs, service };
};

describe('Temporal v3 bootstrap HTTP contract', () => {
  it('starts durable bootstrap without requiring a precompiled graph', async () => {
    const { api, runs } = setup();
    const response = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/generate',
      payload: {
        settings: {
          planReview: 'automatic',
          planningStrategy: 'fast',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(ExecutionRunViewSchema.parse(response.json())).toMatchObject({
      runtime: 'bootstrap',
      schemaVersion: 3,
      status: 'waiting',
    });
    expect(runs.starts).toHaveLength(1);
    expect(runs.starts[0]).toMatchObject({
      schemaVersion: 3,
      settings: {
        planReview: 'automatic',
        planningStrategy: 'fast',
        executionStart: 'automatic',
      },
    });
  });

  it('rejects the removed manual execution gate', async () => {
    const { api, runs } = setup();
    const response = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/generate',
      payload: {
        settings: {
          planReview: 'automatic',
          planningStrategy: 'fast',
          executionStart: 'manual',
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(runs.starts).toHaveLength(0);
  });

  it('restarts an unfinished run only after literal operator confirmation', async () => {
    const { api, runs } = setup();
    await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/generate',
      payload: {
        settings: {
          planReview: 'required',
          planningStrategy: 'fast',
        },
      },
    });

    const unconfirmed = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/restart',
      payload: { confirmation: true },
    });
    const restarted = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/restart',
      payload: { confirmation: 'restart_from_scratch' },
    });

    expect(unconfirmed.statusCode).toBe(400);
    expect(runs.restarts).toEqual(['avia-13236-short-bug']);
    expect(restarted.statusCode).toBe(200);
    expect(ExecutionRunViewSchema.parse(restarted.json())).toMatchObject({
      runtime: 'bootstrap',
      runId: 'restarted:avia-13236-short-bug',
      settings: {
        planReview: 'required',
        planningStrategy: 'fast',
        executionStart: 'automatic',
      },
    });
  });

  it('does not present task-level workflow history without a current Temporal run', async () => {
    const { api, service } = setup();
    const fixture = findTaskFixture('avia-13236-short-bug');
    if (fixture === undefined) throw new Error('Expected workflow fixture');
    expect(
      service.assembleTaskAtOperation(
        fixture,
        'tasker:v3:fixture:historical-run:planning:workflow-candidate:1',
      ),
    ).toMatchObject({ ok: true });

    const response = await api.inject({ method: 'GET', url: '/api/operator/tasks' });
    expect(response.statusCode).toBe(200);
    const task = OperatorTaskListResponseSchema.parse(response.json()).tasks.find(
      ({ id }) => id === 'avia-13236-short-bug',
    );
    expect(task).toMatchObject({
      status: 'backlog',
      attention: 'none',
      currentStage: 'Awaiting workflow generation',
    });
  });

  it('projects only the workflow operation owned by the current Temporal run', async () => {
    const { api, runs, service } = setup();
    const taskReference = 'avia-13236-short-bug';
    const fixture = findTaskFixture(taskReference);
    if (fixture === undefined) throw new Error('Expected workflow fixture');

    expect(
      service.assembleTaskAtOperation(
        fixture,
        `tasker:v3:${taskReference}:old-run:planning:1:workflow-candidate:1`,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await runs.start({
        schemaVersion: 3,
        taskReference,
        settings: {
          planReview: 'required',
          planningStrategy: 'fast',
          executionStart: 'automatic',
        },
      }),
    ).toMatchObject({ ok: true });
    const currentOperationId = `tasker:v3:${taskReference}:run:${taskReference}:planning:1:workflow-candidate:1`;
    expect(service.assembleTaskAtOperation(fixture, currentOperationId)).toMatchObject({
      ok: true,
    });

    const response = await api.inject({
      method: 'GET',
      url: `/api/workflows/${taskReference}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ready',
      view: { workflow: { proposalId: `proposal:${currentOperationId}` } },
    });
  });

  it('projects bootstrap progress before an execution graph exists', async () => {
    const { api } = setup();
    await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/generate',
      payload: {
        settings: {
          planReview: 'required',
          planningStrategy: 'fast',
        },
      },
    });

    const response = await api.inject({
      method: 'GET',
      url: '/api/operator/tasks/avia-13236-short-bug/projection',
    });
    expect(response.statusCode).toBe(200);
    const projection = OperatorWorkflowProjectionSchema.parse(response.json());
    expect(projection).toMatchObject({
      schemaVersion: 4,
      taskReference: 'avia-13236-short-bug',
      status: 'waiting',
      activeRuntime: 'bootstrap',
      graphHash: '2'.repeat(64),
    });
    expect(projection.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'bootstrap:workspace:1', label: 'Workspace' }),
        expect.objectContaining({ key: 'bootstrap:investigation:2', label: 'Investigate' }),
        expect.objectContaining({
          key: 'bootstrap:planning:3',
          label: 'Plan',
          status: 'waiting',
        }),
      ]),
    );
  });

  it('routes plan approval to the active bootstrap wait', async () => {
    const { api, runs } = setup();
    await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/generate',
      payload: {
        settings: {
          planReview: 'required',
          planningStrategy: 'auto',
        },
      },
    });

    const response = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/plan-review',
      payload: {
        decision: 'approve',
        reviewId: 'review-1',
        planArtifactId: 'plan:attempt-1',
        planAttempt: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runs.resolutions).toEqual([
      {
        nodeId: 'plan_review',
        waitKind: 'plan.approved@1',
        resolution: { decision: 'approve' },
      },
    ]);

    const history = await api.inject({
      method: 'GET',
      url: '/api/workflows/avia-13236-short-bug/plan-reviews',
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({
      rounds: [
        {
          reviewId: 'review-1',
          decision: 'approve',
          status: 'applied',
        },
      ],
    });
    await api.close();
  });
});
