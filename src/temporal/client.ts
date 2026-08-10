import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  type WorkflowHandle,
} from '@temporalio/client';
import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  BootstrapWorkflowInputSchema,
  BootstrapWorkflowPublicStateSchema,
  ResolveBootstrapWaitCommandSchema,
  type BootstrapWorkflowInput,
  type BootstrapWorkflowPublicState,
  type ResolveBootstrapWaitCommand,
} from './bootstrap-kernel/contracts.js';
import {
  bootstrapWorkflowStateQuery,
  resolveBootstrapWaitUpdate,
} from './bootstrap-kernel/messages.js';
import {
  ExecutionWorkflowPublicStateSchema,
  ResolveExecutionWaitCommandSchema,
  type ExecutionWorkflowPublicState,
} from './execution-kernel/contracts.js';
import {
  executionWorkflowStateQuery,
  resolveExecutionWaitUpdate,
} from './execution-kernel/messages.js';
import { bootstrapWorkflowV3 } from './workflows/bootstrap-workflow-v3.js';
import type { executionWorkflowV2 } from './workflows/execution-workflow-v2.js';
import {
  TaskRunLifecycleSchema,
  type TaskRunLifecycle,
  type TaskRunPublicState,
} from './public-state.js';
export type TaskRunError =
  | { readonly kind: 'run_not_found'; readonly taskReference: string }
  | { readonly kind: 'run_input_conflict'; readonly taskReference: string }
  | { readonly kind: 'runtime_unavailable'; readonly message: string };

export interface TaskRunService {
  start(input: BootstrapWorkflowInput): Promise<Outcome<TaskRunPublicState, TaskRunError>>;
  read(taskReference: string): Promise<Outcome<TaskRunPublicState | null, TaskRunError>>;
  readLifecycle(taskReference: string): Promise<Outcome<TaskRunLifecycle | null, TaskRunError>>;
  resolveWait(
    taskReference: string,
    command: ResolveBootstrapWaitCommand,
  ): Promise<Outcome<TaskRunPublicState, TaskRunError>>;
}

export interface TemporalClientConfiguration {
  readonly address: string;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly queryTimeoutMs: number;
  readonly updateTimeoutMs: number;
}

export const TASKER_TEMPORAL_TASK_QUEUE = 'tasker-v3';

export const DEFAULT_TEMPORAL_CLIENT_CONFIGURATION = {
  address: '127.0.0.1:7233',
  namespace: 'tasker-dev',
  taskQueue: TASKER_TEMPORAL_TASK_QUEUE,
  queryTimeoutMs: 2_000,
  updateTimeoutMs: 10_000,
} as const satisfies TemporalClientConfiguration;

const bootstrapWorkflowIdFor = (taskReference: string): string => `tasker:v3:${taskReference}`;

const messageFrom = (error: unknown): string => {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.length === 0 ? 'Temporal request failed' : messages.join(': ');
};

const causedBy = (error: unknown, constructor: { readonly name: string }): boolean => {
  let current = error;
  while (current instanceof Error) {
    if (current.name === constructor.name) return true;
    current = current.cause;
  }
  return false;
};

const sameImmutableInput = (
  state: BootstrapWorkflowPublicState,
  input: BootstrapWorkflowInput,
): boolean =>
  state.settings.planReview === input.settings.planReview &&
  state.settings.planningStrategy === input.settings.planningStrategy &&
  state.settings.executionStart === input.settings.executionStart;

export class TemporalTaskRunService implements TaskRunService {
  public constructor(
    private readonly client: Client,
    private readonly configuration: TemporalClientConfiguration = DEFAULT_TEMPORAL_CLIENT_CONFIGURATION,
  ) {}

  public async start(
    inputValue: BootstrapWorkflowInput,
  ): Promise<Outcome<TaskRunPublicState, TaskRunError>> {
    const input = BootstrapWorkflowInputSchema.parse(inputValue);
    try {
      await this.client.workflow.start(bootstrapWorkflowV3, {
        workflowId: bootstrapWorkflowIdFor(input.taskReference),
        taskQueue: this.configuration.taskQueue,
        args: [input],
        memo: {
          tasker: {
            schemaVersion: input.schemaVersion,
            taskReference: input.taskReference,
            settings: input.settings,
          },
        },
      });
      const started = await this.read(input.taskReference);
      return started.ok && started.value !== null
        ? ok(started.value)
        : started.ok
          ? err({ kind: 'run_not_found', taskReference: input.taskReference })
          : started;
    } catch (error) {
      if (!causedBy(error, WorkflowExecutionAlreadyStartedError)) {
        return err({ kind: 'runtime_unavailable', message: messageFrom(error) });
      }
      const bootstrap = await this.readBootstrap(input.taskReference);
      if (!bootstrap.ok || bootstrap.value === null) {
        return bootstrap.ok
          ? err({ kind: 'run_not_found', taskReference: input.taskReference })
          : bootstrap;
      }
      if (!sameImmutableInput(bootstrap.value, input)) {
        return err({ kind: 'run_input_conflict', taskReference: input.taskReference });
      }
      const current = await this.read(input.taskReference);
      return current.ok && current.value !== null
        ? ok(current.value)
        : current.ok
          ? err({ kind: 'run_not_found', taskReference: input.taskReference })
          : current;
    }
  }

