import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type { CommandResult, CommandRunner } from '../providers/command-runner.js';
import { taskBranchName } from '../shared/git-branch.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  PrepareWorkspaceRequestSchema,
  WorkspaceLocatorSchema,
  type PrepareWorkspaceRequest,
  type WorkspaceLocator,
} from './contracts.js';
import type { WorkspaceConfiguration } from './configuration.js';
import type { WorkspaceStore, WorkspaceStoreError } from './store.js';

export type WorkspacePreparationError =
  | {
      readonly kind: 'repository_outside_managed_store';
      readonly repositoryPath: string;
      readonly repositoryStorePath: string;
    }
  | {
      readonly kind: 'repository_unavailable';
      readonly repositoryPath: string;
      readonly message: string;
    }
  | {
      readonly kind: 'workspace_path_conflict';
      readonly path: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'remote_branch_conflict';
      readonly branch: string;
      readonly message: string;
    }
  | {
      readonly kind: 'git_failed';
      readonly operation: string;
      readonly message: string;
      readonly retryable: boolean;
    }
  | { readonly kind: 'store'; readonly error: WorkspaceStoreError };

type GitOutcome = Outcome<
  string,
  Extract<WorkspacePreparationError, { readonly kind: 'git_failed' }>
>;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const isWithin = (parent: string, child: string): boolean => {
  const path = relative(resolve(parent), resolve(child));
  return path.length > 0 && !path.startsWith('..') && !isAbsolute(path);
};

const branchName = (request: PrepareWorkspaceRequest): string => {
  if (request.branchName !== undefined) return request.branchName;
  return taskBranchName(request.taskKey, request.taskTitle, request.gitPolicy.branch.maxLength);
};

const commandMessage = (result: CommandResult): string => {
  switch (result.status) {
    case 'spawn_failed':
      return result.message;
    case 'timed_out':
      return result.stderr.trim() || 'git command timed out';
    case 'exited':
      return result.stderr.trim() || `git exited with code ${String(result.exitCode)}`;
  }
};

const sameIdentity = (left: WorkspaceLocator, right: WorkspaceLocator): boolean =>
  left.workspaceId === right.workspaceId &&
  left.taskReference === right.taskReference &&
  left.workflowId === right.workflowId &&
  left.workflowRunId === right.workflowRunId &&
  left.repository.reference === right.repository.reference &&
  left.repository.sourcePath === right.repository.sourcePath &&
  left.repository.baseBranch === right.repository.baseBranch &&
  left.repository.baseCommit === right.repository.baseCommit &&
  left.runnerId === right.runnerId &&
  left.path === right.path &&
  left.branch === right.branch;

export class ManagedWorkspaceManager {
  public constructor(
    private readonly configuration: WorkspaceConfiguration,
    private readonly store: WorkspaceStore,
    private readonly commands: CommandRunner,
    private readonly remoteEnvironment: Readonly<Record<string, string>> = {},
  ) {}

  public identity(requestInput: PrepareWorkspaceRequest): {
    readonly workspaceId: string;
    readonly path: string;
    readonly branch: string;
  } {
    const request = PrepareWorkspaceRequestSchema.parse(requestInput);
    const workspaceId = sha256(
      JSON.stringify({
        taskReference: request.taskReference,
        workflowId: request.workflowId,
        workflowRunId: request.workflowRunId,
        repositoryReference: request.repositoryReference,
        runnerId: this.configuration.runnerId,
      }),
    ).slice(0, 24);
    return {
      workspaceId,
      path: resolve(this.configuration.workspaceStorePath, workspaceId),
      branch: branchName(request),
    };
  }

