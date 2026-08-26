import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { nodeCommandRunner, type CommandRunner } from '../../src/providers/command-runner.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { err, ok } from '../../src/shared/outcome.js';
import {
  ManagedWorkspaceManager,
  WorkspaceBootstrapCoordinator,
  WorkspaceBootstrapStore,
  WorkspaceStore,
  type PrepareWorkspaceRequest,
  type WorkspaceBootstrapReceipt,
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
  git(repositoryPath, ['remote', 'add', 'origin', repositoryPath]);
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
  return { resource, clock, ledger, configuration, request, repositoryPath };
};

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.ledger?.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

describe('managed workspace recovery', () => {
  it('removes the managed worktree and local branch when disposed', async () => {
    const { clock, ledger, configuration, request, repositoryPath } = setup();
    const store = new WorkspaceStore(ledger.repository, clock);
    const manager = new ManagedWorkspaceManager(configuration, store, nodeCommandRunner);
    const prepared = await manager.prepare(request);
    if (!prepared.ok) throw new Error(prepared.error.kind);

    const removed = await manager.dispose(prepared.value.workspaceId);

    expect(removed).toEqual({ ok: true, value: undefined });
    expect(store.read(prepared.value.workspaceId)).toEqual({ ok: true, value: null });
    expect(git(repositoryPath, ['branch', '--list', prepared.value.branch])).toBe('');
  });

  it('uses the operator-selected task branch', () => {
    const { clock, ledger, configuration, request } = setup();
    const manager = new ManagedWorkspaceManager(
      configuration,
      new WorkspaceStore(ledger.repository, clock),
      nodeCommandRunner,
    );

    const identity = manager.identity({ ...request, branchName: 'FIX-1-review-name' });

    expect(identity.branch).toBe('FIX-1-review-name');
  });

  it('uses the task key when a title has no safe ASCII branch slug', () => {
    const { clock, ledger, configuration, request } = setup();
    const manager = new ManagedWorkspaceManager(
      configuration,
      new WorkspaceStore(ledger.repository, clock),
      nodeCommandRunner,
    );

    const identity = manager.identity({
      ...request,
      taskKey: 'AVIA-13417',
      taskTitle: 'Время прилёта наезжает на разделитель',
    });

    expect(identity.branch).toBe('AVIA-13417');
  });

  it('rejects a task branch that already exists on the remote', async () => {
    const { clock, ledger, configuration, request } = setup();
    const remoteCollisionRunner: CommandRunner = {
      run: (command) =>
        command.args[0] === 'ls-remote'
          ? Promise.resolve({
              status: 'exited',
              exitCode: 0,
              stdout: `${'a'.repeat(40)}\trefs/heads/FIX-1-change-file\n`,
              stderr: '',
              durationMs: 1,
            })
          : nodeCommandRunner.run(command),
    };
    const manager = new ManagedWorkspaceManager(
      configuration,
      new WorkspaceStore(ledger.repository, clock),
      remoteCollisionRunner,
    );
    const branch = manager.identity(request).branch;

    const result = await manager.prepare(request);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'remote_branch_conflict',
        branch,
        message: `Remote branch ${branch} already exists outside this run`,
      },
    });
  });

  it('removes a stale remote-tracking ref after the remote confirms the task branch is absent', async () => {
    const { clock, ledger, configuration, request, repositoryPath } = setup();
    const manager = new ManagedWorkspaceManager(
      configuration,
      new WorkspaceStore(ledger.repository, clock),
      nodeCommandRunner,
    );
    const branch = manager.identity(request).branch;
    const staleReference = `refs/remotes/origin/${branch}`;
    git(repositoryPath, ['update-ref', staleReference, 'HEAD']);

    const result = await manager.prepare(request);

    expect(result.ok).toBe(true);
    expect(
      spawnSync('git', ['show-ref', '--verify', '--quiet', staleReference], {
        cwd: repositoryPath,
      }).status,
    ).toBe(1);
  });

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
    expect(first.value.repository.baseBranch).toBe('main');
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

  it('reconciles bootstrap output after the adapter response was lost', async () => {
    const { clock, ledger, configuration, request } = setup();
    const manager = new ManagedWorkspaceManager(
      configuration,
      new WorkspaceStore(ledger.repository, clock),
      nodeCommandRunner,
    );
    const workspace = await manager.prepare(request);
    if (!workspace.ok) throw new Error(workspace.error.kind);
    let externalReceipt: WorkspaceBootstrapReceipt | null = null;
    let applyCalls = 0;
    const adapter = {
      inspect: () =>
        Promise.resolve(
          externalReceipt === null
            ? ok({ status: 'absent' as const })
            : ok({ status: 'ready' as const, receipt: externalReceipt }),
        ),
      apply: (_workspace: typeof workspace.value, operationId: string) => {
        applyCalls += 1;
        externalReceipt = {
          schemaVersion: 1,
          operationId,
          workspaceId: workspace.value.workspaceId,
          adapterId: 'response-loss-test',
          adapterVersion: '1',
          profile: 'fixture',
          files: [],
          completedAt: clock.now(),
        };
        return Promise.resolve(
          err({
            kind: 'adapter_failed' as const,
            phase: 'apply' as const,
            message: 'response lost after apply',
            retryable: true,
          }),
        );
      },
    };
    const store = new WorkspaceBootstrapStore(ledger.repository);
    const first = await new WorkspaceBootstrapCoordinator(store, adapter).prepare(workspace.value);
    expect(first).toMatchObject({ ok: false, error: { kind: 'adapter_failed' } });

    const recovered = await new WorkspaceBootstrapCoordinator(store, adapter).prepare(
      workspace.value,
    );

    expect(recovered).toEqual(ok(externalReceipt));
    expect(applyCalls).toBe(1);
    expect(store.read(workspace.value.workspaceId)).toEqual(recovered);
  });
});
