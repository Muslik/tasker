import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteLedger, type SqliteLedger } from '../../../src/ledger/index.js';
import { nodeCommandRunner } from '../../../src/providers/command-runner.js';
import { makeAdjustableClock } from '../../../src/shared/clock.js';
import {
  ManagedWorkspaceManager,
  WorkspaceStore,
  type PrepareWorkspaceRequest,
  type WorkspaceConfiguration,
} from '../../../src/workspaces/index.js';

const resources: { readonly root: string; ledger: SqliteLedger | null }[] = [];

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const commit = (cwd: string, message: string): string => {
  git(cwd, [
    '-c',
    'user.name=Tasker Test',
    '-c',
    'user.email=tasker@example.test',
    'commit',
    '--quiet',
    '-m',
    message,
  ]);
  return git(cwd, ['rev-parse', 'HEAD']);
};

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'tasker-workspace-restart-'));
  const repositoryStorePath = join(root, 'application-data', 'repositories');
  const workspaceStorePath = join(root, 'application-data', 'worktrees');
  const repositoryPath = join(repositoryStorePath, 'example--fixture');
  mkdirSync(repositoryPath, { recursive: true });
  git(repositoryPath, ['init', '--quiet', '--initial-branch=main']);
  writeFileSync(join(repositoryPath, 'feature.txt'), 'before\n', 'utf8');
  git(repositoryPath, ['add', 'feature.txt']);
  commit(repositoryPath, 'fixture');
  git(repositoryPath, ['remote', 'add', 'origin', repositoryPath]);
  const clock = makeAdjustableClock('2026-08-03T12:00:00.000Z');
  const ledger = openSqliteLedger({ filename: join(root, 'tasker.sqlite'), clock });
  resources.push({ root, ledger });
  const configuration: WorkspaceConfiguration = {
    repositoryStorePath,
    workspaceStorePath,
    runnerId: 'restart-test',
  };
  const request: PrepareWorkspaceRequest = {
    taskReference: 'fixture:change-file',
    taskKey: 'FIX-1',
    taskTitle: 'Change file',
    workflowId: 'tasker:fixture:change-file',
    workflowRunId: 'run-1',
    repositoryReference: 'example/fixture',
    repositoryPath,
    gitPolicy: {
      baseBranch: 'main',
      branch: { kind: 'task_key_slug', maxLength: 96 },
      commit: { kind: 'task_key_subject' },
    },
  };
  const manager = new ManagedWorkspaceManager(
    configuration,
    new WorkspaceStore(ledger.repository, clock),
    nodeCommandRunner,
  );
  return { root, configuration, request, repositoryPath, manager };
};

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.ledger?.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

