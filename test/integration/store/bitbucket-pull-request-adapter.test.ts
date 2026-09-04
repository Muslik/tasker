import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getHarnessPack } from '../../../src/harness/index.js';
import {
  BitbucketPullRequestAdapter,
  type BitbucketPullRequest,
  type BitbucketPullRequestCreation,
  type BitbucketPullRequestLookup,
  type BitbucketPullRequestPort,
  ExternalEffectStore,
  type GitCommitIdentity,
  loadGitCommitIdentity,
} from '../../../src/integrations/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../../src/store/index.js';
import { nodeCommandRunner, type WorkspaceCommandRunner } from '../../../src/agents/index.js';
import { systemClock } from '../../../src/shared/clock.js';
import type { IntegrationStepExecutionRequest } from '../../../src/integrations/execution.js';
import { makePlanningTaskSnapshot } from '../../support/planning.js';

const task = makePlanningTaskSnapshot('avia-13236-short-bug');
const pullRequestDraft = {
  title: `${task.taskId}: ${task.title}`,
  description: task.description,
  commit: { kind: 'subject' as const, subject: task.title },
  branchArtifacts: ['feature.ts'],
};
const project = getHarnessPack().projects.find(
  (candidate) => candidate.repository === task.repository,
);
if (project === undefined) throw new Error(`Missing harness project ${task.repository}`);
const testProject = { ...project, git: { ...project.git, baseBranch: 'main' } };

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const pullRequest = (sourceRef: string): BitbucketPullRequest => ({
  id: 73,
  version: 0,
  state: 'OPEN',
  title: `${task.taskId}: ${task.title}`,
  sourceRef,
  targetRef: 'refs/heads/main',
  url: 'https://bitbucket.example/projects/ONETWOTRIP/repos/front-avia/pull-requests/73',
});

class StatefulPullRequestPort implements BitbucketPullRequestPort {
  public value: BitbucketPullRequest | null = null;
  public createCalls = 0;
  public loseCreateResponse = false;

  public findOpen(): Promise<BitbucketPullRequestLookup> {
    return Promise.resolve(
      this.value === null ? { status: 'not_found' } : { status: 'found', pullRequest: this.value },
    );
  }

  public create(input: { readonly sourceRef: string }): Promise<BitbucketPullRequestCreation> {
    this.createCalls += 1;
    this.value = pullRequest(input.sourceRef);
    return Promise.resolve(
      this.loseCreateResponse
        ? {
            status: 'failed',
            problem: {
              kind: 'unavailable',
              message: 'response lost after request',
              retryable: true,
            },
          }
        : { status: 'created', pullRequest: this.value },
    );
  }
}

const roots: string[] = [];
let ledger: SqliteLedger | undefined;

