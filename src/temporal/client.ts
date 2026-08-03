import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  type WorkflowHandle,
} from '@temporalio/client';

import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  TASKER_TEMPORAL_TASK_QUEUE,
  TASK_WORKFLOW_SCHEMA_VERSION,
  ResolveTaskWaitCommandSchema,
  TaskWorkflowInputSchema,
  TaskWorkflowMemoSchema,
  TaskWorkflowPublicStateSchema,
  type ResolveTaskWaitCommand,
  type StartTaskWorkflowInput,
  type TaskWorkflowMemo,
  type TaskWorkflowPublicState,
} from './contracts.js';
import { resolveTaskWaitUpdate, taskWorkflowStateQuery } from './workflows/messages.js';
import { taskWorkflow } from './workflows/task-workflow.js';
import type { TemporalRunRegistry } from './run-registry.js';

export type TemporalRunError =
  | { readonly kind: 'run_not_found'; readonly taskReference: string }
  | { readonly kind: 'run_settings_conflict'; readonly taskReference: string }
  | { readonly kind: 'runtime_unavailable'; readonly message: string };

export interface TaskTemporalRunService {
  start(input: StartTaskWorkflowInput): Promise<Outcome<TaskWorkflowPublicState, TemporalRunError>>;
  read(taskReference: string): Promise<Outcome<TaskWorkflowPublicState | null, TemporalRunError>>;
  resolveWait(
    taskReference: string,
    command: ResolveTaskWaitCommand,
  ): Promise<Outcome<TaskWorkflowPublicState, TemporalRunError>>;
}

export interface TemporalClientConfiguration {
  readonly address: string;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly queryTimeoutMs: number;
  readonly updateTimeoutMs: number;
}

export const DEFAULT_TEMPORAL_CLIENT_CONFIGURATION = {
  address: '127.0.0.1:7233',
  namespace: 'tasker-dev',
  taskQueue: TASKER_TEMPORAL_TASK_QUEUE,
  queryTimeoutMs: 2_000,
  updateTimeoutMs: 10_000,
} as const satisfies TemporalClientConfiguration;

const workflowIdFor = (taskReference: string): string => `tasker:${taskReference}`;

const messageFrom = (error: unknown): string => {
  const messages: string[] = [];
  let current = error;

  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }

  return messages.length === 0 ? 'Temporal request failed' : messages.join(': ');
};

const unavailableState = (
  memo: TaskWorkflowMemo,
  workflowId: string,
  runId: string,
  temporalStatus: string,
  reason: string,
): TaskWorkflowPublicState =>
  TaskWorkflowPublicStateSchema.parse({
    ...memo,
    workflowId,
    runId,
    status: 'unavailable',
    currentNodeId: null,
    wait: null,
    outcome: null,
    reason,
    temporalStatus,
    executionContext: { status: 'unavailable' },
    planning: null,
    nodeStates: {},
    attempts: {},
  });

const memoFrom = (input: StartTaskWorkflowInput): TaskWorkflowMemo =>
  TaskWorkflowMemoSchema.parse({
    schemaVersion: TASK_WORKFLOW_SCHEMA_VERSION,
    taskReference: input.taskReference,
    workflowHash: input.workflowHash,
    settings: input.settings,
  });

export class TemporalTaskRunService implements TaskTemporalRunService {
  public constructor(
    private readonly client: Client,
    private readonly configuration: TemporalClientConfiguration = DEFAULT_TEMPORAL_CLIENT_CONFIGURATION,
    private readonly registry?: TemporalRunRegistry,
  ) {}

