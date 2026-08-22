import { Context } from '@temporalio/activity';

import type { HarnessGitPolicy } from '../../harness/index.js';
import type { Outcome } from '../../shared/outcome.js';
import type {
  PrepareWorkspaceRequest,
  WorkspaceLocator,
  WorkspacePreparationError,
  WorkspaceBootstrapper,
  DockerWorkspaceRuntimePreparer,
  ResolvedWorkspaceRuntimePolicy,
} from '../../workspaces/index.js';
import {
  PrepareTaskWorkspaceInputSchema,
  PrepareTaskWorkspaceResultSchema,
  type PrepareTaskWorkspaceInput,
  type BootstrapWorkflowActivities,
} from '../bootstrap-kernel/contracts.js';

interface WorkspaceSubject {
  readonly repositoryPath: string;
  readonly task: {
    readonly repository: string;
    readonly taskId: string;
    readonly title: string;
  };
}

export interface TemporalWorkspaceSubjectSource {
  resolve(
    taskReference: string,
    workflowRunId: string,
  ): Outcome<WorkspaceSubject, { readonly kind: string }>;
}

export interface TemporalManagedWorkspacePreparer {
  prepare(
    request: PrepareWorkspaceRequest,
  ): Promise<Outcome<WorkspaceLocator, WorkspacePreparationError>>;
}

export interface TemporalWorkspacePolicySource {
  resolveRuntime(repositoryReference: string): ResolvedWorkspaceRuntimePolicy;
  resolveGit(repositoryReference: string): HarnessGitPolicy;
}

const failure = (
  phase: string,
  detail: {
    readonly kind: string;
    readonly message?: string;
    readonly command?: string;
    readonly image?: string;
    readonly service?: string;
  },
): Error =>
  new Error(
    `Task workspace ${phase} failed: ${detail.kind}${
      detail.command === undefined ? '' : ` [command: ${detail.command}]`
    }${detail.image === undefined ? '' : ` [image: ${detail.image}]`}${
      detail.service === undefined ? '' : ` [service: ${detail.service}]`
    }${detail.message === undefined ? '' : `: ${detail.message}`}`,
  );

export const createWorkspaceActivity = (
  subjects: TemporalWorkspaceSubjectSource,
  workspaces: TemporalManagedWorkspacePreparer,
  bootstrap: WorkspaceBootstrapper,
  runtimes: DockerWorkspaceRuntimePreparer,
  policies: TemporalWorkspacePolicySource,
): Pick<BootstrapWorkflowActivities, 'prepareTaskWorkspace'> => {
  const prepareDockerRuntime = async (workspace: WorkspaceLocator) => {
    const context = Context.current();
    context.cancellationSignal.throwIfAborted();
    context.heartbeat({ phase: 'prepare_docker_runtime' });
    const heartbeat = setInterval(() => {
      context.heartbeat({ phase: 'prepare_docker_runtime' });
    }, 10_000);
    const runtime = await (async () => {
      try {
        return await runtimes.prepare(
          workspace,
          policies.resolveRuntime(workspace.repository.reference),
          {
            cancellationSignal: context.cancellationSignal,
            onProgress: (progress) => {
              context.heartbeat({
                phase: `prepare_docker_runtime:${progress.phase}`,
                ...(progress.detail === undefined ? {} : { detail: progress.detail }),
              });
            },
          },
        );
      } finally {
        clearInterval(heartbeat);
      }
    })();
    if (!runtime.ok) throw failure('Docker runtime', runtime.error);
    return runtime.value;
  };

  return {
    prepareTaskWorkspace: async (inputValue: PrepareTaskWorkspaceInput) => {
      const input = PrepareTaskWorkspaceInputSchema.parse(inputValue);
      const context = Context.current();
      context.heartbeat({ phase: 'resolve_repository' });

      const subject = subjects.resolve(input.taskReference, input.workflowRunId);
      if (!subject.ok) throw failure('repository resolution', subject.error);

      context.heartbeat({ phase: 'prepare_worktree' });
      const prepared = await workspaces.prepare({
        taskReference: input.taskReference,
        taskKey: subject.value.task.taskId,
        taskTitle: subject.value.task.title,
        workflowId: input.workflowId,
        workflowRunId: input.workflowRunId,
        repositoryReference: subject.value.task.repository,
        repositoryPath: subject.value.repositoryPath,
        gitPolicy: policies.resolveGit(subject.value.task.repository),
      });
      if (!prepared.ok) throw failure('preparation', prepared.error);

      context.cancellationSignal.throwIfAborted();
      context.heartbeat({ phase: 'bootstrap_harness' });
      const bootstrapped = await bootstrap.prepare(prepared.value);
      if (!bootstrapped.ok) throw failure('bootstrap', bootstrapped.error);

      await prepareDockerRuntime(prepared.value);

      return PrepareTaskWorkspaceResultSchema.parse({
        workspace: {
          workspaceId: prepared.value.workspaceId,
          repositoryReference: prepared.value.repository.reference,
          revision: prepared.value.repository.baseCommit,
          path: prepared.value.path,
        },
      });
    },
  };
};
