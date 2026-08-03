import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildM1Api,
  createM1WorkflowService,
  OperatorTaskListResponseSchema,
  WorkflowResponseSchema,
} from '../../src/control-plane/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { err, ok } from '../../src/shared/outcome.js';
import {
  type ResolveTaskWaitCommand,
  type StartTaskWorkflowInput,
  type TaskTemporalRunService,
  type TaskWorkflowPlanningState,
  type TaskWorkflowPublicState,
} from '../../src/temporal/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';

const resources: { readonly directory: string; readonly ledger: SqliteLedger }[] = [];

class ContractTemporalRunService implements TaskTemporalRunService {
  private readonly runs = new Map<string, TaskWorkflowPublicState>();

  public constructor(private readonly startsWithQuestion = false) {}

  private executionContext(
    input: StartTaskWorkflowInput,
  ): TaskWorkflowPublicState['executionContext'] {
    const workspaceId = '0'.repeat(24);
    return {
      status: 'ready',
      workspace: {
        schemaVersion: 1,
        workspaceId,
        taskReference: input.taskReference,
        workflowId: `tasker:${input.taskReference}`,
        workflowRunId: `run:${input.taskReference}`,
        workflowHash: input.workflowHash,
        repository: {
          reference: 'contract/repository',
          sourcePath: '/tasker/repositories/contract',
          baseCommit: '0'.repeat(40),
        },
        runnerId: 'contract',
        path: '/tasker/worktrees/contract',
        branch: `tasker/${input.taskReference}`,
        preparedAt: '2026-08-03T00:00:00.000Z',
      },
      bootstrap: {
        schemaVersion: 1,
        operationId: `workspace:${workspaceId}:bootstrap@1`,
        workspaceId,
        adapterId: 'contract',
        adapterVersion: '1',
        profile: 'contract',
        files: [],
        completedAt: '2026-08-03T00:00:00.000Z',
      },
      planningSnapshot: {
        artifactId: `planning-snapshot:${input.taskReference}`,
        checksum: '0'.repeat(64),
      },
    };
  }

  private planning(
    input: Pick<StartTaskWorkflowInput, 'taskReference' | 'settings'>,
    status: 'ready' | 'needs_clarification',
    attempt: number,
  ): TaskWorkflowPlanningState {
    const selectedStrategy: 'fast' | 'ralplan' =
      input.settings.planningStrategy === 'ralplan' ? 'ralplan' : 'fast';
    const common = {
      commandId: `tasker:${input.taskReference}:planning:${String(attempt)}`,
      transcriptId: `planning-transcript:tasker:${input.taskReference}:planning:${String(attempt)}`,
      attempt,
      artifactId: `plan:${input.taskReference}:${String(attempt)}`,
      requestedStrategy: input.settings.planningStrategy,
      selectedStrategy,
      receipt: {
        status: 'completed' as const,
        provider: 'deterministic' as const,
        plannerVersion: 'implementation-planner@1' as const,
        cliVersion: 'contract@1',
        model: 'deterministic',
        serviceTier: 'fast' as const,
        strategy: selectedStrategy,
        sessionId: `contract:${String(attempt)}`,
        promptHash: '0'.repeat(64),
        durationMs: 0,
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        hypotheticalApiCostUsd: 0,
      },
    };
    return status === 'ready'
      ? { ...common, status }
      : {
          ...common,
          status,
          questions: [
            {
              id: 'target-browser',
              question: 'Which browsers must be verified?',
              reason: 'The task does not say.',
            },
          ],
        };
  }

