import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { HarnessGitPolicy } from '../../harness/contracts.js';
import type { CommandResult, WorkspaceCommandRunner } from '../../providers/command-runner.js';
import type { BitbucketRepositoryConfiguration } from '../../repositories/bitbucket.js';
import { JsonValueSchema, type JsonValue } from '../../workflow/schema.js';
import type {
  IntegrationStepExecutionRequest,
  IntegrationStepExecutionResult,
} from '../execution.js';
import type { ExternalEffectStore, ExternalEffectStoreError } from '../effects.js';
import type { GitCommitDraft, PullRequestDraft } from '../pull-request-draft.js';
import type { GitCommitIdentity } from './git-identity.js';
import type {
  BitbucketPullRequest,
  BitbucketPullRequestPort,
  BitbucketPullRequestProblem,
} from './pull-requests.js';

const PullRequestReceiptResultSchema = z
  .object({
    pullRequestId: z.number().int().positive(),
    url: z.url().nullable(),
    sourceBranch: z.string().min(1),
    targetBranch: z.string().min(1),
  })
  .strict();

type GitFailure = {
  readonly kind: 'git_failed';
  readonly operation: string;
  readonly message: string;
  readonly responseMayBeLost: boolean;
};

type RemoteBranchProbe =
  | { readonly status: 'found'; readonly commit: string }
  | { readonly status: 'missing' }
  | { readonly status: 'failed'; readonly failure: GitFailure };