  public async read(
    taskReference: string,
  ): Promise<Outcome<TaskRunPublicState | null, TaskRunError>> {
    const lifecycle = await this.readLifecycle(taskReference);
    if (!lifecycle.ok) return err(lifecycle.error);
    if (lifecycle.value === null) return ok(null);
    return ok(lifecycle.value.execution ?? lifecycle.value.bootstrap);
  }

  public async readLifecycle(
    taskReference: string,
  ): Promise<Outcome<TaskRunLifecycle | null, TaskRunError>> {
    const bootstrap = await this.readBootstrap(taskReference);
    if (!bootstrap.ok) return err(bootstrap.error);
    if (bootstrap.value === null) return ok(null);
    if (bootstrap.value.executionWorkflowId === null) {
      return ok(TaskRunLifecycleSchema.parse({ bootstrap: bootstrap.value, execution: null }));
    }
    const execution = await this.readExecution(bootstrap.value.executionWorkflowId);
    return execution.ok
      ? ok(TaskRunLifecycleSchema.parse({ bootstrap: bootstrap.value, execution: execution.value }))
      : execution;
  }

  public async resolveWait(
    taskReference: string,
    commandValue: ResolveBootstrapWaitCommand,
  ): Promise<Outcome<TaskRunPublicState, TaskRunError>> {
    const command = ResolveBootstrapWaitCommandSchema.parse(commandValue);
    const bootstrap = await this.readBootstrap(taskReference);
    if (!bootstrap.ok) return bootstrap;
    if (bootstrap.value === null) return err({ kind: 'run_not_found', taskReference });

    try {
      if (bootstrap.value.executionWorkflowId === null) {
        const handle = this.client.workflow.getHandle<typeof bootstrapWorkflowV3>(
          bootstrapWorkflowIdFor(taskReference),
        );
        await this.client.withDeadline(Date.now() + this.configuration.updateTimeoutMs, () =>
          handle.executeUpdate(resolveBootstrapWaitUpdate, { args: [command] }),
        );
      } else {
        const executionCommand = ResolveExecutionWaitCommandSchema.parse(command);
        const handle = this.client.workflow.getHandle<typeof executionWorkflowV2>(
          bootstrap.value.executionWorkflowId,
        );
        await this.client.withDeadline(Date.now() + this.configuration.updateTimeoutMs, () =>
          handle.executeUpdate(resolveExecutionWaitUpdate, { args: [executionCommand] }),
        );
      }
      const current = await this.read(taskReference);
      return current.ok && current.value !== null
        ? ok(current.value)
        : current.ok
          ? err({ kind: 'run_not_found', taskReference })
          : current;
    } catch (error) {
      return causedBy(error, WorkflowNotFoundError)
        ? err({ kind: 'run_not_found', taskReference })
        : err({ kind: 'runtime_unavailable', message: messageFrom(error) });
    }
  }

  private async readBootstrap(
    taskReference: string,
  ): Promise<Outcome<BootstrapWorkflowPublicState | null, TaskRunError>> {
    const handle = this.client.workflow.getHandle<typeof bootstrapWorkflowV3>(
      bootstrapWorkflowIdFor(taskReference),
    );
    try {
      return ok(
        BootstrapWorkflowPublicStateSchema.parse(
          await this.query(handle, bootstrapWorkflowStateQuery),
        ),
      );
    } catch (error) {
      return causedBy(error, WorkflowNotFoundError)
        ? ok(null)
        : err({ kind: 'runtime_unavailable', message: messageFrom(error) });
    }
  }

  private async readExecution(
    workflowId: string,
  ): Promise<Outcome<ExecutionWorkflowPublicState, TaskRunError>> {
    const handle = this.client.workflow.getHandle<typeof executionWorkflowV2>(workflowId);
    try {
      return ok(
        ExecutionWorkflowPublicStateSchema.parse(
          await this.query(handle, executionWorkflowStateQuery),
        ),
      );
    } catch (error) {
      return err({ kind: 'runtime_unavailable', message: messageFrom(error) });
    }
  }

  private query<Result>(handle: WorkflowHandle, query: unknown): Promise<Result> {
    return this.client.withDeadline(Date.now() + this.configuration.queryTimeoutMs, () =>
      handle.query(query as Parameters<typeof handle.query>[0]),
    ) as Promise<Result>;
  }
}

export const connectTemporalTaskRunService = async (
  configuration: TemporalClientConfiguration = DEFAULT_TEMPORAL_CLIENT_CONFIGURATION,
): Promise<{
  readonly client: Client;
  readonly connection: Connection;
  readonly service: TemporalTaskRunService;
}> => {
  const connection = await Connection.connect({ address: configuration.address });
  const client = new Client({ connection, namespace: configuration.namespace });
  return {
    client,
    connection,
    service: new TemporalTaskRunService(client, configuration),
  };
};