describe('managed workspace restart', () => {
  it('attaches a restarted run to the task branch left behind by its previous run', async () => {
    const { request, repositoryPath, manager } = setup();
    const first = await manager.prepare(request);
    if (!first.ok) throw new Error(first.error.kind);
    writeFileSync(join(first.value.path, 'feature.txt'), 'delivered\n', 'utf8');
    git(first.value.path, ['add', 'feature.txt']);
    const delivered = commit(first.value.path, 'FIX-1 deliver the change');
    git(repositoryPath, ['worktree', 'remove', '--force', '--', first.value.path]);

    const restarted = await manager.prepare({ ...request, workflowRunId: 'run-2' });

    if (!restarted.ok) throw new Error(restarted.error.kind);
    expect(restarted.value.branch).toBe(first.value.branch);
    expect(restarted.value.path).not.toBe(first.value.path);
    expect(git(restarted.value.path, ['rev-parse', 'HEAD'])).toBe(delivered);
    expect(git(restarted.value.path, ['branch', '--show-current'])).toBe(first.value.branch);
    expect(readFileSync(join(restarted.value.path, 'feature.txt'), 'utf8')).toBe('delivered\n');
  });

  it('records the task branch fork point when origin base advances before reattach', async () => {
    const { request, repositoryPath, manager } = setup();
    const forkPoint = git(repositoryPath, ['rev-parse', 'HEAD']);
    const first = await manager.prepare(request);
    if (!first.ok) throw new Error(first.error.kind);
    writeFileSync(join(first.value.path, 'feature.txt'), 'delivered\n', 'utf8');
    git(first.value.path, ['add', 'feature.txt']);
    commit(first.value.path, 'FIX-1 deliver the change');
    git(repositoryPath, ['worktree', 'remove', '--force', '--', first.value.path]);

    writeFileSync(join(repositoryPath, 'feature.txt'), 'base advanced\n', 'utf8');
    git(repositoryPath, ['add', 'feature.txt']);
    const advancedBase = commit(repositoryPath, 'advance base');

    const restarted = await manager.prepare({ ...request, workflowRunId: 'run-2' });

    if (!restarted.ok) throw new Error(restarted.error.kind);
    expect(restarted.value.repository.baseCommit).toBe(forkPoint);
    expect(restarted.value.repository.baseCommit).not.toBe(advancedBase);
  });

  it('names the live worktree holding the task branch instead of attaching a second one', async () => {
    const { request, repositoryPath, manager } = setup();
    const first = await manager.prepare(request);
    if (!first.ok) throw new Error(first.error.kind);

    const restarted = await manager.prepare({ ...request, workflowRunId: 'run-2' });

    expect(restarted.ok).toBe(false);
    if (restarted.ok) return;
    expect(restarted.error.kind).toBe('workspace_path_conflict');
    if (restarted.error.kind !== 'workspace_path_conflict') return;
    expect(restarted.error.reason).toContain(realpathSync(first.value.path));
    expect(restarted.error.reason).toContain(
      `git -C ${realpathSync(repositoryPath)} worktree remove --force -- ${realpathSync(first.value.path)}`,
    );
    expect(restarted.error.reason).toContain(
      `git -C ${realpathSync(repositoryPath)} worktree prune`,
    );
  });

  it('tells the operator to detach the main worktree when it holds the task branch', async () => {
    const { request, repositoryPath, manager } = setup();
    const branch = manager.identity(request).branch;
    git(repositoryPath, ['checkout', '--quiet', '-b', branch]);

    const prepared = await manager.prepare(request);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.kind).toBe('workspace_path_conflict');
    if (prepared.error.kind !== 'workspace_path_conflict') return;
    expect(prepared.error.reason).toContain(
      `git -C ${realpathSync(repositoryPath)} switch --detach`,
    );
    expect(prepared.error.reason).not.toContain('worktree remove --force');
  });

  it('rejects an unrelated pre-existing task branch with a friendly conflict', async () => {
    const { request, repositoryPath, manager } = setup();
    const identity = manager.identity(request);
    git(repositoryPath, ['checkout', '--quiet', '--orphan', identity.branch]);
    writeFileSync(join(repositoryPath, 'feature.txt'), 'foreign\n', 'utf8');
    git(repositoryPath, ['add', 'feature.txt']);
    commit(repositoryPath, 'foreign branch');
    git(repositoryPath, ['checkout', '--quiet', 'main']);

    const prepared = await manager.prepare(request);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.kind).toBe('workspace_path_conflict');
    if (prepared.error.kind !== 'workspace_path_conflict') return;
    expect(prepared.error.reason).toContain(
      `Branch ${identity.branch} already exists but does not share history with origin/main`,
    );
    expect(existsSync(identity.path)).toBe(false);
  });

  it('surfaces locked worktree holders even when their path is gone', async () => {
    const { root, request, repositoryPath, manager } = setup();
    const branch = manager.identity(request).branch;
    const lockedWorktreePath = join(root, 'locked-holder');
    git(repositoryPath, ['worktree', 'add', '-b', branch, '--', lockedWorktreePath, 'HEAD']);
    const registeredWorktreePath = realpathSync(lockedWorktreePath);
    git(repositoryPath, ['worktree', 'lock', registeredWorktreePath]);
    rmSync(registeredWorktreePath, { recursive: true, force: true });

    const prepared = await manager.prepare(request);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.kind).toBe('workspace_path_conflict');
    if (prepared.error.kind !== 'workspace_path_conflict') return;
    expect(prepared.error.reason).toContain(
      `git -C ${realpathSync(repositoryPath)} worktree unlock -- ${registeredWorktreePath}`,
    );
  });
});