  public async prepare(
    requestInput: PrepareWorkspaceRequest,
  ): Promise<Outcome<WorkspaceLocator, WorkspacePreparationError>> {
    const parsedRequest = PrepareWorkspaceRequestSchema.parse(requestInput);
    const canonicalPaths = await (async () => {
      try {
        return ok({
          repositoryStorePath: await realpath(this.configuration.repositoryStorePath),
          repositoryPath: await realpath(parsedRequest.repositoryPath),
        });
      } catch (error) {
        return err({
          kind: 'repository_unavailable' as const,
          repositoryPath: resolve(parsedRequest.repositoryPath),
          message: error instanceof Error ? error.message : 'Managed repository is unavailable',
        });
      }
    })();
    if (!canonicalPaths.ok) return canonicalPaths;
    if (!isWithin(canonicalPaths.value.repositoryStorePath, canonicalPaths.value.repositoryPath)) {
      return err({
        kind: 'repository_outside_managed_store',
        repositoryPath: canonicalPaths.value.repositoryPath,
        repositoryStorePath: canonicalPaths.value.repositoryStorePath,
      });
    }
    const request = PrepareWorkspaceRequestSchema.parse({
      ...parsedRequest,
      repositoryPath: canonicalPaths.value.repositoryPath,
    });

    const identity = this.identity(request);
    const stored = this.store.read(identity.workspaceId);
    if (!stored.ok) return err({ kind: 'store', error: stored.error });
    if (stored.value !== null) {
      const storedLocator = stored.value;
      const storedPaths = await (async () => {
        try {
          return ok({
            workspaceStorePath: await realpath(this.configuration.workspaceStorePath),
            workspacePath: await realpath(storedLocator.path),
            repositoryPath: await realpath(storedLocator.repository.sourcePath),
          });
        } catch {
          return err({
            kind: 'workspace_path_conflict' as const,
            path: storedLocator.path,
            reason: 'The durable workspace or its source repository is missing',
          });
        }
      })();
      if (!storedPaths.ok) return storedPaths;
      if (
        !isWithin(storedPaths.value.workspaceStorePath, storedPaths.value.workspacePath) ||
        !isWithin(canonicalPaths.value.repositoryStorePath, storedPaths.value.repositoryPath)
      ) {
        return err({
          kind: 'workspace_path_conflict',
          path: storedLocator.path,
          reason: 'The durable locator escapes the configured application-data stores',
        });
      }
      const reconciled = await this.reconcile(storedLocator, false);
      return reconciled.ok ? ok(storedLocator) : reconciled;
    }

    const sourceCommonDirectory = await this.git(
      request.repositoryPath,
      'read source git common directory',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    );
    if (!sourceCommonDirectory.ok) return sourceCommonDirectory;
    const fetched = await this.git(
      request.repositoryPath,
      'fetch configured base branch',
      [
        'fetch',
        '--prune',
        'origin',
        `+refs/heads/${request.gitPolicy.baseBranch}:refs/remotes/origin/${request.gitPolicy.baseBranch}`,
      ],
      true,
      10 * 60_000,
    );
    if (!fetched.ok) return fetched;
    const baseCommit = await this.git(request.repositoryPath, 'read configured base revision', [
      'rev-parse',
      `refs/remotes/origin/${request.gitPolicy.baseBranch}`,
    ]);
    if (!baseCommit.ok) return baseCommit;
    await mkdir(this.configuration.workspaceStorePath, { recursive: true, mode: 0o700 });

    const locatorFor = (): WorkspaceLocator =>
      WorkspaceLocatorSchema.parse({
        schemaVersion: 1,
        ...identity,
        taskReference: request.taskReference,
        workflowId: request.workflowId,
        workflowRunId: request.workflowRunId,
        repository: {
          reference: request.repositoryReference,
          sourcePath: resolve(request.repositoryPath),
          baseBranch: request.gitPolicy.baseBranch,
          baseCommit: baseCommit.value,
        },
        runnerId: this.configuration.runnerId,
        preparedAt: this.store.now(),
      });

    if (existsSync(identity.path)) {
      const candidate = locatorFor();
      const reconciled = await this.reconcile(candidate, true, sourceCommonDirectory.value);
      if (!reconciled.ok) return reconciled;
      return this.persist(candidate);
    }

    const branchExists = await this.branchExists(request.repositoryPath, identity.branch);
    if (!branchExists.ok) return branchExists;
    if (branchExists.value) {
      const holder = await this.worktreeHoldingBranch(request.repositoryPath, identity.branch);
      if (!holder.ok) return holder;
      if (holder.value !== null) {
        return err({
          kind: 'workspace_path_conflict',
          path: identity.path,
          reason: `Branch ${identity.branch} is checked out in the live worktree ${holder.value}. Release it with: git -C ${resolve(request.repositoryPath)} worktree remove --force -- ${holder.value} && git -C ${resolve(request.repositoryPath)} worktree prune`,
        });
      }
      const attached = await this.git(
        request.repositoryPath,
        'attach managed worktree to the existing task branch',
        ['worktree', 'add', '--', identity.path, identity.branch],
      );
      if (!attached.ok) return attached;
      const reattached = locatorFor();
      const reconciledReattachment = await this.reconcile(
        reattached,
        false,
        sourceCommonDirectory.value,
      );
      if (!reconciledReattachment.ok) return reconciledReattachment;
      return this.persist(reattached);
    }
    const remoteBranchExists = await this.remoteBranchExists(
      request.repositoryPath,
      identity.branch,
    );
    if (!remoteBranchExists.ok) return remoteBranchExists;
    if (remoteBranchExists.value) {
      return err({
        kind: 'remote_branch_conflict',
        branch: identity.branch,
        message: `Remote branch ${identity.branch} already exists outside this run`,
      });
    }
    const prunedTaskReference = await this.git(
      request.repositoryPath,
      'remove stale remote task branch reference',
      ['update-ref', '-d', `refs/remotes/origin/${identity.branch}`],
    );
    if (!prunedTaskReference.ok) return prunedTaskReference;
    const added = await this.git(request.repositoryPath, 'create managed worktree', [
      'worktree',
      'add',
      '-b',
      identity.branch,
      '--',
      identity.path,
      baseCommit.value,
    ]);
    if (!added.ok) return added;

    const locator = locatorFor();
    const reconciled = await this.reconcile(locator, true, sourceCommonDirectory.value);
    if (!reconciled.ok) return reconciled;
    return this.persist(locator);
  }

