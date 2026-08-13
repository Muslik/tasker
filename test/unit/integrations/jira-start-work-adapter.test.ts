import { afterEach, describe, expect, it } from 'vitest';

import { loadHarnessPack } from '../../../src/harness/index.js';
import {
  ExternalEffectStore,
  JiraStartWorkAdapter,
  type JiraLifecycleIssue,
  type JiraLifecycleMutation,
  type JiraLifecycleObservation,
  type JiraLifecyclePort,
  type JiraLifecycleTransitionField,
  type JiraCommentObservation,
  type JiraFieldValueObservation,
  type JiraTransitionObservation,
} from '../../../src/integrations/index.js';
import type { IntegrationStepExecutionRequest } from '../../../src/integrations/execution.js';
import { openSqliteLedger, type SqliteLedger } from '../../../src/ledger/index.js';
import { systemClock } from '../../../src/shared/clock.js';
import { makePlanningTaskSnapshot } from '../../support/planning.js';

const task = makePlanningTaskSnapshot('avia-12536-feature-review', {
  origin: 'jira',
  reference: 'jira:AVIA-12536',
});
const jiraPolicy = loadHarnessPack().policies.find(({ id }) => id === 'jira-lifecycle');
if (jiraPolicy === undefined) throw new Error('Missing Jira lifecycle policy');

const requestFor = (operationId: string): IntegrationStepExecutionRequest => ({
  operationId,
  stepReference: 'jira.start-work@1',
  taskReference: task.reference,
  task,
  taskSnapshot: {
    origin: 'jira',
    issue: { issueKey: task.taskId },
  },
  stepInput: { objective: task.title, repository: task.repository, taskId: task.taskId },
  workspace: {
    schemaVersion: 1,
    workspaceId: 'a'.repeat(24),
    taskReference: task.reference,
    workflowId: `tasker:${task.reference}`,
    workflowRunId: 'run-1',
    repository: {
      reference: task.repository,
      sourcePath: '/repositories/front-avia',
      baseCommit: 'c'.repeat(40),
    },
    runnerId: 'test',
    path: '/worktrees/front-avia',
    branch: 'tasker/avia-12536/run-1',
    preparedAt: '2026-08-04T00:00:00.000Z',
  },
  operatorGuidance: null,
  evidence: { acceptedPlan: null, completedSteps: [], reviewInputs: [] },
  policies: [jiraPolicy],
  project: null,
  runtime: {
    attempt: 1,
    cancellationSignal: new AbortController().signal,
    heartbeat: () => {},
  },
});

class StatefulJiraLifecyclePort implements JiraLifecyclePort {
  public issue: JiraLifecycleIssue = {
    issueKey: 'AVIA-12536',
    issueType: 'Task',
    status: 'Backlog',
    labels: [],
    assignee: null,
  };
  public readonly assignmentCalls: string[] = [];
  public readonly transitionCalls: string[] = [];
  public readonly fieldObservationCalls: string[][] = [];
  public fieldValues: Record<string, null | number | string> = {};
  public startWorkTransitionFields: readonly JiraLifecycleTransitionField[] = [];
  public mode: 'normal' | 'forbidden' | 'invalid-at-open' | 'lose-transition-response' = 'normal';

  public observeIssue(): Promise<JiraLifecycleObservation> {
    return Promise.resolve({ status: 'observed', issue: this.issue });
  }

  public listTransitions(): Promise<JiraTransitionObservation> {
    const transitions =
      this.issue.status === 'Backlog'
        ? [{ id: '511', name: 'Take from backlog', toStatus: 'Open', fields: [] }]
        : this.issue.status === 'Open'
          ? [
              {
                id: '11',
                name: 'Start work',
                toStatus: 'In Progress',
                fields: this.startWorkTransitionFields,
              },
            ]
          : [];
    return Promise.resolve({ status: 'observed', transitions });
  }

  public observeFieldValues(
    _issueKey: string,
    fieldIds: readonly string[],
  ): Promise<JiraFieldValueObservation> {
    this.fieldObservationCalls.push([...fieldIds]);
    return Promise.resolve({ status: 'observed', values: this.fieldValues });
  }

  public listComments(): Promise<JiraCommentObservation> {
    return Promise.resolve({ status: 'observed', comments: [] });
  }

  public assign(_issueKey: string, accountName: string): Promise<JiraLifecycleMutation> {
    this.assignmentCalls.push(accountName);
    this.issue = {
      ...this.issue,
      assignee: { accountName, displayName: 'Dzhabrail Markhiev' },
    };
    return Promise.resolve({ status: 'accepted' });
  }

  public transition(_issueKey: string, transitionId: string): Promise<JiraLifecycleMutation> {
    this.transitionCalls.push(transitionId);
    if (this.mode === 'forbidden') {
      return Promise.resolve({
        status: 'failed',
        problem: {
          kind: 'access_blocked',
          message: 'Jira returned 403. VPN required',
          retryable: true,
          httpStatus: 403,
        },
      });
    }
    if (this.mode === 'invalid-at-open' && this.issue.status === 'Open') {
      return Promise.resolve({
        status: 'failed',
        problem: {
          kind: 'invalid_request',
          message: 'Jira rejected the lifecycle mutation',
          reasons: [],
          retryable: false,
          httpStatus: 400,
        },
      });
    }
    this.issue = {
      ...this.issue,
      status: transitionId === '511' ? 'Open' : 'In Progress',
    };
    return Promise.resolve(
      this.mode === 'lose-transition-response'
        ? {
            status: 'failed',
            problem: {
              kind: 'unavailable',
              message: 'response lost after request',
              retryable: true,
            },
          }
        : { status: 'accepted' },
    );
  }

