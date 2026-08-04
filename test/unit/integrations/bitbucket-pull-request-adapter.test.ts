import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BitbucketPullRequestAdapter,
  type BitbucketPullRequest,
  type BitbucketPullRequestCreation,
  type BitbucketPullRequestLookup,
  type BitbucketPullRequestPort,
  ExternalEffectStore,
} from '../../../src/integrations/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../../src/ledger/index.js';
import { findTaskFixture } from '../../../src/planning/index.js';
import { nodeCommandRunner, type CommandRunner } from '../../../src/providers/index.js';
import { systemClock } from '../../../src/shared/clock.js';
import type { IntegrationStepExecutionRequest } from '../../../src/integrations/execution.js';

const task = findTaskFixture('avia-13236-short-bug');
if (task === undefined) throw new Error('Missing test task fixture');

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
      title: `${task.taskId}: ${task.title}`,
      description: task.description,
      branchArtifacts: ['feature.ts'],
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

const requestFor = (
  workspace: ReturnType<typeof createGitWorkspace>,
  operationId: string,
): IntegrationStepExecutionRequest => ({
  operationId,
  stepReference: 'pr.prepare@1',
  taskReference: task.fixtureId,
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
    taskReference: task.fixtureId,
    workflowId: `tasker:${task.fixtureId}`,
    workflowRunId: 'run-1',
    workflowHash: 'b'.repeat(64),
    repository: {
      reference: task.repository,
      sourcePath: workspace.workspace,
      baseCommit: workspace.baseCommit,
    },
    runnerId: 'test',
    path: workspace.workspace,
    branch: workspace.branch,
    preparedAt: '2026-08-04T00:00:00.000Z',
  },
  operatorGuidance: null,
  evidence: { acceptedPlan: null, completedSteps: [], reviewInputs: [] },
  policies: [],
  project: null,
  runtime: {
    attempt: 1,
    cancellationSignal: new AbortController().signal,
    heartbeat: () => {},
  },
});

const adapterFor = (commands: CommandRunner, pullRequests: BitbucketPullRequestPort) => {
  ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
  return new BitbucketPullRequestAdapter(
    configuration,
    commands,
    pullRequests,
    new ExternalEffectStore(ledger.repository, systemClock),
  );
};

describe('Bitbucket pull request effect adapter', () => {
  it('refuses remote publication when a declared branch artifact is not committed', async () => {
    const workspace = createGitWorkspace();
    writeFileSync(
      join(workspace.workspace, '.tasker/pull-request/draft.json'),
      `${JSON.stringify({
        title: `${task.taskId}: ${task.title}`,
        description: task.description,
        branchArtifacts: ['.ai/workspace/AVIA-13236/verification.md'],
      })}\n`,
      'utf8',
    );
    const pullRequests = new StatefulPullRequestPort();
    const adapter = adapterFor(nodeCommandRunner, pullRequests);

    const result = await adapter.execute(requestFor(workspace, 'workflow:prepare-pr:attempt-1'));

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
    const commands: CommandRunner = {
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

    const result = await adapter.execute(request);
    const repeated = await adapter.execute({
      ...request,
      runtime: { ...request.runtime, attempt: 2 },
    });

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
    const blockedCommands: CommandRunner = {
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
    const first = await blockedAdapter.execute(
      requestFor(workspace, 'workflow:prepare-pr:attempt-1'),
    );
    const commitAfterBlockedPush = git(workspace.workspace, ['rev-parse', 'HEAD']);
    if (ledger === undefined) throw new Error('Missing effect ledger');
    const resumedAdapter = new BitbucketPullRequestAdapter(
      configuration,
      nodeCommandRunner,
      pullRequests,
      new ExternalEffectStore(ledger.repository, systemClock),
    );

    const resumed = await resumedAdapter.execute(
      requestFor(workspace, 'workflow:prepare-pr:attempt-2'),
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
    const adapter = adapterFor(nodeCommandRunner, pullRequests);

    const result = await adapter.execute(requestFor(workspace, 'workflow:prepare-pr:attempt-1'));

    expect(result).toMatchObject({ status: 'completed', output: { externalId: '73' } });
    expect(pullRequests.createCalls).toBe(0);
  });

  it('fast-forwards the same guarded task branch for a review revision', async () => {
    const workspace = createGitWorkspace();
    const pullRequests = new StatefulPullRequestPort();
    const adapter = adapterFor(nodeCommandRunner, pullRequests);

    const first = await adapter.execute(requestFor(workspace, 'workflow:prepare-pr:attempt-1'));
    const firstRemoteCommit = git(workspace.workspace, [
      'rev-parse',
      `refs/remotes/origin/${workspace.branch}`,
    ]);
    writeFileSync(join(workspace.workspace, 'feature.ts'), 'export const value = 3;\n', 'utf8');
    const revised = await adapter.execute(
      requestFor(workspace, 'workflow:review-prepare-pr:attempt-1'),
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
