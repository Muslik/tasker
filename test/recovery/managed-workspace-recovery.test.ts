import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { nodeCommandRunner } from '../../src/providers/command-runner.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import {
  ManagedWorkspaceManager,
  WorkspaceStore,
  type PrepareWorkspaceRequest,
  type WorkspaceConfiguration,
} from '../../src/workspaces/index.js';

const resources: { readonly root: string; ledger: SqliteLedger | null }[] = [];

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'tasker-managed-workspace-'));
  const repositoryStorePath = join(root, 'application-data', 'repositories');
  const workspaceStorePath = join(root, 'application-data', 'worktrees');
  const repositoryPath = join(repositoryStorePath, 'example--fixture');
  mkdirSync(repositoryPath, { recursive: true });
  git(repositoryPath, ['init', '--quiet', '--initial-branch=main']);
  writeFileSync(join(repositoryPath, 'feature.txt'), 'before\n', 'utf8');
  git(repositoryPath, ['add', 'feature.txt']);
  git(repositoryPath, [
    '-c',
    'user.name=Tasker Test',
    '-c',
    'user.email=tasker@example.test',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  const clock = makeAdjustableClock('2026-08-03T12:00:00.000Z');
  const ledger = openSqliteLedger({ filename: join(root, 'tasker.sqlite'), clock });
  const resource = { root, ledger: ledger as SqliteLedger | null };
  resources.push(resource);
  const configuration: WorkspaceConfiguration = {
    repositoryStorePath,
    workspaceStorePath,
    runnerId: 'recovery-test',
  };
  const request: PrepareWorkspaceRequest = {
    taskReference: 'fixture:change-file',
    workflowId: 'tasker:fixture:change-file',
    workflowRunId: 'run-1',
    workflowHash: 'a'.repeat(64),
    repositoryReference: 'example/fixture',
    repositoryPath,
  };
  return { resource, clock, ledger, configuration, request, repositoryPath };
};

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.ledger?.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

describe('managed workspace recovery', () => {
  it('reuses the durable worktree after ledger and manager restart without losing changes', async () => {
    const { resource, clock, ledger, configuration, request, repositoryPath } = setup();
    const firstManager = new ManagedWorkspaceManager(
      configuration,
      new WorkspaceStore(ledger.repository, clock),
      nodeCommandRunner,
    );

    const first = await firstManager.prepare(request);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.kind);
    expect(first.value.path.startsWith(configuration.workspaceStorePath)).toBe(true);
    expect(first.value.repository.sourcePath).toBe(realpathSync(repositoryPath));
    expect(git(first.value.path, ['branch', '--show-current'])).toBe(first.value.branch);

    writeFileSync(join(first.value.path, 'feature.txt'), 'changed once\n', 'utf8');
    expect(git(repositoryPath, ['status', '--porcelain'])).toBe('');

    ledger.close();
    resource.ledger = null;
    const reopened = openSqliteLedger({ filename: join(resource.root, 'tasker.sqlite'), clock });
    resource.ledger = reopened;
    const replacementManager = new ManagedWorkspaceManager(
      configuration,
      new WorkspaceStore(reopened.repository, clock),
      nodeCommandRunner,
    );
    const recovered = await replacementManager.prepare(request);

    expect(recovered).toEqual(first);
    expect(readFileSync(join(first.value.path, 'feature.txt'), 'utf8')).toBe('changed once\n');
    expect(
      git(repositoryPath, ['worktree', 'list', '--porcelain']).match(/^worktree /gmu),
    ).toHaveLength(2);
  });

  it('reconciles a worktree created before its ledger receipt was persisted', async () => {
    const { clock, ledger, configuration, request, repositoryPath } = setup();
    const manager = new ManagedWorkspaceManager(
      configuration,
      new WorkspaceStore(ledger.repository, clock),
      nodeCommandRunner,
    );
    const identity = manager.identity(request);
    mkdirSync(configuration.workspaceStorePath, { recursive: true });
    git(repositoryPath, ['worktree', 'add', '-b', identity.branch, '--', identity.path, 'HEAD']);

    const recovered = await manager.prepare(request);

    expect(recovered).toMatchObject({
      ok: true,
      value: {
        workspaceId: identity.workspaceId,
        path: identity.path,
        branch: identity.branch,
      },
    });
    expect(
      git(repositoryPath, ['worktree', 'list', '--porcelain']).match(/^worktree /gmu),
    ).toHaveLength(2);
  });

  it('rejects a checkout outside Tasker application data before invoking git', async () => {
    const { resource, clock, ledger, configuration, request } = setup();
    const manager = new ManagedWorkspaceManager(
      configuration,
      new WorkspaceStore(ledger.repository, clock),
      nodeCommandRunner,
    );
    const outsidePath = join(resource.root, 'operator-work', 'repo');
    mkdirSync(outsidePath, { recursive: true });

    const result = await manager.prepare({
      ...request,
      repositoryPath: outsidePath,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'repository_outside_managed_store',
        repositoryPath: realpathSync(outsidePath),
        repositoryStorePath: realpathSync(configuration.repositoryStorePath),
      },
    });
  });
});
