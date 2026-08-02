import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildM1Api,
  CodexWorkflowGenerator,
  createImplementationPlanningCoordinator,
  createM1WorkflowService,
  createWorkflowContinuationCoordinator,
  DeterministicStubRunService,
  FixtureListResponseSchema,
  ImplementationPlanningRecordSchema,
  OperatorActivityResponseSchema,
  OperatorTaskListResponseSchema,
  WorkflowResponseSchema,
  WorkflowGenerationSubjectSource,
  WorkflowContinuationRecordSchema,
} from '../../src/control-plane/index.js';
import type { JiraIssuePort } from '../../src/integrations/jira/client.js';
import { JiraIssueStateSchema } from '../../src/integrations/jira/contracts.js';
import { createJiraIssueService } from '../../src/integrations/jira/service.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { RepositoryCatalogResponseSchema } from '../../src/repositories/contracts.js';
import type { RepositoryCatalog } from '../../src/repositories/catalog.js';
import { DurableStubScheduler, RunProjectionSchema } from '../../src/runner/index.js';
import {
  DeterministicImplementationPlanner,
  type ImplementationPlanner,
  type ImplementationPlannerRequest,
} from '../../src/providers/index.js';
import { ImplementationPlanningDecisionSchema } from '../../src/planning/implementation-plan.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { err, ok } from '../../src/shared/outcome.js';
import { makeJiraSnapshot } from '../helpers/jira.js';
import { makeRepositoryCatalog } from '../helpers/repositories.js';

const resources: { readonly directory: string; readonly ledger: SqliteLedger }[] = [];

const makeQuestioningPlanner = () => {
  const fallback = new DeterministicImplementationPlanner();
  const requests: ImplementationPlannerRequest[] = [];
  const planner: ImplementationPlanner = {
    plan: async (request) => {
      requests.push(request);
      const result = await fallback.plan(request);
      if (!result.ok || requests.length > 1) return result;
      return ok({
        ...result.value,
        decision: ImplementationPlanningDecisionSchema.parse({
          status: 'needs_clarification',
          questions: [
            {
              id: 'target-browser',
              question: 'Which browser must the reproduction cover?',
              reason: 'The acceptance evidence depends on the selected browser.',
            },
            {
              id: 'change-scope',
              question: 'May the implementation change the shared component?',
              reason: 'The answer changes the repository boundary of the plan.',
            },
          ],
        }),
      });
    },
  };
  return { planner, requests };
};

const makeRevisionQuestioningPlanner = () => {
  const fallback = new DeterministicImplementationPlanner();
  let calls = 0;
  const planner: ImplementationPlanner = {
    plan: async (request) => {
      calls += 1;
      const result = await fallback.plan(request);
      if (!result.ok || calls !== 2) return result;
      return ok({
        ...result.value,
        decision: ImplementationPlanningDecisionSchema.parse({
          status: 'needs_clarification',
          questions: [
            {
              id: 'rollback-owner',
              question: 'Who owns the rollback decision?',
              reason: 'The requested revision does not define the approval boundary.',
            },
          ],
        }),
      });
    },
  };
  return planner;
};

const makeWorkflowChangePlanner = (requiredCapabilities: readonly string[]) => {
  const fallback = new DeterministicImplementationPlanner();
  const planner: ImplementationPlanner = {
    plan: async (request) => {
      const result = await fallback.plan(request);
      return result.ok
        ? ok({
            ...result.value,
            decision: ImplementationPlanningDecisionSchema.parse({
              status: 'workflow_change_required',
              request: {
                reason: 'The fix belongs to the shared seat component repository.',
                discoveredRepositories: ['twiket/ui-kit'],
                requiredCapabilities,
                evidence: ['The affected component resolves from @ott/ui-kit.'],
              },
            }),
          })
        : result;
    },
  };
  return planner;
};

