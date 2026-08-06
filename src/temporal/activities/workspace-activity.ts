import { Context } from '@temporalio/activity';

import type { PlanningSnapshotSource } from '../../planning/run-planning-snapshot.js';
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
  PrepareTaskDockerRuntimeInputSchema,
  PrepareTaskDockerRuntimeResultSchema,
  PrepareTaskWorkspaceInputSchema,
  PrepareTaskWorkspaceResultSchema,
  type PrepareTaskWorkspaceInput,
  type TaskWorkflowActivities,
} from '../contracts.js';

interface WorkspaceSubject {
  readonly repositoryPath: string;
  readonly task: { readonly repository: string };
}

export interface TemporalWorkspaceSubjectSource {
  resolve(taskReference: string): Outcome<WorkspaceSubject, { readonly kind: string }>;
}

export interface TemporalManagedWorkspacePreparer {
  prepare(
    request: PrepareWorkspaceRequest,
  ): Promise<Outcome<WorkspaceLocator, WorkspacePreparationError>>;
}

export interface TemporalWorkspaceRuntimePolicySource {
  resolve(repositoryReference: string): ResolvedWorkspaceRuntimePolicy;
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
  runtimePolicies: TemporalWorkspaceRuntimePolicySource,
  snapshots: PlanningSnapshotSource,
): Pick<TaskWorkflowActivities, 'prepareTaskWorkspace' | 'prepareTaskDockerRuntime'> => {
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
          runtimePolicies.resolve(workspace.repository.reference),
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

      const subject = subjects.resolve(input.taskReference);
      if (!subject.ok) throw failure('repository resolution', subject.error);

      context.heartbeat({ phase: 'prepare_worktree' });
      const prepared = await workspaces.prepare({
        taskReference: input.taskReference,
        workflowId: input.workflowId,
        workflowRunId: input.workflowRunId,
        workflowHash: input.workflowHash,
        repositoryReference: subject.value.task.repository,
        repositoryPath: subject.value.repositoryPath,
      });
      if (!prepared.ok) throw failure('preparation', prepared.error);

      context.cancellationSignal.throwIfAborted();
      context.heartbeat({ phase: 'bootstrap_harness' });
      const bootstrapped = await bootstrap.prepare(prepared.value);
      if (!bootstrapped.ok) throw failure('bootstrap', bootstrapped.error);

      const runtime = await prepareDockerRuntime(prepared.value);

      context.cancellationSignal.throwIfAborted();
      context.heartbeat({ phase: 'snapshot_planning_input' });
      const planningSnapshot = snapshots.createRunSnapshot(
        input.taskReference,
        input.workflowHash,
        {
          workspaceId: prepared.value.workspaceId,
          reference: prepared.value.repository.reference,
          path: prepared.value.path,
        },
      );
      if (!planningSnapshot.ok) {
        throw failure('planning snapshot', planningSnapshot.error);
      }

      return PrepareTaskWorkspaceResultSchema.parse({
        workspace: prepared.value,
        bootstrap: bootstrapped.value,
        runtime,
        planningSnapshot: planningSnapshot.value,
      });
    },
    prepareTaskDockerRuntime: async (inputValue) => {
      const input = PrepareTaskDockerRuntimeInputSchema.parse(inputValue);
      return PrepareTaskDockerRuntimeResultSchema.parse(
        await prepareDockerRuntime(input.workspace),
      );
    },
  };
};
