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
} from '../kernel/bootstrap-kernel/contracts.js';
import {
  bootstrapWorkflowStateQuery,
  resolveBootstrapWaitUpdate,
} from '../kernel/bootstrap-kernel/messages.js';
import {
  ExecutionWorkflowPublicStateSchema,
  ResolveExecutionWaitCommandSchema,
  type ExecutionWorkflowPublicState,
} from '../kernel/execution-kernel/contracts.js';
import {
  executionWorkflowStateQuery,
  resolveExecutionWaitUpdate,
} from '../kernel/execution-kernel/messages.js';
import { bootstrapWorkflowV3 } from './workflows/bootstrap-workflow-v3.js';
import type { executionWorkflowV2 } from './workflows/execution-workflow-v2.js';
import {
  causedBy,
  readWorkflowExecutionStatus,
  temporalErrorMessage,
} from './temporal-client-support.js';
import {
  TaskRunLifecycleSchema,
  type TaskRunLifecycle,
  type TaskRunPublicState,
} from '../steps/public-state.js';
export type TaskRunError =
  | { readonly kind: 'run_not_found'; readonly taskReference: string }
  | { readonly kind: 'run_not_active'; readonly taskReference: string; readonly runId: string }
  | { readonly kind: 'run_input_conflict'; readonly taskReference: string }
  | { readonly kind: 'run_not_restartable'; readonly taskReference: string }
  | {
      readonly kind: 'stale_run';
      readonly taskReference: string;
      readonly providedRunId: string;
      readonly activeRunId: string;
    }
  | { readonly kind: 'runtime_unavailable'; readonly message: string };

export interface TaskRunService {
  start(input: BootstrapWorkflowInput): Promise<Outcome<TaskRunPublicState, TaskRunError>>;
  read(taskReference: string): Promise<Outcome<TaskRunPublicState | null, TaskRunError>>;
  readLifecycle(taskReference: string): Promise<Outcome<TaskRunLifecycle | null, TaskRunError>>;
  restart(
    taskReference: string,
    expectedRunId: string,
  ): Promise<Outcome<TaskRunPublicState, TaskRunError>>;
  terminate(taskReference: string): Promise<Outcome<void, TaskRunError>>;
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

const sameImmutableInput = (
  state: BootstrapWorkflowPublicState,
  input: BootstrapWorkflowInput,
): boolean =>
  state.settings.planReview === input.settings.planReview &&
  state.settings.planningStrategy === input.settings.planningStrategy &&
  state.settings.trackerStatusUpdates === input.settings.trackerStatusUpdates &&
  state.settings.branchName === input.settings.branchName &&
  state.settings.operatorBrief === input.settings.operatorBrief;

export class TemporalTaskRunService implements TaskRunService {
  public constructor(
    private readonly client: Client,
    private readonly configuration: TemporalClientConfiguration = DEFAULT_TEMPORAL_CLIENT_CONFIGURATION,
  ) {}