afterEach(() => {
  ledger?.close();
  ledger = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const createGitWorkspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'tasker-bitbucket-effect-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const workspace = join(root, 'workspace');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote]);
  execFileSync('git', ['clone', remote, workspace]);
  git(workspace, ['config', 'user.name', 'Tasker test']);
  git(workspace, ['config', 'user.email', 'tasker-test@localhost']);
  writeFileSync(join(workspace, 'feature.ts'), 'export const value = 1;\n', 'utf8');
  git(workspace, ['add', 'feature.ts']);
  git(workspace, ['commit', '-m', 'initial']);
  git(workspace, ['push', '-u', 'origin', 'main']);
  git(workspace, ['remote', 'set-head', 'origin', 'main']);
  const baseCommit = git(workspace, ['rev-parse', 'HEAD']);
  const branch = 'tasker/avia-13236/run-1';
  git(workspace, ['checkout', '-b', branch]);
  writeFileSync(join(workspace, 'feature.ts'), 'export const value = 2;\n', 'utf8');
  mkdirSync(join(workspace, '.tasker/pull-request'), { recursive: true });
  writeFileSync(
    join(workspace, '.tasker/pull-request/draft.json'),
    `${JSON.stringify({
      ...pullRequestDraft,
    })}\n`,
    'utf8',
  );
  writeFileSync(join(workspace, '.git/info/exclude'), '/.tasker/\n', 'utf8');
  return { remote, workspace, baseCommit, branch };
};

const configuration = {
  baseUrl: 'https://bitbucket.example',
  token: 'test-token',
  requestTimeoutMs: 1_000,
};

const commitIdentity = {
  name: 'Tasker Adapter',
  email: 'tasker-adapter@example.test',
} satisfies GitCommitIdentity;

const workspaceCommandRunner: WorkspaceCommandRunner = {
  executionEnvironment: 'docker_workspace',
  run: (request) => nodeCommandRunner.run(request),
};

const requestFor = (
  workspace: ReturnType<typeof createGitWorkspace>,
  operationId: string,
): IntegrationStepExecutionRequest => ({
  operationId,
  nodeId: 'deliver-change',
  stepReference: 'pr.prepare@1',
  taskReference: task.reference,
  task,
  taskSnapshot: task,
  stepInput: {
    objective: task.title,
    repository: task.repository,
    taskId: task.taskId,
    draftPath: '.tasker/pull-request/draft.json',
  },
  workspace: {
    schemaVersion: 1,
    workspaceId: 'a'.repeat(24),
    taskReference: task.reference,
    workflowId: `tasker:${task.reference}`,
    workflowRunId: 'run-1',
    repository: {
      reference: task.repository,
      sourcePath: workspace.workspace,
      baseBranch: 'main',
      baseCommit: workspace.baseCommit,
    },
    runnerId: 'test',
    path: workspace.workspace,
    branch: workspace.branch,
    preparedAt: '2026-08-04T00:00:00.000Z',
  },
  operatorGuidance: null,
  waitResolution: null,
  evidence: { acceptedPlan: null, completedSteps: [], reviewInputs: [] },
  policies: [],
  project: testProject,
  trackerStatusUpdates: 'enabled',
  runtime: {
    attempt: 1,
    cancellationSignal: new AbortController().signal,
    heartbeat: () => {},
  },
});

const adapterFor = (commands: WorkspaceCommandRunner, pullRequests: BitbucketPullRequestPort) => {
  ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
  return new BitbucketPullRequestAdapter(
    configuration,
    commitIdentity,
    commands,
    pullRequests,
    new ExternalEffectStore(ledger.repository, systemClock),
  );
};

describe('Bitbucket pull request effect adapter', () => {
  it('loads an explicit commit identity from the environment or harness defaults', () => {
    const root = mkdtempSync(join(tmpdir(), 'tasker-git-identity-'));
    roots.push(root);
    writeFileSync(
      join(root, '.env'),
      'TASKER_GIT_AUTHOR_NAME=Harness Author\nTASKER_GIT_AUTHOR_EMAIL=harness@example.test\n',
      'utf8',
    );

    expect(loadGitCommitIdentity({ TASKER_HARNESS_WORK_PATH: root })).toEqual({
      name: 'Harness Author',
      email: 'harness@example.test',
    });
    expect(
      loadGitCommitIdentity({
        TASKER_HARNESS_WORK_PATH: root,
        TASKER_GIT_AUTHOR_NAME: 'Runtime Author',
        TASKER_GIT_AUTHOR_EMAIL: 'runtime@example.test',
      }),
    ).toEqual({ name: 'Runtime Author', email: 'runtime@example.test' });
  });

  it('blocks before staging when a task change needs a missing commit identity', async () => {
    const workspace = createGitWorkspace();
    const pullRequests = new StatefulPullRequestPort();
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const adapter = new BitbucketPullRequestAdapter(
      configuration,
      null,
      workspaceCommandRunner,
      pullRequests,
      new ExternalEffectStore(ledger.repository, systemClock),
    );

    const result = await adapter.executeDraft(
      requestFor(workspace, 'workflow:prepare-pr:attempt-1'),
      pullRequestDraft,
    );

    expect(result).toMatchObject({
      status: 'blocked',
      kind: 'configuration',
      details: {
        requiredEnvironment: ['TASKER_GIT_AUTHOR_NAME', 'TASKER_GIT_AUTHOR_EMAIL'],
      },
    });
    expect(git(workspace.workspace, ['diff', '--cached', '--name-only'])).toBe('');
    expect(git(workspace.workspace, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(pullRequests.createCalls).toBe(0);
  });

  it('commits with the configured identity instead of repository-local defaults', async () => {
    const workspace = createGitWorkspace();
    const pullRequests = new StatefulPullRequestPort();
    const adapter = adapterFor(workspaceCommandRunner, pullRequests);

    const result = await adapter.executeDraft(
      requestFor(workspace, 'workflow:prepare-pr:attempt-1'),
      pullRequestDraft,
    );

    expect(result).toMatchObject({ status: 'completed' });
    expect(git(workspace.workspace, ['show', '-s', '--format=%an <%ae>|%cn <%ce>', 'HEAD'])).toBe(
      'Tasker Adapter <tasker-adapter@example.test>|Tasker Adapter <tasker-adapter@example.test>',
    );
    expect(git(workspace.workspace, ['show', '-s', '--format=%s', 'HEAD'])).toBe(
      `${task.taskId}: ${task.title}`,
    );
  });

  it('uses Tasker validation instead of repository hooks during reconciled delivery', async () => {
    const workspace = createGitWorkspace();
    const hook = join(workspace.workspace, '.git/hooks/commit-msg');
    const marker = join(workspace.workspace, 'hook-ran');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, 'utf8');
    chmodSync(hook, 0o755);
    const pullRequests = new StatefulPullRequestPort();
    const adapter = adapterFor(workspaceCommandRunner, pullRequests);

    const result = await adapter.executeDraft(
      requestFor(workspace, 'workflow:prepare-pr:attempt-1'),
      pullRequestDraft,
    );

    expect(result).toMatchObject({ status: 'completed' });
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses remote publication when a declared branch artifact is not committed', async () => {
    const workspace = createGitWorkspace();
    writeFileSync(
      join(workspace.workspace, '.tasker/pull-request/draft.json'),
      `${JSON.stringify({
        title: `${task.taskId}: ${task.title}`,
        description: task.description,
        commit: { kind: 'subject', subject: task.title },
        branchArtifacts: ['.ai/workspace/AVIA-13236/verification.md'],
      })}\n`,
      'utf8',
    );
    const pullRequests = new StatefulPullRequestPort();
    const adapter = adapterFor(workspaceCommandRunner, pullRequests);

    const result = await adapter.executeDraft(
      requestFor(workspace, 'workflow:prepare-pr:attempt-1'),
      { ...pullRequestDraft, branchArtifacts: ['.ai/workspace/AVIA-13236/verification.md'] },
    );

    expect(result).toMatchObject({
      status: 'blocked',
      kind: 'invalid_request',
      details: { missing: ['.ai/workspace/AVIA-13236/verification.md'] },
    });
    expect(pullRequests.createCalls).toBe(0);
    expect(
      git(workspace.workspace, [
        'ls-remote',
        '--heads',
        'origin',
        `refs/heads/${workspace.branch}`,
      ]),
    ).toBe('');
  });

  it('reconciles a successful push and PR creation after both responses are lost', async () => {
    const workspace = createGitWorkspace();
    let pushResponsesLost = 0;
    const commands: WorkspaceCommandRunner = {
      executionEnvironment: 'docker_workspace',
      run: async (request) => {
        const result = await nodeCommandRunner.run(request);
        if (request.args[0] === 'push' && pushResponsesLost === 0 && result.status === 'exited') {
          pushResponsesLost += 1;
          return {
            status: 'timed_out',
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: result.durationMs,
          };
        }
        return result;
      },
    };
    const pullRequests = new StatefulPullRequestPort();
    pullRequests.loseCreateResponse = true;
    const adapter = adapterFor(commands, pullRequests);
    const request = requestFor(workspace, 'workflow:prepare-pr:attempt-1');

    const result = await adapter.executeDraft(request, pullRequestDraft);
    const repeated = await adapter.executeDraft(
      { ...request, runtime: { ...request.runtime, attempt: 2 } },
      pullRequestDraft,
    );

    expect(result).toMatchObject({
      status: 'completed',
      output: { externalId: '73', status: 'open' },
    });
    expect(repeated).toEqual(result);
    expect(pushResponsesLost).toBe(1);
    expect(pullRequests.createCalls).toBe(1);
    expect(
      git(workspace.workspace, [
        'ls-remote',
        '--heads',
        'origin',
        `refs/heads/${workspace.branch}`,
      ]).split(/\s+/u)[0],
    ).toBe(git(workspace.workspace, ['rev-parse', 'HEAD']));
  }, 15_000);

  it('resumes only branch publication after a 403 without creating another commit', async () => {
    const workspace = createGitWorkspace();
    const blockedCommands: WorkspaceCommandRunner = {
      executionEnvironment: 'docker_workspace',
      run: (request) =>
        request.args[0] === 'push'
          ? Promise.resolve({
              status: 'exited',
              exitCode: 128,
              stdout: '',
              stderr: 'remote: HTTP 403 Forbidden',
              durationMs: 1,
            })
          : nodeCommandRunner.run(request),
    };
    const pullRequests = new StatefulPullRequestPort();
    const blockedAdapter = adapterFor(blockedCommands, pullRequests);
    const first = await blockedAdapter.executeDraft(
      requestFor(workspace, 'workflow:prepare-pr:attempt-1'),
      pullRequestDraft,
    );
    const commitAfterBlockedPush = git(workspace.workspace, ['rev-parse', 'HEAD']);
    if (ledger === undefined) throw new Error('Missing effect ledger');
    const resumedAdapter = new BitbucketPullRequestAdapter(
      configuration,
      commitIdentity,
      workspaceCommandRunner,
      pullRequests,
      new ExternalEffectStore(ledger.repository, systemClock),
    );

    const resumed = await resumedAdapter.executeDraft(
      requestFor(workspace, 'workflow:prepare-pr:attempt-2'),
      pullRequestDraft,
    );

    expect(first.status).toBe('blocked');
    if (first.status !== 'blocked') throw new Error('Expected the first push to be blocked');
    expect(first.kind).toBe('infrastructure');
    expect(first.summary).toContain('403');
    expect(resumed).toMatchObject({ status: 'completed' });
    expect(git(workspace.workspace, ['rev-parse', 'HEAD'])).toBe(commitAfterBlockedPush);
    expect(git(workspace.workspace, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(pullRequests.createCalls).toBe(1);
  });

  it('reuses a matching open pull request instead of posting another one', async () => {
    const workspace = createGitWorkspace();
    const pullRequests = new StatefulPullRequestPort();
    pullRequests.value = pullRequest(`refs/heads/${workspace.branch}`);
    const adapter = adapterFor(workspaceCommandRunner, pullRequests);

    const result = await adapter.executeDraft(
      requestFor(workspace, 'workflow:prepare-pr:attempt-1'),
      pullRequestDraft,
    );

    expect(result).toMatchObject({ status: 'completed', output: { externalId: '73' } });
    expect(pullRequests.createCalls).toBe(0);
  });

  it('fast-forwards the same guarded task branch for a review revision', async () => {
    const workspace = createGitWorkspace();
    const pullRequests = new StatefulPullRequestPort();
    const adapter = adapterFor(workspaceCommandRunner, pullRequests);

    const first = await adapter.executeDraft(
      requestFor(workspace, 'workflow:prepare-pr:attempt-1'),
      pullRequestDraft,
    );
    const firstRemoteCommit = git(workspace.workspace, [
      'rev-parse',
      `refs/remotes/origin/${workspace.branch}`,
    ]);
    writeFileSync(join(workspace.workspace, 'feature.ts'), 'export const value = 3;\n', 'utf8');
    const revised = await adapter.executeDraft(
      requestFor(workspace, 'workflow:review-prepare-pr:attempt-1'),
      pullRequestDraft,
    );
    const localCommit = git(workspace.workspace, ['rev-parse', 'HEAD']);
    const remoteCommit = git(workspace.workspace, [
      'ls-remote',
      '--heads',
      'origin',
      `refs/heads/${workspace.branch}`,
    ]).split(/\s+/u)[0];

    expect(first).toMatchObject({ status: 'completed', output: { externalId: '73' } });
    expect(revised).toMatchObject({ status: 'completed', output: { externalId: '73' } });
    expect(firstRemoteCommit).not.toBe(localCommit);
    expect(remoteCommit).toBe(localCommit);
    expect(
      git(workspace.workspace, ['merge-base', '--is-ancestor', firstRemoteCommit, localCommit]),
    ).toBe('');
    expect(pullRequests.createCalls).toBe(1);
  });
});