  public async start(
    input: StartTaskWorkflowInput,
  ): Promise<Outcome<TaskWorkflowPublicState, TemporalRunError>> {
    const workflowInput = TaskWorkflowInputSchema.parse({
      ...input,
      schemaVersion: TASK_WORKFLOW_SCHEMA_VERSION,
    });
    const memo = memoFrom(input);

    try {
      const handle = await this.client.workflow.start(taskWorkflow, {
        workflowId: workflowIdFor(input.taskReference),
        taskQueue: this.configuration.taskQueue,
        args: [workflowInput],
        memo: { tasker: memo },
      });

      return this.register(await this.readHandle(handle, memo, handle.firstExecutionRunId));
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        const existing = await this.read(input.taskReference);
        if (!existing.ok || existing.value === null) {
          return existing.ok
            ? err({ kind: 'run_not_found', taskReference: input.taskReference })
            : existing;
        }
        return existing.value.workflowHash === input.workflowHash &&
          existing.value.settings.planApproval === input.settings.planApproval &&
          existing.value.settings.planningStrategy === input.settings.planningStrategy
          ? this.register(existing.value)
          : err({ kind: 'run_settings_conflict', taskReference: input.taskReference });
      }

      return err({ kind: 'runtime_unavailable', message: messageFrom(error) });
    }
  }

  public async read(
    taskReference: string,
  ): Promise<Outcome<TaskWorkflowPublicState | null, TemporalRunError>> {
    const handle = this.client.workflow.getHandle(workflowIdFor(taskReference));

    try {
      const description = await this.client.withDeadline(
        Date.now() + this.configuration.queryTimeoutMs,
        () => handle.describe(),
      );
      const memo = TaskWorkflowMemoSchema.safeParse(description.memo?.tasker);
      if (!memo.success) {
        return err({
          kind: 'runtime_unavailable',
          message: `Temporal run ${taskReference} has no valid Tasker memo`,
        });
      }
      return ok(
        await this.readHandle(handle, memo.data, description.runId, description.status.name),
      );
    } catch (error) {
      return error instanceof WorkflowNotFoundError
        ? ok(null)
        : err({ kind: 'runtime_unavailable', message: messageFrom(error) });
    }
  }

  public async resolveWait(
    taskReference: string,
    commandInput: ResolveTaskWaitCommand,
  ): Promise<Outcome<TaskWorkflowPublicState, TemporalRunError>> {
    const command = ResolveTaskWaitCommandSchema.parse(commandInput);
    const handle = this.client.workflow.getHandle(workflowIdFor(taskReference));

    try {
      await this.client.withDeadline(Date.now() + this.configuration.updateTimeoutMs, () =>
        handle.executeUpdate(resolveTaskWaitUpdate, { args: [command] }),
      );
      const state = await this.read(taskReference);
      if (!state.ok) return state;
      return state.value === null ? err({ kind: 'run_not_found', taskReference }) : ok(state.value);
    } catch (error) {
      return error instanceof WorkflowNotFoundError
        ? err({ kind: 'run_not_found', taskReference })
        : err({ kind: 'runtime_unavailable', message: messageFrom(error) });
    }
  }

  private async readHandle(
    handle: WorkflowHandle<typeof taskWorkflow>,
    memo: TaskWorkflowMemo,
    runId: string,
    temporalStatus = 'RUNNING',
  ): Promise<TaskWorkflowPublicState> {
    try {
      return TaskWorkflowPublicStateSchema.parse(
        await this.client.withDeadline(Date.now() + this.configuration.queryTimeoutMs, () =>
          handle.query(taskWorkflowStateQuery),
        ),
      );
    } catch (error) {
      return unavailableState(
        memo,
        workflowIdFor(memo.taskReference),
        runId,
        temporalStatus,
        messageFrom(error),
      );
    }
  }

  private register(
    state: TaskWorkflowPublicState,
  ): Outcome<TaskWorkflowPublicState, TemporalRunError> {
    const registered = this.registry?.register(state);
    return registered === undefined || registered.ok
      ? ok(state)
      : err({ kind: 'runtime_unavailable', message: registered.error.message });
  }
}

export const connectTemporalTaskRunService = async (
  configuration: TemporalClientConfiguration = DEFAULT_TEMPORAL_CLIENT_CONFIGURATION,
  registry?: TemporalRunRegistry,
): Promise<{ readonly connection: Connection; readonly service: TemporalTaskRunService }> => {
  const connection = await Connection.connect({ address: configuration.address });
  return {
    connection,
    service: new TemporalTaskRunService(
      new Client({ connection, namespace: configuration.namespace }),
      configuration,
      registry,
    ),
  };
};
