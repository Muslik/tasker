import { afterEach, describe, expect, it } from 'vitest';

import { loadHarnessPack } from '../../harness/index.js';
import type { Outcome } from '../../shared/outcome.js';
import { openSqliteLedger, type SqliteLedger } from '../../store/index.js';
import { systemClock } from '../../shared/clock.js';
import { makePlanningTaskSnapshot } from '../../../test/support/planning.js';
import type { IntegrationStepExecutionRequest } from '../execution.js';
import { ExternalEffectStore } from '../effects.js';
import type { ConfluenceContentPort, ConfluencePage, ConfluencePublishProblem } from './client.js';
import { ConfluenceResearchPublishAdapter } from './publish-adapter.js';

const task = makePlanningTaskSnapshot('avia-14001-translation-component', {
  origin: 'jira',
  reference: 'jira:AVIA-14001',
  title: 'Research page title',
});

const requestFor = (
  operationId: string,
  draftBody = '<p>latest draft</p>',
): IntegrationStepExecutionRequest => ({
  operationId,
  nodeId: 'publish-research',
  stepReference: 'research.publish@1',
  taskReference: task.reference,
  task,
  taskSnapshot: { origin: 'jira', issue: { issueKey: task.taskId } },
  stepInput: {
    objective: task.title,
    repository: task.repository,
    taskId: task.taskId,
    questions: ['What must the system analysis establish?'],
    product: {
      id: 'avia',
      title: 'Авиа',
      jiraProjects: ['AVIA'],
      confluence: {
        researchRootPageId: '42',
        spaceKey: 'RND',
      },
      repositories: {
        primary: 'front-avia',
        linked: ['front-components'],
      },
    },
    repositoryReference: task.repository,
  },
  workspace: {
    schemaVersion: 1,
    workspaceId: 'a'.repeat(24),
    taskReference: task.reference,
    workflowId: `tasker:${task.reference}`,
    workflowRunId: 'run-1',
    repository: {
      reference: task.repository,
      sourcePath: '/workspace/front-avia',
      baseBranch: 'master',
      baseCommit: 'c'.repeat(40),
    },
    runnerId: 'test',
    path: '/worktrees/front-avia',
    branch: 'tasker/avia-14001/run-1',
    preparedAt: '2026-08-30T00:00:00.000Z',
  },
  operatorGuidance: null,
  waitResolution: null,
  evidence: {
    acceptedPlan: null,
    completedSteps: [
      {
        operationId: 'workflow:research:attempt-1',
        nodeId: 'research-draft',
        stepReference: 'research.draft@1',
        status: 'completed',
        summary: 'Research document ready',
        artifactIds: ['research-draft:1'],
        predicateFacts: {},
        details: { output: { documentStorageHtml: '<p>older draft</p>' } },
        recordedAt: '2026-08-30T00:10:00.000Z',
      },
      {
        operationId: 'workflow:research:attempt-2',
        nodeId: 'research-draft',
        stepReference: 'research.draft@1',
        status: 'completed',
        summary: 'Research document updated',
        artifactIds: ['research-draft:2'],
        predicateFacts: {},
        details: { output: { documentStorageHtml: draftBody } },
        recordedAt: '2026-08-30T00:20:00.000Z',
      },
    ],
    reviewInputs: [],
  },
  policies: loadHarnessPack().policies,
  project: null,
  trackerStatusUpdates: 'enabled',
  runtime: {
    attempt: 1,
    cancellationSignal: new AbortController().signal,
    heartbeat: () => {},
  },
});

class FakeConfluencePort implements ConfluenceContentPort {
  public rootPage: ConfluencePage = {
    pageId: '42',
    title: 'Research root',
    version: 1,
    spaceKey: 'RND',
    bodyStorage: '<p>root</p>',
    pageUrl: 'https://confluence.example/pages/viewpage.action?pageId=42',
  };
  public childPages: ConfluencePage[] = [];
  public createCalls = 0;
  public updateCalls = 0;
  public fetchCalls = 0;
  public failCreate: ConfluencePublishProblem | null = null;

  public fetchPage(): Promise<Outcome<ConfluencePage, ConfluencePublishProblem>> {
    this.fetchCalls += 1;
    return Promise.resolve({ ok: true, value: this.rootPage });
  }

  public findExactChildPages(
    _parentPageId: string,
    title: string,
  ): Promise<Outcome<readonly ConfluencePage[], ConfluencePublishProblem>> {
    return Promise.resolve({
      ok: true,
      value: this.childPages.filter((page) => page.title === title),
    });
  }