  public async dispose(workspaceId: string): Promise<Outcome<void, WorkspacePreparationError>> {
    const stored = this.store.read(workspaceId);
    if (!stored.ok) return err({ kind: 'store', error: stored.error });
    if (stored.value === null) return ok(undefined);
    const workspace = stored.value;
    if (existsSync(workspace.path)) {
      const removed = await this.git(
        workspace.repository.sourcePath,
        'remove managed worktree',
        ['worktree', 'remove', '--force', '--', workspace.path],
        false,
        10 * 60_000,
      );
      if (!removed.ok) return removed;
    }
    const branchExists = await this.branchExists(workspace.repository.sourcePath, workspace.branch);
    if (!branchExists.ok) return branchExists;
    if (branchExists.value) {
      const deleted = await this.git(workspace.repository.sourcePath, 'delete managed branch', [
        'branch',
        '-D',
        '--',
        workspace.branch,
      ]);
      if (!deleted.ok) return deleted;
    }
    const retired = this.store.retire(workspaceId);
    return retired.ok ? retired : err({ kind: 'store', error: retired.error });
  }

  private persist(locator: WorkspaceLocator): Outcome<WorkspaceLocator, WorkspacePreparationError> {
    const saved = this.store.save(locator);
    if (!saved.ok) return err({ kind: 'store', error: saved.error });
    return sameIdentity(saved.value, locator)
      ? ok(saved.value)
      : err({
          kind: 'workspace_path_conflict',
          path: locator.path,
          reason: 'The durable workspace identity belongs to a different run',
        });
  }

