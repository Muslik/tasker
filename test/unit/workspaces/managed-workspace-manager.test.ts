import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  return { configuration, request, repositoryPath, manager };
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
});