  public start(input: StartTaskWorkflowInput) {
    const existing = this.runs.get(input.taskReference);
    if (existing !== undefined) return Promise.resolve(ok(existing));

    const wait = this.startsWithQuestion
      ? { nodeId: 'analyze-task', waitKind: 'human_clarification' }
      : input.settings.planApproval === 'required'
        ? { nodeId: 'review-plan', waitKind: 'plan.approved@1' }
        : { nodeId: 'wait-for-code-review', waitKind: 'code_review@1' };
    const state: TaskWorkflowPublicState = {
      schemaVersion: 1,
      taskReference: input.taskReference,
      workflowId: `tasker:${input.taskReference}`,
      runId: `run:${input.taskReference}`,
      workflowHash: input.workflowHash,
      settings: input.settings,
      executionContext: this.executionContext(input),
      planning: this.startsWithQuestion ? this.planning(input, 'needs_clarification', 1) : null,
      status: 'waiting',
      currentNodeId: wait.nodeId,
      wait,
      outcome: null,
      nodeStates: { [wait.nodeId]: 'waiting' },
      attempts: {},
    };
    this.runs.set(input.taskReference, state);
    return Promise.resolve(ok(state));
  }

  public read(taskReference: string) {
    return Promise.resolve(ok(this.runs.get(taskReference) ?? null));
  }