  public comment(): Promise<JiraLifecycleMutation> {
    return Promise.resolve({ status: 'accepted' });
  }

  public updateComment(): Promise<JiraLifecycleMutation> {
    return Promise.resolve({ status: 'accepted' });
  }
}

let ledger: SqliteLedger | undefined;

afterEach(() => {
  ledger?.close();
  ledger = undefined;
});

const adapterFor = (jira: JiraLifecyclePort): JiraStartWorkAdapter => {
  ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
  return new JiraStartWorkAdapter(jira, new ExternalEffectStore(ledger.repository, systemClock));
};

describe('Jira start-work effect adapter', () => {
  it('pauses on missing transition prerequisites and continues without repeating prior work', async () => {
    const jira = new StatefulJiraLifecyclePort();
    jira.startWorkTransitionFields = [
      {
        id: 'customfield_12345',
        name: 'Development estimate',
        required: true,
        hasDefaultValue: false,
        operations: ['set'],
      },
    ];
    const adapter = adapterFor(jira);

    const blocked = await adapter.execute(requestFor('workflow:jira:attempt-1'));

    expect(blocked).toMatchObject({
      status: 'blocked',
      kind: 'invalid_request',
      summary: 'Jira requires fields before Start work can run: Development estimate',
      details: {
        issueKey: 'AVIA-12536',
        transitionId: '11',
        transitionName: 'Start work',
        toStatus: 'In Progress',
        missingFields: [{ id: 'customfield_12345', name: 'Development estimate' }],
      },
    });
    expect(jira.issue.status).toBe('Open');
    expect(jira.assignmentCalls).toHaveLength(1);
    expect(jira.transitionCalls).toEqual(['511']);

    jira.fieldValues.customfield_12345 = 2;
    const resumed = await adapter.execute(requestFor('workflow:jira:attempt-2'));

    expect(resumed).toMatchObject({ status: 'completed' });
    expect(jira.assignmentCalls).toHaveLength(1);
    expect(jira.transitionCalls).toEqual(['511', '11']);
  });

  it('assigns an eligible issue and follows the configured status path', async () => {
    const jira = new StatefulJiraLifecyclePort();

    const result = await adapterFor(jira).execute(requestFor('workflow:jira:attempt-1'));

    expect(result).toMatchObject({
      status: 'completed',
      output: { externalId: 'AVIA-12536', status: 'In Progress' },
    });
    expect(jira.assignmentCalls).toEqual(['dzhabrail.markhiev@onetwotrip.com']);
    expect(jira.transitionCalls).toEqual(['511', '11']);
  });

  it('reconciles a successful transition whose response was lost', async () => {
    const jira = new StatefulJiraLifecyclePort();
    jira.issue = {
      ...jira.issue,
      status: 'Open',
      assignee: {
        accountName: 'dzhabrail.markhiev@onetwotrip.com',
        displayName: 'Dzhabrail Markhiev',
      },
    };
    jira.mode = 'lose-transition-response';
    const adapter = adapterFor(jira);
    const request = requestFor('workflow:jira:attempt-1');

    const first = await adapter.execute(request);
    const redelivered = await adapter.execute(request);

    expect(first).toMatchObject({ status: 'completed' });
    expect(redelivered).toMatchObject({ status: 'completed' });
    expect(jira.transitionCalls).toEqual(['11']);
  });

  it('classifies Jira 400 as an admission error and preserves the completed first transition', async () => {
    const jira = new StatefulJiraLifecyclePort();
    jira.mode = 'invalid-at-open';
    const adapter = adapterFor(jira);

    const blocked = await adapter.execute(requestFor('workflow:jira:attempt-1'));
    jira.mode = 'normal';
    const resumed = await adapter.execute(requestFor('workflow:jira:attempt-2'));

    expect(blocked).toMatchObject({ status: 'blocked', kind: 'invalid_request' });
    expect(resumed).toMatchObject({ status: 'completed' });
    expect(jira.assignmentCalls).toHaveLength(1);
    expect(jira.transitionCalls).toEqual(['511', '11', '11']);
  });

  it('pauses on Jira 403 and resumes without assigning the issue twice', async () => {
    const jira = new StatefulJiraLifecyclePort();
    jira.mode = 'forbidden';
    const adapter = adapterFor(jira);
    const request = requestFor('workflow:jira:attempt-1');

    const blocked = await adapter.execute(request);
    jira.mode = 'normal';
    const resumed = await adapter.execute(request);

    expect(blocked).toMatchObject({ status: 'blocked', kind: 'infrastructure' });
    expect(resumed).toMatchObject({ status: 'completed' });
    expect(jira.assignmentCalls).toHaveLength(1);
  });

  it('refuses a task assigned to another person before any Jira mutation', async () => {
    const jira = new StatefulJiraLifecyclePort();
    jira.issue = {
      ...jira.issue,
      assignee: { accountName: 'another.user', displayName: 'Another User' },
    };

    const result = await adapterFor(jira).execute(requestFor('workflow:jira:attempt-1'));

    expect(result).toMatchObject({ status: 'blocked', kind: 'invalid_request' });
    expect(jira.assignmentCalls).toEqual([]);
    expect(jira.transitionCalls).toEqual([]);
  });

  it('refuses an ineligible Jira status before assigning an unowned issue', async () => {
    const jira = new StatefulJiraLifecyclePort();
    jira.issue = { ...jira.issue, status: 'In Release' };

    const result = await adapterFor(jira).execute(requestFor('workflow:jira:attempt-1'));

    expect(result).toMatchObject({ status: 'blocked', kind: 'invalid_request' });
    expect(jira.assignmentCalls).toEqual([]);
  });
});