  public async start(
    inputValue: BootstrapWorkflowInput,
  ): Promise<Outcome<TaskRunPublicState, TaskRunError>> {
    const input = BootstrapWorkflowInputSchema.parse(inputValue);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await this.launch(input);
        const started = await this.readByBootstrapRun(
          input.taskReference,
          handle.firstExecutionRunId,
        );
        return started.ok && started.value !== null
          ? ok(started.value)
          : started.ok
            ? err({ kind: 'run_not_found', taskReference: input.taskReference })
            : started;
      } catch (error) {
        if (!causedBy(error, WorkflowExecutionAlreadyStartedError)) {
          return err({ kind: 'runtime_unavailable', message: temporalErrorMessage(error) });
        }
        const status = await this.describeWorkflowStatus(
          this.client.workflow.getHandle(bootstrapWorkflowIdFor(input.taskReference)),
        );
        if (!status.ok) return err(status.error);
        if (status.value !== 'RUNNING') continue;
        const bootstrap = await this.readBootstrap(input.taskReference);
        if (!bootstrap.ok) return err(bootstrap.error);
        if (bootstrap.value === null) continue;
        if (!sameImmutableInput(bootstrap.value, input)) {
          return err({ kind: 'run_input_conflict', taskReference: input.taskReference });
        }
        const current = await this.read(input.taskReference);
        if (!current.ok) return err(current.error);
        if (current.value === null) continue;
        return ok(current.value);
      }
    }
    return err({
      kind: 'runtime_unavailable',
      message: 'Temporal request failed: workflow closed while retrying start',
    });
  }

  public async restart(
    taskReference: string,
    expectedRunId: string,
  ): Promise<Outcome<TaskRunPublicState, TaskRunError>> {
    const lifecycle = await this.readLifecycle(taskReference);
    if (!lifecycle.ok) return err(lifecycle.error);
    if (lifecycle.value === null) return err({ kind: 'run_not_found', taskReference });
    const active = lifecycle.value.execution ?? lifecycle.value.bootstrap;
    const activeRunId = active.runId;
    if (expectedRunId !== activeRunId) {
      return err({ kind: 'stale_run', taskReference, providedRunId: expectedRunId, activeRunId });
    }
    if (active.status === 'completed') {
      return err({ kind: 'run_not_restartable', taskReference });
    }

    const input = BootstrapWorkflowInputSchema.parse({
      schemaVersion: 3,
      taskReference,
      settings: lifecycle.value.bootstrap.settings,
    });

    try {
      const handle = await this.launch(input, 'TERMINATE_EXISTING');
      const started = await this.readByBootstrapRun(taskReference, handle.firstExecutionRunId);
      return started.ok && started.value !== null
        ? ok(started.value)
        : started.ok
          ? err({ kind: 'run_not_found', taskReference })
          : started;
    } catch (error) {
      return causedBy(error, WorkflowNotFoundError)
        ? err({ kind: 'run_not_found', taskReference })
        : err({ kind: 'runtime_unavailable', message: temporalErrorMessage(error) });
    }
  }

  public async terminate(taskReference: string): Promise<Outcome<void, TaskRunError>> {
    const lifecycle = await this.readLifecycle(taskReference);
    if (!lifecycle.ok) return err(lifecycle.error);
    if (lifecycle.value === null) return ok(undefined);
    const active = lifecycle.value.execution ?? lifecycle.value.bootstrap;
    if (active.status === 'completed') return ok(undefined);
    try {
      await this.client.workflow
        .getHandle(bootstrapWorkflowIdFor(taskReference), lifecycle.value.bootstrap.runId)
        .terminate('Removed from Tasker by the operator');
      return ok(undefined);
    } catch (error) {
      return causedBy(error, WorkflowNotFoundError)
        ? ok(undefined)
        : err({ kind: 'runtime_unavailable', message: temporalErrorMessage(error) });
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
    if (!execution.ok) return execution;
    if (execution.value === null) return ok(null);
    return ok(
      TaskRunLifecycleSchema.parse({ bootstrap: bootstrap.value, execution: execution.value }),
    );
  }

  private async readByBootstrapRun(
    taskReference: string,
    runId: string,
  ): Promise<Outcome<TaskRunPublicState | null, TaskRunError>> {
    const bootstrap = await this.readBootstrap(taskReference, runId);
    if (!bootstrap.ok || bootstrap.value === null) return bootstrap;
    if (bootstrap.value.executionWorkflowId === null) return ok(bootstrap.value);
    return this.readExecution(bootstrap.value.executionWorkflowId);
  }

  private launch(input: BootstrapWorkflowInput, workflowIdConflictPolicy?: 'TERMINATE_EXISTING') {
    return this.client.workflow.start(bootstrapWorkflowV3, {
      workflowId: bootstrapWorkflowIdFor(input.taskReference),
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      ...(workflowIdConflictPolicy === undefined ? {} : { workflowIdConflictPolicy }),
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
  }

  public async resolveWait(
    taskReference: string,
    commandValue: ResolveBootstrapWaitCommand,
  ): Promise<Outcome<TaskRunPublicState, TaskRunError>> {
    const command = ResolveBootstrapWaitCommandSchema.parse(commandValue);
    const lifecycle = await this.readLifecycle(taskReference);
    if (!lifecycle.ok) return err(lifecycle.error);
    if (lifecycle.value === null) {
      const status = await this.describeWorkflowStatus(
        this.client.workflow.getHandle(bootstrapWorkflowIdFor(taskReference), command.runId),
      );
      if (!status.ok) return err(status.error);
      return status.value === null
        ? err({ kind: 'run_not_found', taskReference })
        : err({ kind: 'run_not_active', taskReference, runId: command.runId });
    }
    const activeRunId = (lifecycle.value.execution ?? lifecycle.value.bootstrap).runId;
    if (command.runId !== activeRunId) {
      const status = await this.describeWorkflowStatus(
        this.client.workflow.getHandle(bootstrapWorkflowIdFor(taskReference), command.runId),
      );
      if (!status.ok) return err(status.error);
      if (status.value !== null && status.value !== 'RUNNING') {
        return err({ kind: 'run_not_active', taskReference, runId: command.runId });
      }
      return err({
        kind: 'stale_run',
        taskReference,
        providedRunId: command.runId,
        activeRunId,
      });
    }
    const targetWorkflowId =
      lifecycle.value.execution?.workflowId ?? bootstrapWorkflowIdFor(taskReference);
    const targetRunId = (lifecycle.value.execution ?? lifecycle.value.bootstrap).runId;

    try {
      if (lifecycle.value.execution === null) {
        const handle = this.client.workflow.getHandle<typeof bootstrapWorkflowV3>(
          targetWorkflowId,
          targetRunId,
        );
        await this.client.withDeadline(Date.now() + this.configuration.updateTimeoutMs, () =>
          handle.executeUpdate(resolveBootstrapWaitUpdate, { args: [command] }),
        );
      } else {
        const executionCommand = ResolveExecutionWaitCommandSchema.parse(command);
        const handle = this.client.workflow.getHandle<typeof executionWorkflowV2>(
          targetWorkflowId,
          targetRunId,
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
      const status = await this.describeWorkflowStatus(
        this.client.workflow.getHandle(targetWorkflowId, targetRunId),
      );
      if (!status.ok) return err(status.error);
      if (status.value === null) return err({ kind: 'run_not_found', taskReference });
      if (status.value !== 'RUNNING') {
        return err({ kind: 'run_not_active', taskReference, runId: targetRunId });
      }
      return causedBy(error, WorkflowNotFoundError)
        ? err({ kind: 'run_not_found', taskReference })
        : err({ kind: 'runtime_unavailable', message: temporalErrorMessage(error) });
    }
  }

  private async readBootstrap(
    taskReference: string,
    runId?: string,
  ): Promise<Outcome<BootstrapWorkflowPublicState | null, TaskRunError>> {
    const handle = this.client.workflow.getHandle<typeof bootstrapWorkflowV3>(
      bootstrapWorkflowIdFor(taskReference),
      runId,
    );
    return this.readWorkflowState(handle, bootstrapWorkflowStateQuery, (value) =>
      BootstrapWorkflowPublicStateSchema.parse(value),
    );
  }

  private async readExecution(
    workflowId: string,
  ): Promise<Outcome<ExecutionWorkflowPublicState | null, TaskRunError>> {
    const handle = this.client.workflow.getHandle<typeof executionWorkflowV2>(workflowId);
    return this.readWorkflowState(handle, executionWorkflowStateQuery, (value) =>
      ExecutionWorkflowPublicStateSchema.parse(value),
    );
  }

  private async readWorkflowState<
    State extends { readonly workflowId: string; readonly runId: string; readonly status: string },
  >(
    handle: WorkflowHandle,
    query: unknown,
    parse: (value: unknown) => State,
  ): Promise<Outcome<State | null, TaskRunError>> {
    try {
      const state = parse(await this.query(handle, query));
      const status = await this.describeWorkflowStatus(
        this.client.workflow.getHandle(state.workflowId, state.runId),
      );
      if (!status.ok) return err(status.error);
      if (status.value === 'RUNNING') return ok(state);
      if (status.value === 'COMPLETED' && state.status === 'completed') return ok(state);
      return ok(null);
    } catch (error) {
      return causedBy(error, WorkflowNotFoundError)
        ? ok(null)
        : err({ kind: 'runtime_unavailable', message: temporalErrorMessage(error) });
    }
  }

  private describeWorkflowStatus(handle: WorkflowHandle) {
    return readWorkflowExecutionStatus(this.client, handle, this.configuration.queryTimeoutMs);
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