const makeWorkflowChangeThenReadyPlanner = (
  options: { readonly clarifyRevision?: boolean } = {},
) => {
  const fallback = new DeterministicImplementationPlanner();
  let calls = 0;
  const planner: ImplementationPlanner = {
    plan: async (request) => {
      calls += 1;
      const result = await fallback.plan(request);
      if (!result.ok) return result;
      if (options.clarifyRevision === true && calls === 2) {
        return ok({
          ...result.value,
          decision: ImplementationPlanningDecisionSchema.parse({
            status: 'needs_clarification',
            questions: [
              {
                id: 'component-boundary',
                question: 'Must the fix stay in the parent repository?',
                reason: 'The rejected continuation changed the repository boundary.',
              },
            ],
          }),
        });
      }
      if (calls > 1) return result;
      return ok({
        ...result.value,
        decision: ImplementationPlanningDecisionSchema.parse({
          status: 'workflow_change_required',
          request: {
            reason: 'The fix belongs to the shared seat component repository.',
            discoveredRepositories: ['twiket/ui-kit'],
            requiredCapabilities: ['repository.read'],
            evidence: ['The affected component resolves from @ott/ui-kit.'],
          },
        }),
      });
    },
  };
  return planner;
};

const makeWorkflowChangeWithFailedRevisionPlanner = (): ImplementationPlanner => {
  const fallback = new DeterministicImplementationPlanner();
  let calls = 0;
  return {
    plan: async (request) => {
      calls += 1;
      if (calls === 2) {
        return err({
          kind: 'provider_failed',
          exitCode: 1,
          message: 'Planner process exited while revising the continuation.',
          stderr: 'transient provider failure',
        });
      }
      const result = await fallback.plan(request);
      return result.ok
        ? ok({
            ...result.value,
            decision: ImplementationPlanningDecisionSchema.parse({
              status: 'workflow_change_required',
              request: {
                reason: 'The fix belongs to the shared seat component repository.',
                discoveredRepositories: ['twiket/ui-kit'],
                requiredCapabilities: ['repository.read'],
                evidence: ['The affected component resolves from @ott/ui-kit.'],
              },
            }),
          })
        : result;
    },
  };
};