export const formatGitCommitMessage = (
  taskKey: string,
  draft: GitCommitDraft,
  policy: HarnessGitPolicy['commit'],
):
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly reason: string } => {
  if (policy.kind === 'task_key_subject') {
    return draft.kind === 'subject'
      ? { ok: true, message: `${taskKey}: ${draft.subject}` }
      : { ok: false, reason: 'Project policy requires a task-key subject commit draft' };
  }
  if (draft.kind !== 'conventional') {
    return { ok: false, reason: 'Project policy requires a conventional commit draft' };
  }
  if (!policy.allowedTypes.includes(draft.type)) {
    return { ok: false, reason: `Commit type ${draft.type} is not allowed by project policy` };
  }
  if (policy.requireScope && draft.scope === null) {
    return { ok: false, reason: 'Project policy requires a conventional commit scope' };
  }
  const scope = draft.scope === null ? '' : `(${draft.scope})`;
  return { ok: true, message: `${draft.type}${scope}: [${taskKey}] ${draft.subject}` };
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

const commandSucceeded = (
  result: CommandResult,
): result is Extract<CommandResult, { readonly status: 'exited' }> =>
  result.status === 'exited' && result.exitCode === 0;

const parseNullSeparated = (value: string): readonly string[] =>
  value.split('\0').filter((item) => item.length > 0);

const qualifiedRepository = (
  reference: string,
): { readonly projectKey: string; readonly repositorySlug: string } | null => {
  const segments = reference.split('/');
  return segments.length === 2 && segments[0] !== '' && segments[1] !== ''
    ? { projectKey: segments[0] as string, repositorySlug: segments[1] as string }
    : null;
};

const effectStoreFailure = (
  error: ExternalEffectStoreError,
  artifactIds: readonly string[],
): IntegrationStepExecutionResult => ({
  status: 'blocked',
  kind: 'unknown_outcome',
  summary: `External effect journal is unavailable: ${error.kind}`,
  details: JsonValueSchema.parse(error),
  artifactIds,
});

const pullRequestResult = (
  pullRequest: BitbucketPullRequest,
  sourceBranch: string,
  targetBranch: string,
): z.infer<typeof PullRequestReceiptResultSchema> =>
  PullRequestReceiptResultSchema.parse({
    pullRequestId: pullRequest.id,
    url: pullRequest.url,
    sourceBranch,
    targetBranch,
  });

const pullRequestOutput = (
  receipt: z.infer<typeof PullRequestReceiptResultSchema>,
  repository: string,
): JsonValue => ({
  externalId: String(receipt.pullRequestId),
  status: 'open',
  provider: 'bitbucket',
  repository,
  sourceBranch: receipt.sourceBranch,
  targetBranch: receipt.targetBranch,
  url: receipt.url,
});

const problemResult = (
  problem: BitbucketPullRequestProblem,
  artifactIds: readonly string[],
): IntegrationStepExecutionResult => ({
  status: 'blocked',
  kind:
    problem.kind === 'access_blocked' || problem.kind === 'unavailable'
      ? 'infrastructure'
      : problem.kind === 'conflict'
        ? 'remote_conflict'
        : 'invalid_request',
  summary: problem.message,
  details: JsonValueSchema.parse(problem),
  artifactIds,
});

export class BitbucketPullRequestAdapter {
  public readonly id = 'bitbucket.pull-request@1';

  public constructor(
    private readonly configuration: BitbucketRepositoryConfiguration,
    private readonly commitIdentity: GitCommitIdentity | null,
    private readonly commands: WorkspaceCommandRunner,
    private readonly pullRequests: BitbucketPullRequestPort,
    private readonly effects: ExternalEffectStore,
  ) {}

  public async executeDraft(
    request: IntegrationStepExecutionRequest,
    draft: PullRequestDraft,
  ): Promise<IntegrationStepExecutionResult> {
    const repository = qualifiedRepository(request.workspace.repository.reference);
    if (repository === null) {
      return {
        status: 'blocked',
        kind: 'invalid_request',
        summary: 'Bitbucket PR preparation requires a qualified project/repository reference',
        details: { repository: request.workspace.repository.reference },
        artifactIds: [],
      };
    }

    const targetBranch = await this.targetBranch(request);
    if (targetBranch.status === 'blocked') return targetBranch.result;
    const localCommit = await this.commitWorkspace(request, draft);
    if (localCommit.status === 'blocked') return localCommit.result;
    const artifactCheck = await this.verifyBranchArtifacts(
      request,
      localCommit.commit,
      draft.branchArtifacts,
    );
    if (artifactCheck !== null) return artifactCheck;
    const sourceRef = `refs/heads/${request.workspace.branch}`;
    const targetRef = `refs/heads/${targetBranch.branch}`;
    const pushed = await this.pushBranch(request, sourceRef, localCommit.commit);
    if (pushed.status === 'blocked') return pushed.result;

    return this.preparePullRequest(request, {
      ...repository,
      sourceRef,
      targetRef,
      sourceBranch: request.workspace.branch,
      targetBranch: targetBranch.branch,
      repositoryReference: request.workspace.repository.reference,
      artifactIds: pushed.artifactIds,
      draft,
    });
  }

  private gitEnvironment(): Readonly<Record<string, string>> {
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${this.configuration.token}`,
      GIT_TERMINAL_PROMPT: '0',
    };
  }

  private runGit(
    request: IntegrationStepExecutionRequest,
    operation: string,
    args: readonly string[],
    options: { readonly authenticated?: boolean; readonly timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    request.runtime.heartbeat({ phase: 'git', operation });
    return this.commands.run({
      command: 'git',
      args,
      cwd: request.workspace.path,
      ...(options.authenticated === true ? { env: this.gitEnvironment() } : {}),
      stdin: '',
      timeoutMs: options.timeoutMs ?? 60_000,
      cancellationSignal: request.runtime.cancellationSignal,
    });
  }

  private gitFailure(
    operation: string,
    result: CommandResult,
    responseMayBeLost = false,
  ): GitFailure {
    return {
      kind: 'git_failed',
      operation,
      message: commandMessage(result),
      responseMayBeLost,
    };
  }

  private async targetBranch(
    request: IntegrationStepExecutionRequest,
  ): Promise<
    | { readonly status: 'ready'; readonly branch: string }
    | { readonly status: 'blocked'; readonly result: IntegrationStepExecutionResult }
  > {
    const branch = request.project?.git.baseBranch;
    if (branch === undefined) {
      return {
        status: 'blocked',
        result: {
          status: 'blocked',
          kind: 'configuration',
          summary: 'Project Git base branch is not configured',
          details: { repository: request.workspace.repository.reference },
          artifactIds: [],
        },
      };
    }
    const result = await this.runGit(request, 'resolve_target_branch', [
      'rev-parse',
      '--verify',
      `refs/remotes/origin/${branch}`,
    ]);
    if (!commandSucceeded(result)) {
      return {
        status: 'blocked',
        result: {
          status: 'blocked',
          kind: 'configuration',
          summary: 'Cannot resolve the target branch from origin/HEAD',
          details: this.gitFailure('resolve_target_branch', result),
          artifactIds: [],
        },
      };
    }
    return { status: 'ready', branch };
  }

  private async commitWorkspace(
    request: IntegrationStepExecutionRequest,
    draft: PullRequestDraft,
  ): Promise<
    | { readonly status: 'ready'; readonly commit: string }
    | { readonly status: 'blocked'; readonly result: IntegrationStepExecutionResult }
  > {
    const gitPolicy = request.project?.git;
    if (gitPolicy === undefined) {
      return {
        status: 'blocked',
        result: {
          status: 'blocked',
          kind: 'configuration',
          summary: 'Project Git policy is not configured',
          details: { repository: request.workspace.repository.reference },
          artifactIds: [],
        },
      };
    }
    const commitMessage = formatGitCommitMessage(
      request.task.taskId,
      draft.commit,
      gitPolicy.commit,
    );
    if (!commitMessage.ok) {
      return {
        status: 'blocked',
        result: {
          status: 'blocked',
          kind: 'invalid_request',
          summary: commitMessage.reason,
          details: { policy: gitPolicy.commit.kind },
          artifactIds: [],
        },
      };
    }
    const unmerged = await this.runGit(request, 'inspect_unmerged_paths', [
      'diff',
      '--name-only',
      '--diff-filter=U',
      '-z',
    ]);
    if (!commandSucceeded(unmerged)) {
      return this.gitBlocked(
        'Cannot inspect the worktree for conflicts',
        'configuration',
        unmerged,
      );
    }
    const unmergedPaths = parseNullSeparated(unmerged.stdout);
    if (unmergedPaths.length > 0) {
      return {
        status: 'blocked',
        result: {
          status: 'blocked',
          kind: 'remote_conflict',
          summary: 'The managed worktree has unresolved merge conflicts',
          details: { paths: [...unmergedPaths] },
          artifactIds: [],
        },
      };
    }

    const tracked = await this.runGit(request, 'inspect_tracked_changes', [
      'diff',
      '--name-only',
      '-z',
      'HEAD',
    ]);
    if (!commandSucceeded(tracked)) {
      return this.gitBlocked('Cannot inspect tracked changes', 'configuration', tracked);
    }
    const untracked = await this.runGit(request, 'inspect_untracked_changes', [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]);
    if (!commandSucceeded(untracked)) {
      return this.gitBlocked('Cannot inspect untracked changes', 'configuration', untracked);
    }
    const changedPaths = [
      ...new Set([...parseNullSeparated(tracked.stdout), ...parseNullSeparated(untracked.stdout)]),
    ];
    if (changedPaths.length > 0) {
      if (this.commitIdentity === null) {
        return {
          status: 'blocked',
          result: {
            status: 'blocked',
            kind: 'configuration',
            summary:
              'Git commit identity is not configured. Set TASKER_GIT_AUTHOR_NAME and TASKER_GIT_AUTHOR_EMAIL.',
            details: {
              requiredEnvironment: ['TASKER_GIT_AUTHOR_NAME', 'TASKER_GIT_AUTHOR_EMAIL'],
            },
            artifactIds: [],
          },
        };
      }
      const staged = await this.runGit(request, 'stage_task_changes', [
        'add',
        '--',
        ...changedPaths,
      ]);
      if (!commandSucceeded(staged)) {
        return this.gitBlocked('Cannot stage task changes', 'configuration', staged);
      }
      const committed = await this.runGit(request, 'commit_task_changes', [
        '-c',
        `user.name=${this.commitIdentity.name}`,
        '-c',
        `user.email=${this.commitIdentity.email}`,
        'commit',
        '-m',
        commitMessage.message,
      ]);
      if (!commandSucceeded(committed)) {
        return this.gitBlocked('Cannot commit task changes', 'configuration', committed);
      }
    }

    const head = await this.runGit(request, 'read_local_head', ['rev-parse', 'HEAD']);
    if (!commandSucceeded(head)) {
      return this.gitBlocked('Cannot read the worktree commit', 'configuration', head);
    }
    const commit = head.stdout.trim();
    if (commit === request.workspace.repository.baseCommit) {
      return {
        status: 'blocked',
        result: {
          status: 'blocked',
          kind: 'invalid_request',
          summary: 'The task has no committed change to publish',
          details: { baseCommit: request.workspace.repository.baseCommit },
          artifactIds: [],
        },
      };
    }
    const actualMessage = await this.runGit(request, 'read_commit_subject', [
      'log',
      '-1',
      '--format=%s',
      commit,
    ]);
    if (!commandSucceeded(actualMessage)) {
      return this.gitBlocked('Cannot read the commit subject', 'configuration', actualMessage);
    }
    if (actualMessage.stdout.trim() !== commitMessage.message) {
      return {
        status: 'blocked',
        result: {
          status: 'blocked',
          kind: 'configuration',
          summary: 'Git hooks changed the commit message outside project policy',
          details: { expected: commitMessage.message, actual: actualMessage.stdout.trim() },
          artifactIds: [],
        },
      };
    }
    return { status: 'ready', commit };
  }

  private gitBlocked(
    summary: string,
    kind: 'configuration' | 'infrastructure',
    result: CommandResult,
  ): { readonly status: 'blocked'; readonly result: IntegrationStepExecutionResult } {
    return {
      status: 'blocked',
      result: {
        status: 'blocked',
        kind,
        summary,
        details: this.gitFailure('git', result),
        artifactIds: [],
      },
    };
  }

  private async verifyBranchArtifacts(
    request: IntegrationStepExecutionRequest,
    commit: string,
    branchArtifacts: readonly string[],
  ): Promise<IntegrationStepExecutionResult | null> {
    if (branchArtifacts.length === 0) return null;
    const listed = await this.runGit(request, 'verify_branch_artifacts', [
      'ls-tree',
      '-z',
      '--name-only',
      commit,
      '--',
      ...branchArtifacts,
    ]);
    if (!commandSucceeded(listed)) {
      return this.gitBlocked(
        'Cannot verify required pull-request branch artifacts',
        'configuration',
        listed,
      ).result;
    }
    const committed = new Set(parseNullSeparated(listed.stdout));
    const missing = branchArtifacts.filter((path) => !committed.has(path));
    return missing.length === 0
      ? null
      : {
          status: 'blocked',
          kind: 'invalid_request',
          summary: 'Required pull-request artifacts are not committed on the task branch',
          details: { commit, missing },
          artifactIds: [],
        };
  }

  private async probeRemoteBranch(
    request: IntegrationStepExecutionRequest,
    sourceRef: string,
  ): Promise<RemoteBranchProbe> {
    const result = await this.runGit(
      request,
      'probe_remote_branch',
      ['ls-remote', '--heads', 'origin', sourceRef],
      { authenticated: true },
    );
    if (!commandSucceeded(result)) {
      return { status: 'failed', failure: this.gitFailure('probe_remote_branch', result) };
    }
    const line = result.stdout.trim();
    if (line.length === 0) return { status: 'missing' };
    const commit = line.split(/\s+/u)[0];
    return commit === undefined || !/^[a-f0-9]{40,64}$/u.test(commit)
      ? {
          status: 'failed',
          failure: {
            kind: 'git_failed',
            operation: 'probe_remote_branch',
            message: 'git ls-remote returned an invalid object ID',
            responseMayBeLost: false,
          },
        }
      : { status: 'found', commit };
  }

  private async pushBranch(
    request: IntegrationStepExecutionRequest,
    sourceRef: string,
    localCommit: string,
  ): Promise<
    | { readonly status: 'ready'; readonly artifactIds: readonly string[] }
    | { readonly status: 'blocked'; readonly result: IntegrationStepExecutionResult }
  > {
    const effectId = 'push-branch';
    const intent = this.effects.prepare({
      operationId: request.operationId,
      effectId,
      effectKind: 'git.push',
      identity: {
        repository: request.workspace.repository.reference,
        sourceRef,
        localCommit,
      },
    });
    const intentArtifactId = this.effects.intentArtifactId(request.operationId, effectId);
    if (!intent.ok) return { status: 'blocked', result: effectStoreFailure(intent.error, []) };

    const artifacts = [intentArtifactId];
    const priorReceipt = this.effects.readReceipt(request.operationId, effectId);
    if (!priorReceipt.ok) {
      return { status: 'blocked', result: effectStoreFailure(priorReceipt.error, artifacts) };
    }
    if (priorReceipt.value !== null) {
      return {
        status: 'ready',
        artifactIds: [...artifacts, this.effects.receiptArtifactId(request.operationId, effectId)],
      };
    }

    const before = await this.probeRemoteBranch(request, sourceRef);
    if (before.status === 'failed') {
      return {
        status: 'blocked',
        result: {
          status: 'blocked',
          kind: 'infrastructure',
          summary: 'Cannot inspect the remote branch before push',
          details: before.failure,
          artifactIds: artifacts,
        },
      };
    }
    if (before.status === 'found' && before.commit !== localCommit) {
      const ancestor = await this.runGit(request, 'verify_remote_branch_ancestor', [
        'merge-base',
        '--is-ancestor',
        before.commit,
        localCommit,
      ]);
      if (!commandSucceeded(ancestor)) {
        return {
          status: 'blocked',
          result: {
            status: 'blocked',
            kind: 'remote_conflict',
            summary: 'The remote task branch is not an ancestor of the local revision',
            details: { sourceRef, localCommit, remoteCommit: before.commit },
            artifactIds: artifacts,
          },
        };
      }
    }

    if (before.status === 'missing' || before.commit !== localCommit) {
      const lease =
        before.status === 'found' ? [`--force-with-lease=${sourceRef}:${before.commit}`] : [];
      const push = await this.runGit(
        request,
        'push_branch',
        ['push', ...lease, 'origin', `HEAD:${sourceRef}`],
        { authenticated: true, timeoutMs: 10 * 60_000 },
      );
      if (!commandSucceeded(push)) {
        const afterFailure = await this.probeRemoteBranch(request, sourceRef);
        if (afterFailure.status === 'failed') {
          return {
            status: 'blocked',
            result: {
              status: 'blocked',
              kind: 'unknown_outcome',
              summary: 'Push response was lost and the remote branch cannot be reconciled',
              details: {
                push: this.gitFailure('push_branch', push, true),
                reconcile: afterFailure.failure,
              },
              artifactIds: artifacts,
            },
          };
        }
        if (afterFailure.status === 'missing') {
          const message = commandMessage(push);
          return {
            status: 'blocked',
            result: {
              status: 'blocked',
              kind: 'infrastructure',
              summary: /403|forbidden/iu.test(message)
                ? 'Bitbucket rejected the push with 403. Enable VPN or check repository access'
                : 'The branch push failed before the remote ref changed',
              details: this.gitFailure('push_branch', push),
              artifactIds: artifacts,
            },
          };
        }
        if (afterFailure.commit !== localCommit) {
          return {
            status: 'blocked',
            result: {
              status: 'blocked',
              kind: 'remote_conflict',
              summary: 'The remote branch changed to an unexpected commit during push recovery',
              details: { sourceRef, localCommit, remoteCommit: afterFailure.commit },
              artifactIds: artifacts,
            },
          };
        }
      }
    }

    const receipt = this.effects.recordApplied({
      operationId: request.operationId,
      effectId,
      effectKind: 'git.push',
      result: { repository: request.workspace.repository.reference, sourceRef, localCommit },
    });
    if (!receipt.ok) {
      return { status: 'blocked', result: effectStoreFailure(receipt.error, artifacts) };
    }
    return {
      status: 'ready',
      artifactIds: [...artifacts, this.effects.receiptArtifactId(request.operationId, effectId)],
    };
  }

  private async preparePullRequest(
    request: IntegrationStepExecutionRequest,
    input: {
      readonly projectKey: string;
      readonly repositorySlug: string;
      readonly sourceRef: string;
      readonly targetRef: string;
      readonly sourceBranch: string;
      readonly targetBranch: string;
      readonly repositoryReference: string;
      readonly artifactIds: readonly string[];
      readonly draft: PullRequestDraft;
    },
  ): Promise<IntegrationStepExecutionResult> {
    const effectId = 'create-pull-request';
    const { title, description } = input.draft;
    const intent = this.effects.prepare({
      operationId: request.operationId,
      effectId,
      effectKind: 'bitbucket.pull-request.create',
      identity: {
        projectKey: input.projectKey,
        repositorySlug: input.repositorySlug,
        sourceRef: input.sourceRef,
        targetRef: input.targetRef,
        title,
        descriptionSha256: createHash('sha256').update(description).digest('hex'),
      },
    });
    const intentArtifactId = this.effects.intentArtifactId(request.operationId, effectId);
    const artifacts = [...input.artifactIds, intentArtifactId];
    if (!intent.ok) return effectStoreFailure(intent.error, input.artifactIds);

    const priorReceipt = this.effects.readReceipt(request.operationId, effectId);
    if (!priorReceipt.ok) return effectStoreFailure(priorReceipt.error, artifacts);
    if (priorReceipt.value !== null) {
      const parsed = PullRequestReceiptResultSchema.safeParse(priorReceipt.value.result);
      if (!parsed.success) {
        return {
          status: 'blocked',
          kind: 'unknown_outcome',
          summary: 'The persisted pull request receipt is invalid',
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
          artifactIds: artifacts,
        };
      }
      return {
        status: 'completed',
        summary: `Pull request ${String(parsed.data.pullRequestId)} is ready for review`,
        output: pullRequestOutput(parsed.data, input.repositoryReference),
        artifactIds: [...artifacts, this.effects.receiptArtifactId(request.operationId, effectId)],
      };
    }

    const lookupInput = {
      projectKey: input.projectKey,
      repositorySlug: input.repositorySlug,
      sourceRef: input.sourceRef,
      targetRef: input.targetRef,
    };
    const before = await this.pullRequests.findOpen(lookupInput);
    if (before.status === 'failed') return problemResult(before.problem, artifacts);
    if (before.status === 'ambiguous') {
      return {
        status: 'blocked',
        kind: 'remote_conflict',
        summary: 'More than one open pull request matches the source and target branches',
        details: { pullRequestIds: [...before.pullRequestIds] },
        artifactIds: artifacts,
      };
    }

    let pullRequest: BitbucketPullRequest;
    if (before.status === 'found') {
      pullRequest = before.pullRequest;
    } else {
      request.runtime.heartbeat({ phase: 'bitbucket', operation: 'create_pull_request' });
      const created = await this.pullRequests.create({
        ...lookupInput,
        title,
        description,
      });
      if (created.status === 'created') {
        pullRequest = created.pullRequest;
      } else {
        const afterFailure = await this.pullRequests.findOpen(lookupInput);
        if (afterFailure.status === 'found') {
          pullRequest = afterFailure.pullRequest;
        } else if (
          created.problem.kind === 'access_blocked' ||
          created.problem.kind === 'auth_failed' ||
          created.problem.kind === 'invalid_request' ||
          created.problem.kind === 'not_found'
        ) {
          return problemResult(created.problem, artifacts);
        } else if (afterFailure.status === 'failed') {
          return {
            status: 'blocked',
            kind: 'unknown_outcome',
            summary: 'Pull request creation outcome cannot be reconciled',
            details: { create: created.problem, reconcile: afterFailure.problem },
            artifactIds: artifacts,
          };
        } else if (afterFailure.status === 'ambiguous') {
          return {
            status: 'blocked',
            kind: 'remote_conflict',
            summary: 'Pull request recovery found more than one matching open PR',
            details: { pullRequestIds: [...afterFailure.pullRequestIds] },
            artifactIds: artifacts,
          };
        } else {
          return problemResult(created.problem, artifacts);
        }
      }
    }

    const result = pullRequestResult(pullRequest, input.sourceBranch, input.targetBranch);
    const receipt = this.effects.recordApplied({
      operationId: request.operationId,
      effectId,
      effectKind: 'bitbucket.pull-request.create',
      result,
    });
    if (!receipt.ok) return effectStoreFailure(receipt.error, artifacts);
    return {
      status: 'completed',
      summary: `Pull request ${String(pullRequest.id)} is ready for review`,
      output: pullRequestOutput(result, input.repositoryReference),
      artifactIds: [...artifacts, this.effects.receiptArtifactId(request.operationId, effectId)],
    };
  }
}
