import type {
  IntegrationStepAdapter,
  IntegrationStepExecutionRequest,
  IntegrationStepExecutionResult,
} from './execution.js';

export type ExternalEffectTaskAuthorization =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'allowlist'; readonly taskReferences: ReadonlySet<string> };

export const loadExternalEffectTaskAuthorization = (
  enabled: boolean,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ExternalEffectTaskAuthorization => {
  if (!enabled) return { kind: 'disabled' };

  const taskReferences = [
    ...new Set(
      (environment.TASKER_EXTERNAL_EFFECT_TASKS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ];
  if (taskReferences.length === 0) {
    throw new Error(
      'TASKER_EXTERNAL_EFFECT_TASKS must list the exact task references allowed to mutate external systems',
    );
  }

  return { kind: 'allowlist', taskReferences: new Set(taskReferences) };
};

export class TaskScopedIntegrationAdapter implements IntegrationStepAdapter {
  public readonly id: string;

  public constructor(
    private readonly delegate: IntegrationStepAdapter,
    private readonly taskReferences: ReadonlySet<string>,
  ) {
    if (taskReferences.size === 0) {
      throw new Error('A task-scoped integration adapter requires at least one task reference');
    }
    this.id = delegate.id;
  }

  public execute(
    request: IntegrationStepExecutionRequest,
  ): Promise<IntegrationStepExecutionResult> {
    if (!this.taskReferences.has(request.taskReference)) {
      return Promise.resolve({
        status: 'blocked',
        kind: 'configuration',
        summary: `External effects through ${this.id} are not authorized for ${request.taskReference}`,
        details: {
          kind: 'task_not_authorized',
          adapter: this.id,
          taskReference: request.taskReference,
        },
        artifactIds: [],
      });
    }

    return this.delegate.execute(request);
  }
}