  public resolveWait(taskReference: string, command: ResolveTaskWaitCommand) {
    const current = this.runs.get(taskReference);
    if (current === undefined) {
      return Promise.resolve(err({ kind: 'run_not_found' as const, taskReference }));
    }
    if (current.status !== 'waiting') {
      return Promise.resolve(
        err({ kind: 'runtime_unavailable' as const, message: 'Workflow is not waiting' }),
      );
    }
    if (current.wait.nodeId !== command.nodeId || current.wait.waitKind !== command.waitKind) {
      return Promise.resolve(
        err({ kind: 'runtime_unavailable' as const, message: 'Wait command does not match' }),
      );
    }

    const resolution =
      typeof command.resolution === 'object' &&
      command.resolution !== null &&
      !Array.isArray(command.resolution)
        ? command.resolution
        : {};
    const state: TaskWorkflowPublicState =
      current.wait.waitKind === 'human_clarification'
        ? {
            ...current,
            status: 'waiting',
            currentNodeId: 'review-plan',
            wait: { nodeId: 'review-plan', waitKind: 'plan.approved@1' },
            planning: this.planning({ taskReference, settings: current.settings }, 'ready', 2),
            outcome: null,
            nodeStates: {
              ...current.nodeStates,
              [current.wait.nodeId]: 'succeeded',
              'review-plan': 'waiting',
            },
          }
        : current.wait.waitKind === 'plan.approved@1' && resolution.decision === 'request_changes'
          ? {
              ...current,
              status: 'waiting',
              currentNodeId: 'review-plan',
              wait: { nodeId: 'review-plan', waitKind: 'plan.approved@1' },
              planning: this.planning(
                { taskReference, settings: current.settings },
                'ready',
                (current.planning?.attempt ?? 1) + 1,
              ),
              outcome: null,
              nodeStates: { ...current.nodeStates, 'review-plan': 'waiting' },
            }
          : current.wait.waitKind === 'plan.approved@1'
            ? {
                ...current,
                status: 'waiting',
                currentNodeId: 'wait-for-code-review',
                wait: { nodeId: 'wait-for-code-review', waitKind: 'code_review@1' },
                outcome: null,
                nodeStates: {
                  ...current.nodeStates,
                  [current.wait.nodeId]: 'succeeded',
                  'wait-for-code-review': 'waiting',
                },
              }
            : {
                ...current,
                status: 'completed',
                currentNodeId: null,
                wait: null,
                outcome: 'waiting_for_review',
                nodeStates: {
                  ...current.nodeStates,
                  [current.wait.nodeId]: 'succeeded',
                },
              };
    this.runs.set(taskReference, state);
    return Promise.resolve(ok(state));
  }
}

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.ledger.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe('Temporal HTTP boundary', () => {
  it('projects and advances only the selected Temporal task', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-temporal-api-'));
    const clock = makeAdjustableClock('2026-08-03T10:00:00.000Z');
    const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
    resources.push({ directory, ledger });
    const workflows = createM1WorkflowService(ledger.repository, clock);
    workflows.generate('avia-13236-short-bug');
    workflows.generate('avia-12536-feature-review');
    const api = buildM1Api({
      service: workflows,
      temporalRunService: new ContractTemporalRunService(),
    });

    const featureStart = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-12536-feature-review/start',
      payload: { settings: { planApproval: 'required', planningStrategy: 'auto' } },
    });
    const bugStart = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/start',
      payload: { settings: { planApproval: 'automatic', planningStrategy: 'auto' } },
    });

    expect(featureStart.json()).toMatchObject({
      status: 'waiting',
      wait: { waitKind: 'plan.approved@1' },
    });
    expect(bugStart.json()).toMatchObject({
      status: 'waiting',
      wait: { waitKind: 'code_review@1' },
    });

    const tasks = OperatorTaskListResponseSchema.parse(
      (await api.inject({ method: 'GET', url: '/api/operator/tasks' })).json(),
    );
    expect(tasks.tasks.find((task) => task.id === 'avia-12536-feature-review')).toMatchObject({
      status: 'plan_review',
    });
    expect(tasks.tasks.find((task) => task.id === 'avia-13236-short-bug')).toMatchObject({
      status: 'code_review',
    });

    const workflow = WorkflowResponseSchema.parse(
      (
        await api.inject({
          method: 'GET',
          url: '/api/workflows/avia-12536-feature-review',
        })
      ).json(),
    );
    const reviewPlan = workflow.view.workflow.tree?.children.find(
      (node) => node.id === 'review-plan',
    );
    expect(reviewPlan?.status).toBe('waiting');

    const approved = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-12536-feature-review/plan-review',
      payload: { decision: 'approve' },
    });
    expect(approved.json()).toMatchObject({
      status: 'waiting',
      wait: { waitKind: 'code_review@1' },
    });

    const completedBug = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/resume',
    });
    expect(completedBug.json()).toMatchObject({ status: 'completed' });

    const featureRun = await api.inject({
      method: 'GET',
      url: '/api/workflows/avia-12536-feature-review/run',
    });
    expect(featureRun.json()).toMatchObject({
      status: 'waiting',
      wait: { waitKind: 'code_review@1' },
    });

    await api.close();
  });

  it('routes clarification answers and plan revisions through typed Temporal updates', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-temporal-planning-api-'));
    const clock = makeAdjustableClock('2026-08-03T10:00:00.000Z');
    const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
    resources.push({ directory, ledger });
    const workflows = createM1WorkflowService(ledger.repository, clock);
    workflows.generate('avia-12536-feature-review');
    const api = buildM1Api({
      service: workflows,
      temporalRunService: new ContractTemporalRunService(true),
    });

    const started = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-12536-feature-review/start',
      payload: { settings: { planApproval: 'required', planningStrategy: 'ralplan' } },
    });
    expect(started.json()).toMatchObject({
      status: 'waiting',
      wait: { waitKind: 'human_clarification' },
      planning: { status: 'needs_clarification', attempt: 1 },
    });

    const genericResume = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-12536-feature-review/resume',
    });
    expect(genericResume.statusCode).toBe(409);
    expect(genericResume.json()).toMatchObject({ error: 'typed_resolution_required' });

    const incomplete = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-12536-feature-review/planning-clarification',
      payload: { answers: [{ questionId: 'another-question', answer: 'Unknown' }] },
    });
    expect(incomplete.statusCode).toBe(400);

    const answered = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-12536-feature-review/planning-clarification',
      payload: { answers: [{ questionId: 'target-browser', answer: 'Chrome and Safari' }] },
    });
    expect(answered.json()).toMatchObject({
      status: 'waiting',
      wait: { waitKind: 'plan.approved@1' },
      planning: { status: 'ready', attempt: 2, selectedStrategy: 'ralplan' },
    });

    const revised = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-12536-feature-review/plan-review',
      payload: {
        decision: 'request_changes',
        guidance: 'Add the rollback verification before implementation.',
      },
    });
    expect(revised.json()).toMatchObject({
      status: 'waiting',
      wait: { waitKind: 'plan.approved@1' },
      planning: { status: 'ready', attempt: 3 },
    });

    const approved = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-12536-feature-review/plan-review',
      payload: { decision: 'approve' },
    });
    expect(approved.json()).toMatchObject({
      status: 'waiting',
      wait: { waitKind: 'code_review@1' },
    });

    await api.close();
  });
});
