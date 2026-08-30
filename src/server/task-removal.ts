import type { TaskRunError, TaskRunService } from '../kernel/index.js';
import type {
  DockerWorkspaceRuntimeError,
  DockerWorkspaceRuntimeManager,
  ManagedWorkspaceManager,
  WorkspacePreparationError,
  WorkspaceStore,
  WorkspaceStoreError,
} from '../workspace/index.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import type { TaskPresenceError, TaskPresenceStore } from './task-presence.js';

export type TaskRemovalError =
  | { readonly kind: 'temporal'; readonly error: TaskRunError }
  | { readonly kind: 'workspace_store'; readonly error: WorkspaceStoreError }
  | { readonly kind: 'docker'; readonly error: DockerWorkspaceRuntimeError }
  | { readonly kind: 'workspace'; readonly error: WorkspacePreparationError }
  | { readonly kind: 'presence'; readonly error: TaskPresenceError };

export class TaskRemovalService {
  public constructor(
    private readonly runs: Pick<TaskRunService, 'terminate'>,
    private readonly workspaces: Pick<WorkspaceStore, 'listByTaskReference'>,
    private readonly docker: Pick<DockerWorkspaceRuntimeManager, 'dispose'>,
    private readonly manager: Pick<ManagedWorkspaceManager, 'dispose'>,
    private readonly presence: TaskPresenceStore,
  ) {}

  public async remove(taskReference: string): Promise<Outcome<void, TaskRemovalError>> {
    const terminated = await this.runs.terminate(taskReference);
    if (!terminated.ok) return err({ kind: 'temporal', error: terminated.error });
    const workspaces = this.workspaces.listByTaskReference(taskReference);
    if (!workspaces.ok) return err({ kind: 'workspace_store', error: workspaces.error });
    for (const workspace of workspaces.value) {
      const dockerRemoved = await this.docker.dispose(workspace.workspaceId);
      if (!dockerRemoved.ok) return err({ kind: 'docker', error: dockerRemoved.error });
      const workspaceRemoved = await this.manager.dispose(workspace.workspaceId);
      if (!workspaceRemoved.ok) return err({ kind: 'workspace', error: workspaceRemoved.error });
    }
    const removed = this.presence.remove(taskReference);
    return removed.ok ? ok(undefined) : err({ kind: 'presence', error: removed.error });
  }
}
