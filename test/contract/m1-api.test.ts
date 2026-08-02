import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildM1Api,
  CodexWorkflowGenerator,
  createImplementationPlanningCoordinator,
  createM1WorkflowService,
  DeterministicStubRunService,
  FixtureListResponseSchema,
  ImplementationPlanningRecordSchema,
  OperatorActivityResponseSchema,
  OperatorTaskListResponseSchema,
  WorkflowResponseSchema,
  WorkflowGenerationSubjectSource,
} from '../../src/control-plane/index.js';
import type { JiraIssuePort } from '../../src/integrations/jira/client.js';
import { JiraIssueStateSchema } from '../../src/integrations/jira/contracts.js';
import { createJiraIssueService } from '../../src/integrations/jira/service.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { RepositoryCatalogResponseSchema } from '../../src/repositories/contracts.js';
import { DeterministicImplementationPlanner } from '../../src/providers/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { ok } from '../../src/shared/outcome.js';
import { makeJiraSnapshot } from '../helpers/jira.js';
import { makeRepositoryCatalog } from '../helpers/repositories.js';

const resources: { readonly directory: string; readonly ledger: SqliteLedger }[] = [];

const setup = (
  useWorkflowGenerator = false,
  jiraPort?: JiraIssuePort,
  useImplementationPlanning = false,
) => {
  const directory = mkdtempSync(join(tmpdir(), 'tasker-m1-api-'));
  const clock = makeAdjustableClock('2026-08-01T12:00:00.000Z');
  const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
  resources.push({ directory, ledger });
  const service = createM1WorkflowService(ledger.repository, clock);
  const runService = new DeterministicStubRunService(ledger.repository, service, clock);
  const jiraIssueService =
    jiraPort === undefined
      ? undefined
      : createJiraIssueService(ledger.repository, clock, jiraPort, {
          repositoryCatalog: makeRepositoryCatalog(),
        });
  const generate = vi.fn((fixtureId: string) => Promise.resolve(service.generate(fixtureId)));
  const subjects = new WorkflowGenerationSubjectSource(directory, jiraIssueService);
  const jiraWorkflowGenerator =
    jiraIssueService === undefined ? undefined : new CodexWorkflowGenerator(service, subjects);
  const implementationPlanning = useImplementationPlanning
    ? createImplementationPlanningCoordinator({
        ledger: ledger.repository,
        clock,
        workflows: service,
        subjects,
        planner: new DeterministicImplementationPlanner(),
      })
    : undefined;
  return {
    api: buildM1Api({
      service,
      runService,
      ...(implementationPlanning === undefined ? {} : { implementationPlanning }),
      ...(jiraIssueService === undefined ? {} : { jiraIssueService }),
      ...(useWorkflowGenerator
        ? { workflowGenerator: { generate } }
        : jiraWorkflowGenerator === undefined
          ? {}
          : { workflowGenerator: jiraWorkflowGenerator }),
    }),
    generate,
    ledger,
    service,
    runService,
  };
};

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.ledger.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe('M1 HTTP API', () => {
  it('routes operator generation through the configured real-provider boundary', async () => {
    const { api, generate } = setup(true);

    const response = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/generate',
    });

    expect(response.statusCode).toBe(200);
    expect(generate).toHaveBeenCalledExactlyOnceWith('avia-13236-short-bug');

    await api.close();
  });

  it('imports a Jira issue, lists it in the queue, and proxies persisted attachment metadata', async () => {
    const jiraPort: JiraIssuePort = {
      fetchIssue: vi.fn(() => Promise.resolve(ok(makeJiraSnapshot()))),
      fetchAttachment: vi.fn(() =>
        Promise.resolve(ok({ bytes: new Uint8Array([1, 2, 3]), contentType: 'video/mp4' })),
      ),
    };
    const { api } = setup(false, jiraPort);

    const repositoriesResponse = await api.inject({ method: 'GET', url: '/api/repositories' });
    const syncResponse = await api.inject({
      method: 'POST',
      url: '/api/jira/issues/AVIA-13235/sync',
      payload: { repository: 'front-avia' },
    });
    const readResponse = await api.inject({
      method: 'GET',
      url: '/api/jira/issues/AVIA-13235',
    });
    const generateResponse = await api.inject({
      method: 'POST',
      url: '/api/workflows/jira%3AAVIA-13235/generate',
    });
    const generated = WorkflowResponseSchema.parse(generateResponse.json());
    const taskResponse = await api.inject({ method: 'GET', url: '/api/operator/tasks' });
    const tasks = OperatorTaskListResponseSchema.parse(taskResponse.json());
    const issueState = JiraIssueStateSchema.parse(readResponse.json());
    const attachmentResponse = await api.inject({
      method: 'GET',
      url: '/api/jira/issues/AVIA-13235/attachments/245370',
    });
    const repositories = RepositoryCatalogResponseSchema.parse(repositoriesResponse.json());

    expect(repositories.repositories.map((repository) => repository.repositoryId)).toEqual([
      'front-avia',
      'ui-kit',
    ]);
    expect(syncResponse.statusCode).toBe(200);
    expect(generateResponse.statusCode).toBe(200);
    expect(generated).toMatchObject({
      status: 'ready',
      view: {
        fixture: { id: 'jira:AVIA-13235', family: 'short_bugfix' },
        workflow: { status: 'valid' },
      },
    });
    expect(syncResponse.json()).toMatchObject({ status: 'current' });
    expect(issueState.status).toBe('current');
    if (issueState.status !== 'current') throw new Error('Expected a current Jira snapshot');
    expect(issueState.issue.issueKey).toBe('AVIA-13235');
    expect(issueState.issue.attachments[0]?.filename).toBe('seatmap-legspace-arrow.mp4');
    expect(tasks.tasks[0]).toMatchObject({
      id: 'jira:AVIA-13235',
      title: 'Seat map uses the wrong color for the leg-space arrow',
      origin: {
        kind: 'jira',
        syncStatus: 'current',
        repositoryBinding: {
          status: 'resolved',
          source: 'intake_fallback',
          repository: { repositoryId: 'front-avia' },
        },
      },
      planning: { status: 'available' },
      status: 'planned',
    });
    expect(attachmentResponse.statusCode).toBe(200);
    expect(attachmentResponse.headers['content-type']).toBe('video/mp4');
    expect(attachmentResponse.rawPayload).toEqual(Buffer.from([1, 2, 3]));

    await api.close();
  });

  it('updates Jira sync state without growing the ledger or operator activity', async () => {
    const jiraPort: JiraIssuePort = {
      fetchIssue: vi.fn(() => Promise.resolve(ok(makeJiraSnapshot()))),
      fetchAttachment: vi.fn(),
    };
    const { api, ledger } = setup(false, jiraPort);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await api.inject({
        method: 'POST',
        url: '/api/jira/issues/AVIA-13235/sync',
        ...(attempt === 0 ? { payload: { repository: 'front-avia' } } : {}),
      });
    }
    const response = await api.inject({
      method: 'GET',
      url: '/api/operator/tasks/jira%3AAVIA-13235/activity',
    });
    const activity = OperatorActivityResponseSchema.parse(response.json());
    const auditEvents = ledger.repository.listEvents('intake:jira:AVIA-13235');

    expect(response.statusCode).toBe(200);
    expect(auditEvents.map((event) => event.eventType)).toEqual([
      'JiraIntakeRequested',
      'JiraRepositoryBound',
    ]);
    expect(activity.entries.map((entry) => entry.title)).toEqual([
      'Jira issue imported',
      'Repository mapped',
    ]);

    await api.close();
  });

  it('lists fixtures, generates a workflow, reads it, and downloads the exact graph', async () => {
    const { api, ledger } = setup();

    const fixturesResponse = await api.inject({ method: 'GET', url: '/api/fixtures' });
    const fixtures = FixtureListResponseSchema.parse(fixturesResponse.json());
    const generateResponse = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/generate',
    });
    const generated = WorkflowResponseSchema.parse(generateResponse.json());
    const readResponse = await api.inject({
      method: 'GET',
      url: '/api/workflows/avia-13236-short-bug',
    });
    const restored = WorkflowResponseSchema.parse(readResponse.json());
    const downloadResponse = await api.inject({
      method: 'GET',
      url: '/api/workflows/avia-13236-short-bug/graph.json',
    });
    const intakeResponse = await api.inject({
      method: 'GET',
      url: '/api/intakes/intake%3Aavia-13236-short-bug',
    });
    const taskResponse = await api.inject({
      method: 'GET',
      url: '/api/tasks/AVIA-13236',
    });
    const graphProjectionResponse = await api.inject({
      method: 'GET',
      url: '/api/graphs/avia-13236-short-bug',
    });
    const runResponse = await api.inject({ method: 'GET', url: '/api/runs/not-created-in-m1' });

    expect(fixtures.fixtures).toHaveLength(9);
    expect(generateResponse.statusCode).toBe(200);
    expect(generated.status).toBe('ready');
    expect(restored).toEqual(generated);
    expect(downloadResponse.statusCode).toBe(200);
    expect(downloadResponse.headers['content-disposition']).toContain(
      'avia-13236-short-bug-graph.json',
    );
    expect(downloadResponse.json()).toEqual(generated.view.workflow.graph);
    expect(intakeResponse.json()).toMatchObject({ intake: { status: 'accepted' } });
    expect(taskResponse.json()).toMatchObject({ task: { status: 'planned' } });
    expect(graphProjectionResponse.json()).toEqual(generated.view.workflow);
    expect(runResponse.statusCode).toBe(404);
    expect(ledger.repository.listOutbox()).toEqual([]);

    await api.close();
  });

  it('starts a persisted workflow and stops at the code-review wait', async () => {
    const { api } = setup();
    await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/generate',
    });

    const startedResponse = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/start',
      payload: { settings: { planApproval: 'automatic', planningStrategy: 'auto' } },
    });
    const taskResponse = await api.inject({ method: 'GET', url: '/api/operator/tasks' });
    const activityResponse = await api.inject({
      method: 'GET',
      url: '/api/operator/tasks/avia-13236-short-bug/activity',
    });
    const workflowResponse = await api.inject({
      method: 'GET',
      url: '/api/workflows/avia-13236-short-bug',
    });

    expect(startedResponse.statusCode).toBe(200);
    expect(startedResponse.json()).toMatchObject({
      status: 'waiting',
      settings: { planApproval: 'automatic' },
      wait: { waitKind: 'code_review@1', slotPolicy: 'release' },
    });
    expect(OperatorTaskListResponseSchema.parse(taskResponse.json()).tasks[0]).toMatchObject({
      status: 'code_review',
      attention: 'operator',
      currentStage: 'Waiting for code review',
    });
    expect(OperatorActivityResponseSchema.parse(activityResponse.json()).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Run started' }),
        expect.objectContaining({ title: 'Plan review not required' }),
        expect.objectContaining({ title: 'prepare-pr' }),
        expect.objectContaining({ title: 'Waiting for code review' }),
      ]),
    );
    expect(WorkflowResponseSchema.parse(workflowResponse.json()).view.workflow.tree?.status).toBe(
      'waiting',
    );

    await api.close();
  });

  it('plans through the selected provider before the run and persists plan revisions', async () => {
    const { api } = setup(false, undefined, true);
    const fixtureId = 'avia-12536-feature-review';
    await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/generate`,
    });

    const startedResponse = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/start`,
      payload: { settings: { planApproval: 'required', planningStrategy: 'fast' } },
    });
    const firstPlanResponse = await api.inject({
      method: 'GET',
      url: `/api/workflows/${fixtureId}/implementation-plan`,
    });
    const firstPlan = ImplementationPlanningRecordSchema.parse(firstPlanResponse.json());

    expect(startedResponse.statusCode).toBe(200);
    expect(startedResponse.json()).toMatchObject({
      status: 'waiting',
      settings: { planApproval: 'required', planningStrategy: 'fast' },
      implementationPlan: {
        attempt: 1,
        requestedStrategy: 'fast',
        selectedStrategy: 'fast',
      },
      wait: { waitKind: 'plan.approved@1' },
    });
    expect(firstPlan).toMatchObject({
      status: 'ready',
      attempt: 1,
      receipt: { provider: 'deterministic', strategy: 'fast' },
      decision: { status: 'ready', plan: { title: 'Implement the requested task' } },
    });

    const guidance = 'Add a rollback check before implementation.';
    const reviewResponse = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/plan-review`,
      payload: { decision: 'request_changes', guidance },
    });
    const revisedPlanResponse = await api.inject({
      method: 'GET',
      url: `/api/workflows/${fixtureId}/implementation-plan`,
    });
    const revisedPlan = ImplementationPlanningRecordSchema.parse(revisedPlanResponse.json());

    expect(reviewResponse.statusCode).toBe(200);
    expect(reviewResponse.json()).toMatchObject({
      status: 'waiting',
      implementationPlan: { attempt: 2, selectedStrategy: 'fast' },
      wait: { waitKind: 'plan.approved@1' },
    });
    expect(revisedPlan).toMatchObject({
      status: 'ready',
      attempt: 2,
      operatorGuidance: guidance,
      decision: {
        status: 'ready',
        plan: {
          title: 'Revise the implementation plan',
        },
      },
    });
    if (revisedPlan.status !== 'ready') throw new Error('Expected the revised plan to be ready');
    expect(revisedPlan.decision.plan.summary).toContain(guidance);

    const crossRepositoryFixture = 'avia-14001-translation-component';
    await api.inject({
      method: 'POST',
      url: `/api/workflows/${crossRepositoryFixture}/generate`,
    });
    await api.inject({
      method: 'POST',
      url: `/api/workflows/${crossRepositoryFixture}/start`,
      payload: { settings: { planApproval: 'required', planningStrategy: 'auto' } },
    });
    const automaticPlanResponse = await api.inject({
      method: 'GET',
      url: `/api/workflows/${crossRepositoryFixture}/implementation-plan`,
    });
    const automaticPlan = ImplementationPlanningRecordSchema.parse(automaticPlanResponse.json());
    expect(automaticPlan).toMatchObject({
      status: 'ready',
      requestedStrategy: 'auto',
      selectedStrategy: 'ralplan',
    });
    expect(automaticPlan.selectionReason).toContain('repository/publication boundaries');

    await api.close();
  });

  it('replans from persisted operator guidance and returns to plan review', async () => {
    const { api } = setup();
    await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-12536-feature-review/generate',
    });
    await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-12536-feature-review/start',
    });

    const reviewResponse = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-12536-feature-review/plan-review',
      payload: {
        decision: 'request_changes',
        guidance: 'Add a rollback check before the implementation step.',
      },
    });
    const taskResponse = await api.inject({ method: 'GET', url: '/api/operator/tasks' });
    const activityResponse = await api.inject({
      method: 'GET',
      url: '/api/operator/tasks/avia-12536-feature-review/activity',
    });

    expect(reviewResponse.statusCode).toBe(200);
    expect(reviewResponse.json()).toMatchObject({
      status: 'waiting',
      settings: { planApproval: 'required' },
      wait: {
        waitId: 'wait:run:avia-12536-feature-review:review-plan:cycle-2',
        waitKind: 'plan.approved@1',
      },
      planRevisionRequests: [{ priorAttempt: 1, nextAttempt: 2 }],
    });
    expect(
      OperatorTaskListResponseSchema.parse(taskResponse.json()).tasks.find(
        (task) => task.id === 'avia-12536-feature-review',
      ),
    ).toMatchObject({
      status: 'plan_review',
      attention: 'operator',
      currentStage: 'Plan review required',
    });
    expect(OperatorActivityResponseSchema.parse(activityResponse.json()).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Plan changes requested · attempt 2',
          detail: 'Add a rollback check before the implementation step.',
        }),
        expect.objectContaining({
          title: 'analyze-task',
          detail: 'task.analyze@1 attempt 2 produced a durable stub receipt.',
        }),
      ]),
    );

    await api.close();
  });

  it('keeps the first run settings when a duplicate start requests a different policy', async () => {
    const { api } = setup();
    await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/generate',
    });
    await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/start',
      payload: { settings: { planApproval: 'required', planningStrategy: 'auto' } },
    });

    const conflictingStart = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-13236-short-bug/start',
      payload: { settings: { planApproval: 'automatic', planningStrategy: 'auto' } },
    });
    const persistedRun = await api.inject({
      method: 'GET',
      url: '/api/workflows/avia-13236-short-bug/run',
    });

    expect(conflictingStart.statusCode).toBe(409);
    expect(conflictingStart.json()).toMatchObject({ error: 'run_settings_conflict' });
    expect(persistedRun.json()).toMatchObject({
      status: 'waiting',
      settings: { planApproval: 'required' },
      wait: { waitKind: 'plan.approved@1' },
    });

    await api.close();
  });

  it('continues an approved plan without creating a revision attempt', async () => {
    const { api } = setup();
    await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-12536-feature-review/generate',
    });
    await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-12536-feature-review/start',
    });

    const reviewResponse = await api.inject({
      method: 'POST',
      url: '/api/workflows/avia-12536-feature-review/plan-review',
      payload: { decision: 'approve' },
    });
    const activityResponse = await api.inject({
      method: 'GET',
      url: '/api/operator/tasks/avia-12536-feature-review/activity',
    });

    expect(reviewResponse.statusCode).toBe(200);
    expect(reviewResponse.json()).toMatchObject({
      status: 'waiting',
      wait: { waitKind: 'code_review@1' },
      planRevisionRequests: [],
    });
    expect(OperatorActivityResponseSchema.parse(activityResponse.json()).entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Plan approved' })]),
    );

    await api.close();
  });

  it('returns a structured rejected workflow and refuses graph download', async () => {
    const { api } = setup();

    const generateResponse = await api.inject({
      method: 'POST',
      url: '/api/workflows/invalid-unmet-capability/generate',
    });
    const generated = WorkflowResponseSchema.parse(generateResponse.json());
    const downloadResponse = await api.inject({
      method: 'GET',
      url: '/api/workflows/invalid-unmet-capability/graph.json',
    });

    expect(generated.status).toBe('rejected');
    expect(generated.view.workflow.validatorReport.issues[0]?.message).toContain('repository.read');
    expect(downloadResponse.statusCode).toBe(409);
    expect(downloadResponse.json()).toMatchObject({ error: 'workflow_rejected' });

    await api.close();
  });

  it('keeps missing fixtures and non-generated workflows distinct', async () => {
    const { api } = setup();

    const missingWorkflow = await api.inject({
      method: 'GET',
      url: '/api/workflows/avia-12536-feature-review',
    });
    const unknownFixture = await api.inject({
      method: 'POST',
      url: '/api/workflows/not-in-catalog/generate',
    });

    expect(missingWorkflow.statusCode).toBe(404);
    expect(missingWorkflow.json()).toMatchObject({ error: 'workflow_not_found' });
    expect(unknownFixture.statusCode).toBe(404);
    expect(unknownFixture.json()).toMatchObject({ error: 'fixture_not_found' });

    await api.close();
  });

  it('renders persisted workflow state as an operator task queue', async () => {
    const { api, service } = setup();
    service.generate('avia-13236-short-bug');
    service.generate('invalid-unknown-step');

    const response = await api.inject({ method: 'GET', url: '/api/operator/tasks' });
    const taskList = OperatorTaskListResponseSchema.parse(response.json());
    const { tasks } = taskList;

    expect(response.statusCode).toBe(200);
    expect(taskList.streamCursor).toBe(6);
    expect(tasks.find((task) => task.taskId === 'AVIA-13236')).toMatchObject({
      status: 'planned',
      attention: 'none',
    });
    expect(tasks.find((task) => task.taskId === 'AVIA-15001')).toMatchObject({
      status: 'workflow_rejected',
      attention: 'operator',
    });
    expect(tasks.find((task) => task.taskId === 'AVIA-12536')).toMatchObject({
      status: 'backlog',
    });

    await api.close();
  });

  it('exposes the selected task persisted activity without inventing agent output', async () => {
    const { api, service } = setup();
    service.generate('avia-13236-short-bug');

    const response = await api.inject({
      method: 'GET',
      url: '/api/operator/tasks/avia-13236-short-bug/activity',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      providerSession: { status: 'not_started', reason: 'm1_planning_only' },
      entries: [
        { source: 'kernel', title: 'Intake accepted' },
        { source: 'kernel', title: 'Task created' },
        { source: 'planner', title: 'Workflow compiled and persisted' },
      ],
    });

    await api.close();
  });

  it('replays persisted stream events after the supplied ledger cursor', () => {
    const { service } = setup();
    service.generate('avia-13236-short-bug');

    const events = service.listStreamEventsAfter(2);

    expect(events).toEqual([
      {
        sequence: 3,
        fixtureId: 'avia-13236-short-bug',
        eventType: 'WorkflowPlanned',
      },
    ]);
  });
});