  public createPage(input: {
    readonly parentPageId: string;
    readonly title: string;
    readonly bodyStorage: string;
    readonly spaceKey: string;
  }): Promise<Outcome<ConfluencePage, ConfluencePublishProblem>> {
    this.createCalls += 1;
    if (this.failCreate !== null) return Promise.resolve({ ok: false, error: this.failCreate });
    const page: ConfluencePage = {
      pageId: '301',
      title: input.title,
      version: 1,
      spaceKey: input.spaceKey,
      bodyStorage: input.bodyStorage,
      pageUrl: 'https://confluence.example/pages/viewpage.action?pageId=301',
    };
    this.childPages.push(page);
    return Promise.resolve({ ok: true, value: page });
  }

  public updatePage(input: {
    readonly pageId: string;
    readonly title: string;
    readonly bodyStorage: string;
    readonly spaceKey: string;
    readonly version: number;
  }): Promise<Outcome<ConfluencePage, ConfluencePublishProblem>> {
    this.updateCalls += 1;
    const index = this.childPages.findIndex((page) => page.pageId === input.pageId);
    if (index < 0) {
      return Promise.resolve({
        ok: false,
        error: {
          kind: 'not_found',
          message: 'missing',
          retryable: false,
          httpStatus: 404,
        },
      });
    }
    const page: ConfluencePage = {
      pageId: input.pageId,
      title: input.title,
      version: input.version + 1,
      spaceKey: input.spaceKey,
      bodyStorage: input.bodyStorage,
      pageUrl: `https://confluence.example/pages/viewpage.action?pageId=${input.pageId}`,
    };
    this.childPages[index] = page;
    return Promise.resolve({ ok: true, value: page });
  }
}

describe('Confluence research publish adapter', () => {
  let ledger: SqliteLedger | null = null;

  afterEach(() => {
    ledger?.close();
    ledger = null;
  });

  const adapterFor = (confluence: FakeConfluencePort) => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    return new ConfluenceResearchPublishAdapter(
      confluence,
      new ExternalEffectStore(ledger.repository, systemClock),
    );
  };

  it('creates a new research page when none exists', async () => {
    const confluence = new FakeConfluencePort();
    const adapter = adapterFor(confluence);

    const result = await adapter.execute(requestFor('tasker:test:publish:create'));

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        pageId: '301',
        pageUrl: 'https://confluence.example/pages/viewpage.action?pageId=301',
      },
    });
    expect(confluence.fetchCalls).toBe(0);
    expect(confluence.createCalls).toBe(1);
    expect(confluence.updateCalls).toBe(0);
  });

  it('updates an existing exact-title child page', async () => {
    const confluence = new FakeConfluencePort();
    confluence.childPages = [
      {
        pageId: '301',
        title: task.title,
        version: 3,
        spaceKey: 'RND',
        bodyStorage: '<p>stale</p>',
        pageUrl: 'https://confluence.example/pages/viewpage.action?pageId=301',
      },
    ];
    const adapter = adapterFor(confluence);

    const result = await adapter.execute(requestFor('tasker:test:publish:update', '<p>fresh</p>'));

    expect(result).toMatchObject({
      status: 'completed',
      output: { pageId: '301' },
    });
    expect(confluence.createCalls).toBe(0);
    expect(confluence.updateCalls).toBe(1);
    expect(confluence.childPages[0]?.bodyStorage).toBe('<p>fresh</p>');
  });

  it('fails closed when multiple exact-title child pages already exist', async () => {
    const confluence = new FakeConfluencePort();
    confluence.childPages = [
      {
        pageId: '301',
        title: task.title,
        version: 1,
        spaceKey: 'RND',
        bodyStorage: '<p>a</p>',
        pageUrl: 'https://confluence.example/pages/viewpage.action?pageId=301',
      },
      {
        pageId: '302',
        title: task.title,
        version: 1,
        spaceKey: 'RND',
        bodyStorage: '<p>b</p>',
        pageUrl: 'https://confluence.example/pages/viewpage.action?pageId=302',
      },
    ];
    const adapter = adapterFor(confluence);

    const result = await adapter.execute(requestFor('tasker:test:publish:duplicate'));

    expect(result).toMatchObject({
      status: 'blocked',
      kind: 'remote_conflict',
      details: { pageIds: ['301', '302'] },
    });
    expect(confluence.createCalls).toBe(0);
    expect(confluence.updateCalls).toBe(0);
  });

  it('reuses the persisted receipt without a second remote write', async () => {
    const confluence = new FakeConfluencePort();
    const adapter = adapterFor(confluence);
    const request = requestFor('tasker:test:publish:receipt');

    const first = await adapter.execute(request);
    const second = await adapter.execute(request);

    expect(first).toMatchObject({ status: 'completed', output: { pageId: '301' } });
    expect(second).toMatchObject({ status: 'completed', output: { pageId: '301' } });
    expect(confluence.createCalls).toBe(1);
    expect(confluence.updateCalls).toBe(0);
  });
});