  private async reconcile(
    locator: WorkspaceLocator,
    requireBaseCommit: boolean,
    expectedCommonDirectory?: string,
  ): Promise<Outcome<WorkspaceLocator, WorkspacePreparationError>> {
    if (!existsSync(locator.path)) {
      return err({
        kind: 'workspace_path_conflict',
        path: locator.path,
        reason: 'The durable workspace path is missing; automatic recreation is unsafe',
      });
    }
    const branch = await this.git(locator.path, 'read worktree branch', [
      'symbolic-ref',
      '--short',
      'HEAD',
    ]);
    if (!branch.ok) return branch;
    if (branch.value !== locator.branch) {
      return err({
        kind: 'workspace_path_conflict',
        path: locator.path,
        reason: `Expected branch ${locator.branch}, found ${branch.value}`,
      });
    }
    const commonDirectory = await this.git(locator.path, 'read worktree git common directory', [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    if (!commonDirectory.ok) return commonDirectory;
    const sourceCommonDirectory =
      expectedCommonDirectory ??
      (await this.git(locator.repository.sourcePath, 'read source git common directory', [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]));
    if (typeof sourceCommonDirectory !== 'string' && !sourceCommonDirectory.ok) {
      return sourceCommonDirectory;
    }
    const expected =
      typeof sourceCommonDirectory === 'string'
        ? sourceCommonDirectory
        : sourceCommonDirectory.value;
    if (resolve(commonDirectory.value) !== resolve(expected)) {
      return err({
        kind: 'workspace_path_conflict',
        path: locator.path,
        reason: 'The path is a worktree of another repository',
      });
    }
    if (requireBaseCommit) {
      const head = await this.git(locator.path, 'read worktree HEAD', ['rev-parse', 'HEAD']);
      if (!head.ok) return head;
      if (head.value !== locator.repository.baseCommit) {
        return err({
          kind: 'workspace_path_conflict',
          path: locator.path,
          reason: 'An unrecorded worktree already advanced beyond the expected base commit',
        });
      }
    }
    return ok(locator);
  }

  private async branchExists(
    repositoryPath: string,
    branch: string,
  ): Promise<Outcome<boolean, WorkspacePreparationError>> {
    const result = await this.commands.run({
      command: 'git',
      args: ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      cwd: repositoryPath,
      env: { GIT_TERMINAL_PROMPT: '0' },
      stdin: '',
      timeoutMs: 30_000,
    });
    if (result.status === 'exited' && (result.exitCode === 0 || result.exitCode === 1)) {
      return ok(result.exitCode === 0);
    }
    return err({
      kind: 'git_failed',
      operation: 'inspect managed branch',
      message: commandMessage(result),
      retryable: result.status !== 'exited' || result.exitCode !== 128,
    });
  }

  private async worktreeHoldingBranch(
    repositoryPath: string,
    branch: string,
  ): Promise<Outcome<string | null, WorkspacePreparationError>> {
    const pruned = await this.git(repositoryPath, 'prune stale managed worktrees', [
      'worktree',
      'prune',
    ]);
    if (!pruned.ok) return pruned;
    const listed = await this.git(repositoryPath, 'inspect registered worktrees', [
      'worktree',
      'list',
      '--porcelain',
    ]);
    if (!listed.ok) return listed;
    const holder = listed.value
      .split(/\n\s*\n/u)
      .map((entry) => entry.split('\n'))
      .find((lines) => lines.includes(`branch refs/heads/${branch}`));
    const path = holder?.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    return ok(path !== undefined && existsSync(path) ? path : null);
  }

  private async remoteBranchExists(
    repositoryPath: string,
    branch: string,
  ): Promise<Outcome<boolean, WorkspacePreparationError>> {
    const result = await this.commands.run({
      command: 'git',
      args: ['ls-remote', '--exit-code', '--heads', 'origin', branch],
      cwd: repositoryPath,
      env: { ...this.remoteEnvironment, GIT_TERMINAL_PROMPT: '0' },
      stdin: '',
      timeoutMs: 2 * 60_000,
    });
    if (result.status === 'exited' && (result.exitCode === 0 || result.exitCode === 2)) {
      return ok(result.exitCode === 0);
    }
    return err({
      kind: 'git_failed',
      operation: 'inspect remote task branch',
      message: commandMessage(result),
      retryable: result.status !== 'exited' || result.exitCode !== 128,
    });
  }

  private async git(
    cwd: string,
    operation: string,
    args: readonly string[],
    authenticated = false,
    timeoutMs = 2 * 60_000,
  ): Promise<GitOutcome> {
    const result = await this.commands.run({
      command: 'git',
      args,
      cwd,
      env: {
        ...(authenticated ? this.remoteEnvironment : {}),
        GIT_TERMINAL_PROMPT: '0',
      },
      stdin: '',
      timeoutMs,
    });
    if (result.status === 'exited' && result.exitCode === 0) return ok(result.stdout.trim());
    return err({
      kind: 'git_failed',
      operation,
      message: commandMessage(result),
      retryable: result.status !== 'exited' || result.exitCode !== 128,
    });
  }
}
