import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildM1Api,
  createM1WorkflowService,
  ExecutionRunViewSchema,
  OperatorActivityResponseSchema,
  OperatorTaskListResponseSchema,
  WorkflowResponseSchema,
} from '../../src/control-plane/index.js';
import type { JiraIssuePort } from '../../src/integrations/index.js';
import { createJiraIssueService } from '../../src/integrations/index.js';
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
import { makeJiraSnapshot } from '../helpers/jira.js';
import { makeRepositoryCatalog } from '../helpers/repositories.js';

const resources: { readonly directory: string; readonly ledger: SqliteLedger }[] = [];

class ContractTemporalRunService implements TaskTemporalRunService {
  private readonly runs = new Map<string, TaskWorkflowPublicState>();
  public readonly resolutions: { taskReference: string; command: ResolveTaskWaitCommand }[] = [];

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
      workflowChange: null,
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
    this.resolutions.push({ taskReference, command });
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
    const temporal = new ContractTemporalRunService();
    const api = buildM1Api({
      service: workflows,
      temporalRunService: temporal,
    });

    const health = await api.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toMatchObject({ executionRuntime: 'temporal' });

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
    ExecutionRunViewSchema.parse(featureStart.json());
    ExecutionRunViewSchema.parse(bugStart.json());

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
    ExecutionRunViewSchema.parse(approved.json());
    expect(approved.json()).toMatchObject({
      status: 'waiting',
      wait: { waitKind: 'code_review@1' },
    });

    const completedBug = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/resume',
      payload: { guidance: 'VPN is enabled; retry the preserved step.' },
    });
    ExecutionRunViewSchema.parse(completedBug.json());
    expect(completedBug.json()).toMatchObject({ status: 'completed' });
    expect(temporal.resolutions.at(-1)?.command.resolution).toEqual({
      decision: 'resume',
      guidance: 'VPN is enabled; retry the preserved step.',
    });

    const featureRun = await api.inject({
      method: 'GET',
      url: '/api/workflows/avia-12536-feature-review/run',
    });
    ExecutionRunViewSchema.parse(featureRun.json());
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
    ExecutionRunViewSchema.parse(started.json());
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
    ExecutionRunViewSchema.parse(answered.json());
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
    ExecutionRunViewSchema.parse(revised.json());
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
    ExecutionRunViewSchema.parse(approved.json());
    expect(approved.json()).toMatchObject({
      status: 'waiting',
      wait: { waitKind: 'code_review@1' },
    });

    await api.close();
  });

  it('keeps workflow generation and operator projections independent of the runtime', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-temporal-product-api-'));
    const clock = makeAdjustableClock('2026-08-03T10:00:00.000Z');
    const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
    resources.push({ directory, ledger });
    const workflows = createM1WorkflowService(ledger.repository, clock);
    const api = buildM1Api({
      service: workflows,
      temporalRunService: new ContractTemporalRunService(),
    });

    const missing = await api.inject({
      method: 'GET',
      url: '/api/workflows/avia-13236-short-bug',
    });
    const generatedResponse = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/generate',
    });
    const rejectedResponse = await api.inject({
      method: 'POST',
      url: '/api/workflows/invalid-unmet-capability/generate',
    });
    const graph = await api.inject({
      method: 'GET',
      url: '/api/workflows/avia-13236-short-bug/graph.json',
    });
    const rejectedGraph = await api.inject({
      method: 'GET',
      url: '/api/workflows/invalid-unmet-capability/graph.json',
    });
    const tasks = OperatorTaskListResponseSchema.parse(
      (await api.inject({ method: 'GET', url: '/api/operator/tasks' })).json(),
    );
    const activity = OperatorActivityResponseSchema.parse(
      (
        await api.inject({
          method: 'GET',
          url: '/api/operator/tasks/avia-13236-short-bug/activity',
        })
      ).json(),
    );

    expect(missing.statusCode).toBe(404);
    expect(WorkflowResponseSchema.parse(generatedResponse.json()).status).toBe('ready');
    expect(WorkflowResponseSchema.parse(rejectedResponse.json()).status).toBe('rejected');
    expect(graph.statusCode).toBe(200);
    expect(rejectedGraph.statusCode).toBe(409);
    expect(tasks.tasks.find((task) => task.id === 'avia-13236-short-bug')).toMatchObject({
      status: 'planned',
    });
    expect(activity.entries.map((entry) => entry.title)).toEqual([
      'Intake accepted',
      'Task created',
      'Workflow compiled and persisted',
    ]);

    await api.close();
  });

  it('updates Jira sync health without appending routine timeline noise', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-temporal-jira-api-'));
    const clock = makeAdjustableClock('2026-08-03T10:00:00.000Z');
    const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
    resources.push({ directory, ledger });
    const workflows = createM1WorkflowService(ledger.repository, clock);
    const jiraPort: JiraIssuePort = {
      fetchIssue: vi.fn(() => Promise.resolve(ok(makeJiraSnapshot()))),
      fetchAttachment: vi.fn(),
    };
    const jiraIssueService = createJiraIssueService(ledger.repository, clock, jiraPort, {
      repositoryCatalog: makeRepositoryCatalog(),
    });
    const api = buildM1Api({
      service: workflows,
      jiraIssueService,
      temporalRunService: new ContractTemporalRunService(),
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const synced = await api.inject({
        method: 'POST',
        url: '/api/jira/issues/AVIA-13235/sync',
        ...(attempt === 0 ? { payload: { repository: 'front-avia' } } : {}),
      });
      expect(synced.statusCode).toBe(200);
    }
    const activity = OperatorActivityResponseSchema.parse(
      (
        await api.inject({
          method: 'GET',
          url: '/api/operator/tasks/jira%3AAVIA-13235/activity',
        })
      ).json(),
    );

    expect(
      ledger.repository.listEvents('intake:jira:AVIA-13235').map(({ eventType }) => eventType),
    ).toEqual(['JiraIntakeRequested', 'JiraRepositoryBound']);
    expect(activity.entries.map(({ title }) => title)).toEqual([
      'Jira issue imported',
      'Repository mapped',
    ]);

    await api.close();
  });
});