const setup = (
  useWorkflowGenerator = false,
  jiraPort?: JiraIssuePort,
  implementationPlanner?: ImplementationPlanner,
  repositoryCatalog: RepositoryCatalog = makeRepositoryCatalog(),
  withScheduler = false,
) => {
  const directory = mkdtempSync(join(tmpdir(), 'tasker-m1-api-'));
  const clock = makeAdjustableClock('2026-08-01T12:00:00.000Z');
  const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
  resources.push({ directory, ledger });
  const service = createM1WorkflowService(ledger.repository, clock);
  const runService = new DeterministicStubRunService(ledger.repository, service, clock);
  const scheduler = withScheduler
    ? new DurableStubScheduler(runService, ledger.repository, clock, {
        capacity: 1,
        ownerId: 'contract-scheduler',
        leaseTimeoutMs: 1_000,
        pollIntervalMs: 10,
      })
    : undefined;
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
  const implementationPlanning =
    implementationPlanner === undefined
      ? undefined
      : createImplementationPlanningCoordinator({
          ledger: ledger.repository,
          clock,
          workflows: service,
          subjects,
          planner: implementationPlanner,
        });
  const workflowContinuation =
    implementationPlanning === undefined
      ? undefined
      : createWorkflowContinuationCoordinator({
          ledger: ledger.repository,
          clock,
          workflows: service,
          subjects,
          repositories: repositoryCatalog,
        });
  return {
    api: buildM1Api({
      service,
      runService,
      ...(implementationPlanning === undefined ? {} : { implementationPlanning }),
      ...(workflowContinuation === undefined ? {} : { workflowContinuation }),
      ...(scheduler === undefined ? {} : { scheduler }),
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
    scheduler,
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
    const { api } = setup(false, undefined, new DeterministicImplementationPlanner());
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

  it('compiles a validated immutable continuation and pauses the parent for review', async () => {
    const { api } = setup(
      false,
      undefined,
      makeWorkflowChangePlanner(['repository.read', 'command.run', 'workspace.write']),
    );
    const fixtureId = 'avia-13236-short-bug';
    await api.inject({ method: 'POST', url: `/api/workflows/${fixtureId}/generate` });
    const parentBefore = WorkflowResponseSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}` })).json(),
    );
    if (parentBefore.status !== 'ready') throw new Error('Expected a ready parent workflow');

    const response = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/start`,
      payload: { settings: { planApproval: 'automatic', planningStrategy: 'fast' } },
    });

    const continuation = WorkflowContinuationRecordSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/continuation` })).json(),
    );
    if (continuation.status !== 'awaiting_review') {
      throw new Error('Expected a reviewable continuation');
    }
    const candidate = WorkflowResponseSchema.parse(
      (
        await api.inject({
          method: 'GET',
          url: `/api/workflows/${continuation.candidate.taskReference}`,
        })
      ).json(),
    );
    const parentAfter = WorkflowResponseSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}` })).json(),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      runId: `run:${fixtureId}`,
      status: 'waiting',
      wait: { waitKind: 'workflow_continuation_review', slotPolicy: 'release' },
      lease: null,
      effects: [],
    });
    expect(continuation).toMatchObject({
      attempt: 1,
      reviewPolicy: 'review_all',
      parent: {
        taskReference: fixtureId,
        graphHash: parentBefore.view.workflow.graphHash,
      },
      candidate: {
        repositoryReference: 'twiket/ui-kit',
      },
    });
    expect(candidate.status).toBe('ready');
    if (candidate.status !== 'ready') throw new Error('Expected a ready candidate workflow');
    expect(candidate.view.workflow.graphHash).not.toBe(parentBefore.view.workflow.graphHash);
    expect(JSON.stringify(candidate.view.workflow.graph)).toContain('twiket/ui-kit');
    expect(parentAfter.view.workflow.graphHash).toBe(parentBefore.view.workflow.graphHash);

    await api.close();
  });

  it('executes an accepted continuation as a linked run without rewriting the parent graph', async () => {
    const { api, runService } = setup(
      false,
      undefined,
      makeWorkflowChangePlanner(['repository.read', 'command.run']),
    );
    const fixtureId = 'avia-13236-short-bug';
    await api.inject({ method: 'POST', url: `/api/workflows/${fixtureId}/generate` });
    const parentBefore = WorkflowResponseSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}` })).json(),
    );
    await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/start`,
      payload: { settings: { planApproval: 'automatic', planningStrategy: 'fast' } },
    });
    const continuationBeforeReview = WorkflowContinuationRecordSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/continuation` })).json(),
    );

    const response = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/continuation/review`,
      payload: { decision: 'accept', continuationId: continuationBeforeReview.continuationId },
    });

    const run = RunProjectionSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/run` })).json(),
    );
    const continuation = WorkflowContinuationRecordSchema.parse(response.json());
    if (continuation.status !== 'linked') throw new Error('Expected a linked continuation');
    const childRun = RunProjectionSchema.parse(
      (
        await api.inject({
          method: 'GET',
          url: `/api/workflows/${continuation.child.taskReference}/run`,
        })
      ).json(),
    );
    const tasks = OperatorTaskListResponseSchema.parse(
      (await api.inject({ method: 'GET', url: '/api/operator/tasks' })).json(),
    );
    const activity = OperatorActivityResponseSchema.parse(
      (
        await api.inject({
          method: 'GET',
          url: `/api/operator/tasks/${fixtureId}/activity`,
        })
      ).json(),
    );
    const parentAfter = WorkflowResponseSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}` })).json(),
    );
    expect(response.statusCode).toBe(200);
    expect(continuation.child).toEqual({
      taskReference: continuation.candidate.taskReference,
      runId: `run:${continuation.candidate.taskReference}`,
    });
    expect(run).toMatchObject({
      runId: `run:${fixtureId}`,
      status: 'waiting',
      wait: { waitKind: 'linked_continuation_running', slotPolicy: 'release' },
    });
    expect(childRun).toMatchObject({
      status: 'waiting',
      wait: { waitKind: 'code_review@1', slotPolicy: 'release' },
      lineage: {
        kind: 'workflow_continuation',
        parentTaskReference: fixtureId,
        parentRunId: `run:${fixtureId}`,
        continuationId: continuation.continuationId,
      },
    });
    expect(tasks.tasks.find((task) => task.id === fixtureId)).toMatchObject({
      status: 'code_review',
      currentStage: 'Waiting for code review',
    });
    expect(activity.entries.map((entry) => entry.title)).toEqual(
      expect.arrayContaining([
        'Workflow continuation execution linked',
        'Linked continuation queued',
        'Linked continuation started',
        'Waiting for code review',
      ]),
    );
    expect(
      runService
        .listStreamEventsAfter(0)
        .filter(
          (event) => event.eventType === 'LinkedRunQueued' || event.eventType === 'RunStarted',
        )
        .map((event) => event.fixtureId),
    ).not.toContain(continuation.child.taskReference);
    expect(parentAfter.view.workflow.graphHash).toBe(parentBefore.view.workflow.graphHash);

    await api.close();
  });

  it('completes the parent join after the linked continuation finishes', async () => {
    const { api } = setup(
      false,
      undefined,
      makeWorkflowChangePlanner(['repository.read', 'command.run']),
    );
    const fixtureId = 'avia-13236-short-bug';
    await api.inject({ method: 'POST', url: `/api/workflows/${fixtureId}/generate` });
    await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/start`,
      payload: { settings: { planApproval: 'automatic', planningStrategy: 'fast' } },
    });
    const proposed = WorkflowContinuationRecordSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/continuation` })).json(),
    );
    await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/continuation/review`,
      payload: { decision: 'accept', continuationId: proposed.continuationId },
    });

    const response = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/resume`,
    });

    const parentRun = RunProjectionSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/run` })).json(),
    );
    const tasks = OperatorTaskListResponseSchema.parse(
      (await api.inject({ method: 'GET', url: '/api/operator/tasks' })).json(),
    );
    expect(response.statusCode).toBe(200);
    expect(RunProjectionSchema.parse(response.json()).status).toBe('completed');
    expect(parentRun).toMatchObject({
      status: 'completed',
      wait: null,
      lineage: { kind: 'root' },
    });
    expect(tasks.tasks.find((task) => task.id === fixtureId)).toMatchObject({
      status: 'done',
      currentStage: 'Workflow completed',
    });

    await api.close();
  });

  it('lets the durable scheduler claim a linked continuation', async () => {
    const { api, scheduler } = setup(
      false,
      undefined,
      makeWorkflowChangePlanner(['repository.read', 'command.run']),
      makeRepositoryCatalog(),
      true,
    );
    if (scheduler === undefined) throw new Error('Expected a scheduler');
    const fixtureId = 'avia-13236-short-bug';
    await api.inject({ method: 'POST', url: `/api/workflows/${fixtureId}/generate` });
    await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/start`,
      payload: { settings: { planApproval: 'automatic', planningStrategy: 'fast' } },
    });
    const proposed = WorkflowContinuationRecordSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/continuation` })).json(),
    );
    const accepted = WorkflowContinuationRecordSchema.parse(
      (
        await api.inject({
          method: 'POST',
          url: `/api/workflows/${fixtureId}/continuation/review`,
          payload: { decision: 'accept', continuationId: proposed.continuationId },
        })
      ).json(),
    );
    if (accepted.status !== 'linked') throw new Error('Expected linked execution');

    const result = scheduler.tick();

    expect(result).toMatchObject({
      ok: true,
      value: {
        queued: [],
        executing: [],
        waiting: [fixtureId, accepted.child.taskReference],
      },
    });

    await api.close();
  });

  it('uses rejection guidance to compile a new candidate without restarting the parent run', async () => {
    const { api } = setup(false, undefined, makeWorkflowChangePlanner(['repository.read']));
    const fixtureId = 'avia-13236-short-bug';
    await api.inject({ method: 'POST', url: `/api/workflows/${fixtureId}/generate` });
    await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/start`,
      payload: { settings: { planApproval: 'automatic', planningStrategy: 'fast' } },
    });
    const before = WorkflowContinuationRecordSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/continuation` })).json(),
    );
    if (before.status !== 'awaiting_review') throw new Error('Expected a reviewable continuation');

    const response = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/continuation/review`,
      payload: {
        decision: 'reject',
        continuationId: before.continuationId,
        guidance: 'Keep the fix in front-avia.',
      },
    });

    const run = RunProjectionSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/run` })).json(),
    );
    const revisedPlan = ImplementationPlanningRecordSchema.parse(
      (
        await api.inject({
          method: 'GET',
          url: `/api/workflows/${fixtureId}/implementation-plan`,
        })
      ).json(),
    );
    const candidateResponse = await api.inject({
      method: 'GET',
      url: `/api/workflows/${before.candidate.taskReference}`,
    });
    expect(response.statusCode).toBe(200);
    expect(WorkflowContinuationRecordSchema.parse(response.json())).toMatchObject({
      status: 'awaiting_review',
      attempt: 2,
      parent: { runId: `run:${fixtureId}` },
    });
    expect(WorkflowContinuationRecordSchema.parse(response.json())).not.toMatchObject({
      candidate: before.candidate,
    });
    expect(run).toMatchObject({
      runId: `run:${fixtureId}`,
      status: 'waiting',
      wait: { waitKind: 'workflow_continuation_review', slotPolicy: 'release' },
    });
    expect(revisedPlan).toMatchObject({
      status: 'workflow_change_required',
      attempt: 2,
      operatorGuidance: 'Keep the fix in front-avia.',
    });
    expect(candidateResponse.statusCode).toBe(200);

    await api.close();
  });

  it('does not apply a retried rejection command to the revised candidate', async () => {
    const { api } = setup(false, undefined, makeWorkflowChangePlanner(['repository.read']));
    const fixtureId = 'avia-13236-short-bug';
    await api.inject({ method: 'POST', url: `/api/workflows/${fixtureId}/generate` });
    await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/start`,
      payload: { settings: { planApproval: 'automatic', planningStrategy: 'fast' } },
    });
    const before = WorkflowContinuationRecordSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/continuation` })).json(),
    );
    const command = {
      decision: 'reject' as const,
      continuationId: before.continuationId,
      guidance: 'Keep the fix in front-avia.',
    };
    const first = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/continuation/review`,
      payload: command,
    });
    const revised = WorkflowContinuationRecordSchema.parse(first.json());
    if (revised.status !== 'awaiting_review') throw new Error('Expected a revised candidate');

    const replay = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/continuation/review`,
      payload: command,
    });

    const plan = ImplementationPlanningRecordSchema.parse(
      (
        await api.inject({
          method: 'GET',
          url: `/api/workflows/${fixtureId}/implementation-plan`,
        })
      ).json(),
    );
    expect(replay.statusCode).toBe(200);
    expect(WorkflowContinuationRecordSchema.parse(replay.json())).toEqual(revised);
    expect(plan).toMatchObject({ status: 'workflow_change_required', attempt: 2 });

    await api.close();
  });

  it('retries a failed continuation revision without losing rejection guidance', async () => {
    const { api } = setup(false, undefined, makeWorkflowChangeWithFailedRevisionPlanner());
    const fixtureId = 'avia-13236-short-bug';
    const guidance = 'Keep the shared component but narrow the verification.';
    await api.inject({ method: 'POST', url: `/api/workflows/${fixtureId}/generate` });
    await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/start`,
      payload: { settings: { planApproval: 'automatic', planningStrategy: 'fast' } },
    });
    const before = WorkflowContinuationRecordSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/continuation` })).json(),
    );
    const failedRevision = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/continuation/review`,
      payload: { decision: 'reject', continuationId: before.continuationId, guidance },
    });
    const failedPlan = ImplementationPlanningRecordSchema.parse(
      (
        await api.inject({
          method: 'GET',
          url: `/api/workflows/${fixtureId}/implementation-plan`,
        })
      ).json(),
    );
    if (failedPlan.status !== 'failed') throw new Error('Expected a durable planning failure');

    const response = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/continuation/review`,
      payload: { decision: 'reject', continuationId: before.continuationId, guidance },
    });

    const revised = WorkflowContinuationRecordSchema.parse(response.json());
    const run = RunProjectionSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/run` })).json(),
    );
    expect(failedRevision.statusCode).toBe(200);
    expect(WorkflowContinuationRecordSchema.parse(failedRevision.json())).toMatchObject({
      status: 'rejected_by_operator',
      guidance,
    });
    expect(failedPlan).toMatchObject({ status: 'failed', attempt: 2 });
    expect(response.statusCode).toBe(200);
    expect(revised).toMatchObject({
      status: 'awaiting_review',
      attempt: 2,
      source: { attempt: 3 },
    });
    expect(run).toMatchObject({
      runId: `run:${fixtureId}`,
      status: 'waiting',
      wait: { waitKind: 'workflow_continuation_review', slotPolicy: 'release' },
    });

    await api.close();
  });

  it('continues the parent run when rejection guidance removes the workflow change', async () => {
    const { api } = setup(false, undefined, makeWorkflowChangeThenReadyPlanner());
    const fixtureId = 'avia-13236-short-bug';
    await api.inject({ method: 'POST', url: `/api/workflows/${fixtureId}/generate` });
    await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/start`,
      payload: { settings: { planApproval: 'automatic', planningStrategy: 'fast' } },
    });
    const before = WorkflowContinuationRecordSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/continuation` })).json(),
    );

    const response = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/continuation/review`,
      payload: {
        decision: 'reject',
        continuationId: before.continuationId,
        guidance: 'Keep the fix in the parent repository.',
      },
    });

    const run = RunProjectionSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/run` })).json(),
    );
    const continuation = WorkflowContinuationRecordSchema.parse(response.json());
    expect(response.statusCode).toBe(200);
    expect(continuation).toMatchObject({
      status: 'superseded_by_plan',
      guidance: 'Keep the fix in the parent repository.',
      implementationPlanArtifactId: `implementation-plan:${fixtureId}:attempt-2`,
    });
    expect(run).toMatchObject({
      runId: `run:${fixtureId}`,
      status: 'waiting',
      implementationPlan: { attempt: 2 },
      wait: { waitKind: 'code_review@1' },
    });

    await api.close();
  });

  it('asks a blocking question while revising a rejected continuation', async () => {
    const { api } = setup(
      false,
      undefined,
      makeWorkflowChangeThenReadyPlanner({ clarifyRevision: true }),
    );
    const fixtureId = 'avia-13236-short-bug';
    await api.inject({ method: 'POST', url: `/api/workflows/${fixtureId}/generate` });
    await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/start`,
      payload: { settings: { planApproval: 'automatic', planningStrategy: 'fast' } },
    });
    const before = WorkflowContinuationRecordSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/continuation` })).json(),
    );

    const response = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/continuation/review`,
      payload: {
        decision: 'reject',
        continuationId: before.continuationId,
        guidance: 'Confirm the repository boundary first.',
      },
    });

    const run = RunProjectionSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/run` })).json(),
    );
    const plan = ImplementationPlanningRecordSchema.parse(
      (
        await api.inject({
          method: 'GET',
          url: `/api/workflows/${fixtureId}/implementation-plan`,
        })
      ).json(),
    );
    const tasks = OperatorTaskListResponseSchema.parse(
      (await api.inject({ method: 'GET', url: '/api/operator/tasks' })).json(),
    );
    expect(response.statusCode).toBe(200);
    expect(WorkflowContinuationRecordSchema.parse(response.json())).toMatchObject({
      status: 'rejected_by_operator',
      guidance: 'Confirm the repository boundary first.',
    });
    expect(run).toMatchObject({
      runId: `run:${fixtureId}`,
      status: 'waiting',
      wait: { waitKind: 'human_clarification', slotPolicy: 'release' },
    });
    expect(plan).toMatchObject({
      status: 'needs_clarification',
      attempt: 2,
      decision: {
        questions: [expect.objectContaining({ id: 'component-boundary' })],
      },
    });
    expect(tasks.tasks.find((task) => task.id === fixtureId)).toMatchObject({
      status: 'waiting',
      attention: 'operator',
      currentStage: 'Waiting for human clarification',
    });

    await api.close();
  });

  it('continues the same parent run after answering a continuation revision question', async () => {
    const { api } = setup(
      false,
      undefined,
      makeWorkflowChangeThenReadyPlanner({ clarifyRevision: true }),
    );
    const fixtureId = 'avia-13236-short-bug';
    await api.inject({ method: 'POST', url: `/api/workflows/${fixtureId}/generate` });
    await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/start`,
      payload: { settings: { planApproval: 'automatic', planningStrategy: 'fast' } },
    });
    const before = WorkflowContinuationRecordSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/continuation` })).json(),
    );
    await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/continuation/review`,
      payload: {
        decision: 'reject',
        continuationId: before.continuationId,
        guidance: 'Confirm the repository boundary first.',
      },
    });

    const response = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/planning-clarification`,
      payload: {
        answers: [
          { questionId: 'component-boundary', answer: 'Keep it in the parent repository.' },
        ],
      },
    });

    const continuation = WorkflowContinuationRecordSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/continuation` })).json(),
    );
    expect(response.statusCode).toBe(200);
    expect(RunProjectionSchema.parse(response.json())).toMatchObject({
      runId: `run:${fixtureId}`,
      status: 'waiting',
      implementationPlan: { attempt: 3 },
      wait: { waitKind: 'code_review@1' },
    });
    expect(continuation).toMatchObject({
      status: 'superseded_by_plan',
      implementationPlanArtifactId: `implementation-plan:${fixtureId}:attempt-3`,
    });

    await api.close();
  });

  it('keeps an invalid continuation blocked instead of executing an unmet capability', async () => {
    const { api } = setup(false, undefined, makeWorkflowChangePlanner(['package.publish']));
    const fixtureId = 'avia-13236-short-bug';
    await api.inject({ method: 'POST', url: `/api/workflows/${fixtureId}/generate` });

    const response = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/start`,
      payload: { settings: { planApproval: 'automatic', planningStrategy: 'fast' } },
    });

    const continuation = WorkflowContinuationRecordSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/continuation` })).json(),
    );
    expect(response.statusCode).toBe(200);
    expect(continuation).toMatchObject({
      status: 'invalid',
      issues: [expect.objectContaining({ code: 'capability_not_represented', retryable: false })],
    });
    expect(response.json()).toMatchObject({
      status: 'waiting',
      wait: { waitKind: 'workflow_continuation_review', slotPolicy: 'release' },
    });

    await api.close();
  });

  it('retries a transient repository failure without restarting the parent run', async () => {
    const repositoryCatalog = makeRepositoryCatalog();
    let resolutions = 0;
    const flakyCatalog: RepositoryCatalog = {
      list: () => repositoryCatalog.list(),
      find: (reference) => repositoryCatalog.find(reference),
      resolve: async (reference) => {
        resolutions += 1;
        return resolutions === 1
          ? {
              status: 'unavailable' as const,
              problem: {
                kind: 'access_blocked' as const,
                message: 'Bitbucket returned 403 while VPN was disconnected.',
                retryable: true,
                httpStatus: 403,
              },
            }
          : repositoryCatalog.resolve(reference);
      },
    };
    const { api } = setup(
      false,
      undefined,
      makeWorkflowChangePlanner(['repository.read']),
      flakyCatalog,
    );
    const fixtureId = 'avia-13236-short-bug';
    await api.inject({ method: 'POST', url: `/api/workflows/${fixtureId}/generate` });
    const started = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/start`,
      payload: { settings: { planApproval: 'automatic', planningStrategy: 'fast' } },
    });
    const blocked = WorkflowContinuationRecordSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/continuation` })).json(),
    );
    if (blocked.status !== 'blocked') throw new Error('Expected a retryable repository block');

    const response = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/continuation/retry`,
    });

    const retried = WorkflowContinuationRecordSchema.parse(response.json());
    const run = RunProjectionSchema.parse(
      (await api.inject({ method: 'GET', url: `/api/workflows/${fixtureId}/run` })).json(),
    );
    expect(response.statusCode).toBe(200);
    expect(blocked).toMatchObject({
      attempt: 1,
      parent: { runId: `run:${fixtureId}` },
      issues: [expect.objectContaining({ code: 'repository_unavailable', retryable: true })],
    });
    expect(retried).toMatchObject({
      status: 'awaiting_review',
      attempt: 2,
      parent: { runId: `run:${fixtureId}` },
    });
    expect(run).toMatchObject({
      runId: `run:${fixtureId}`,
      status: 'waiting',
      wait: { waitKind: 'workflow_continuation_review', slotPolicy: 'release' },
    });
    expect(RunProjectionSchema.parse(started.json()).runId).toBe(run.runId);

    await api.close();
  });

  it('keeps the run at its durable clarification wait when an answer set is incomplete', async () => {
    const questioning = makeQuestioningPlanner();
    const { api } = setup(false, undefined, questioning.planner);
    const fixtureId = 'avia-13236-short-bug';
    await api.inject({ method: 'POST', url: `/api/workflows/${fixtureId}/generate` });
    const started = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/start`,
      payload: { settings: { planApproval: 'automatic', planningStrategy: 'fast' } },
    });
    if (started.statusCode !== 200) throw new Error('Expected a planning clarification wait');

    const response = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/planning-clarification`,
      payload: { answers: [{ questionId: 'target-browser', answer: 'Chrome' }] },
    });
    const persistedRun = await api.inject({
      method: 'GET',
      url: `/api/workflows/${fixtureId}/run`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_clarification_answers' });
    expect(persistedRun.json()).toMatchObject({
      runId: `run:${fixtureId}`,
      status: 'waiting',
      wait: { waitKind: 'human_clarification', slotPolicy: 'release' },
      lease: null,
      effects: [],
    });

    await api.close();
  });

  it('persists exact clarification answers and continues the same run with the revised plan', async () => {
    const questioning = makeQuestioningPlanner();
    const { api, ledger } = setup(false, undefined, questioning.planner);
    const fixtureId = 'avia-13236-short-bug';
    await api.inject({ method: 'POST', url: `/api/workflows/${fixtureId}/generate` });
    const started = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/start`,
      payload: { settings: { planApproval: 'automatic', planningStrategy: 'fast' } },
    });
    if (started.statusCode !== 200) throw new Error('Expected a planning clarification wait');
    const runId = RunProjectionSchema.parse(started.json()).runId;

    const response = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/planning-clarification`,
      payload: {
        answers: [
          { questionId: 'change-scope', answer: 'Keep the fix in this repository.' },
          { questionId: 'target-browser', answer: 'Chrome and Safari.' },
        ],
      },
    });
    const continued = RunProjectionSchema.parse(response.json());
    const planResponse = await api.inject({
      method: 'GET',
      url: `/api/workflows/${fixtureId}/implementation-plan`,
    });
    const plan = ImplementationPlanningRecordSchema.parse(planResponse.json());
    const activityResponse = await api.inject({
      method: 'GET',
      url: `/api/operator/tasks/${fixtureId}/activity`,
    });
    const activity = OperatorActivityResponseSchema.parse(activityResponse.json());

    expect(response.statusCode).toBe(200);
    expect(continued).toMatchObject({
      runId,
      status: 'waiting',
      implementationPlan: { attempt: 2, selectedStrategy: 'fast' },
      wait: { waitKind: 'code_review@1' },
    });
    expect(plan).toMatchObject({ status: 'ready', attempt: 2 });
    expect(plan.operatorGuidance).toContain('Answer: Chrome and Safari.');
    expect(questioning.requests[1]?.context.operatorGuidance).toContain(
      'Answer: Keep the fix in this repository.',
    );
    expect(ledger.repository.readArtifact(`planning-answers:${fixtureId}:attempt-1`)).toMatchObject(
      {
        artifactKind: 'planning_clarification_answers',
        payload: {
          answers: [
            { questionId: 'target-browser', answer: 'Chrome and Safari.' },
            { questionId: 'change-scope', answer: 'Keep the fix in this repository.' },
          ],
        },
      },
    );
    expect(activity.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Waiting for planning clarification' }),
        expect.objectContaining({ title: 'Planning clarification answered' }),
        expect.objectContaining({ title: 'Planning clarification resolved' }),
      ]),
    );

    await api.close();
  });

  it('returns a clarified plan revision to human review in the same run', async () => {
    const { api } = setup(false, undefined, makeRevisionQuestioningPlanner());
    const fixtureId = 'avia-12536-feature-review';
    await api.inject({ method: 'POST', url: `/api/workflows/${fixtureId}/generate` });
    const started = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/start`,
      payload: { settings: { planApproval: 'required', planningStrategy: 'fast' } },
    });
    if (started.statusCode !== 200) throw new Error('Expected the initial plan review wait');
    const runId = RunProjectionSchema.parse(started.json()).runId;
    const requestedChanges = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/plan-review`,
      payload: {
        decision: 'request_changes',
        guidance: 'Add an explicit rollback decision.',
      },
    });
    if (requestedChanges.statusCode !== 200) {
      throw new Error('Expected a clarification wait for the revised plan');
    }

    const response = await api.inject({
      method: 'POST',
      url: `/api/workflows/${fixtureId}/planning-clarification`,
      payload: {
        answers: [{ questionId: 'rollback-owner', answer: 'The operator owns it.' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      runId,
      status: 'waiting',
      implementationPlan: { attempt: 3 },
      wait: { waitKind: 'plan.approved@1' },
      planRevisionRequests: [{ priorAttempt: 1, nextAttempt: 2 }],
    });

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
