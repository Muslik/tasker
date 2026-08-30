import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  type Client,
  type WorkflowHandle,
} from '@temporalio/client';

import { err, ok, type Outcome } from '../../shared/outcome.js';
import {
  ExecutionWorkflowInputSchema,
  ExecutionWorkflowPublicStateSchema,
  ResolveExecutionWaitCommandSchema,
  type ExecutionWorkflowInput,
  type ExecutionWorkflowPublicState,
  type ResolveExecutionWaitCommand,
} from './contracts.js';
import { executionWorkflowStateQuery, resolveExecutionWaitUpdate } from './messages.js';
import { executionWorkflowV2 } from '../workflows/execution-workflow-v2.js';

export type ExecutionTemporalRunError =
  | { readonly kind: 'run_not_found'; readonly workflowId: string }
  | { readonly kind: 'run_input_conflict'; readonly workflowId: string }
  | { readonly kind: 'runtime_unavailable'; readonly message: string };

export interface ExecutionTemporalRunService {
  start(
    workflowId: string,
    input: ExecutionWorkflowInput,
  ): Promise<Outcome<ExecutionWorkflowPublicState, ExecutionTemporalRunError>>;
  read(
    workflowId: string,
  ): Promise<Outcome<ExecutionWorkflowPublicState | null, ExecutionTemporalRunError>>;
  resolveWait(
    workflowId: string,
    command: ResolveExecutionWaitCommand,
  ): Promise<Outcome<ExecutionWorkflowPublicState, ExecutionTemporalRunError>>;
}

export interface ExecutionTemporalClientConfiguration {
  readonly taskQueue: string;
  readonly queryTimeoutMs: number;
  readonly updateTimeoutMs: number;
}

export const TASKER_EXECUTION_V2_TASK_QUEUE = 'tasker-execution-v2';

export const DEFAULT_EXECUTION_TEMPORAL_CLIENT_CONFIGURATION = {
  taskQueue: TASKER_EXECUTION_V2_TASK_QUEUE,
  queryTimeoutMs: 2_000,
  updateTimeoutMs: 10_000,
} as const satisfies ExecutionTemporalClientConfiguration;

const messageFrom = (error: unknown): string => {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.length === 0 ? 'Temporal request failed' : messages.join(': ');
};

export class TemporalExecutionRunService implements ExecutionTemporalRunService {
  public constructor(
    private readonly client: Client,
    private readonly configuration: ExecutionTemporalClientConfiguration = DEFAULT_EXECUTION_TEMPORAL_CLIENT_CONFIGURATION,
  ) {}

  public async start(
    workflowId: string,
    inputValue: ExecutionWorkflowInput,
  ): Promise<Outcome<ExecutionWorkflowPublicState, ExecutionTemporalRunError>> {
    const input = ExecutionWorkflowInputSchema.parse(inputValue);
    try {
      const handle = await this.client.workflow.start(executionWorkflowV2, {
        workflowId,
        taskQueue: this.configuration.taskQueue,
        args: [input],
        memo: {
          taskerExecution: {
            schemaVersion: input.schemaVersion,
            taskReference: input.taskReference,
            workflowHash: input.workflowHash,
          },
        },
      });
      return ok(await this.readHandle(handle));
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
        return err({ kind: 'runtime_unavailable', message: messageFrom(error) });
      }
      const existing = await this.read(workflowId);
      if (!existing.ok || existing.value === null) {
        return existing.ok ? err({ kind: 'run_not_found', workflowId }) : existing;
      }
      return existing.value.workflowHash === input.workflowHash
        ? ok(existing.value)
        : err({ kind: 'run_input_conflict', workflowId });
    }
  }

  public async read(
    workflowId: string,
  ): Promise<Outcome<ExecutionWorkflowPublicState | null, ExecutionTemporalRunError>> {
    const handle = this.client.workflow.getHandle<typeof executionWorkflowV2>(workflowId);
    try {
      return ok(await this.readHandle(handle));
    } catch (error) {
      return error instanceof WorkflowNotFoundError
        ? ok(null)
        : err({ kind: 'runtime_unavailable', message: messageFrom(error) });
    }
  }

  public async resolveWait(
    workflowId: string,
    commandValue: ResolveExecutionWaitCommand,
  ): Promise<Outcome<ExecutionWorkflowPublicState, ExecutionTemporalRunError>> {
    const command = ResolveExecutionWaitCommandSchema.parse(commandValue);
    const handle = this.client.workflow.getHandle<typeof executionWorkflowV2>(workflowId);
    try {
      await this.client.withDeadline(Date.now() + this.configuration.updateTimeoutMs, () =>
        handle.executeUpdate(resolveExecutionWaitUpdate, { args: [command] }),
      );
      return ok(await this.readHandle(handle));
    } catch (error) {
      return error instanceof WorkflowNotFoundError
        ? err({ kind: 'run_not_found', workflowId })
        : err({ kind: 'runtime_unavailable', message: messageFrom(error) });
    }
  }

  private async readHandle(
    handle: WorkflowHandle<typeof executionWorkflowV2>,
  ): Promise<ExecutionWorkflowPublicState> {
    return ExecutionWorkflowPublicStateSchema.parse(
      await this.client.withDeadline(Date.now() + this.configuration.queryTimeoutMs, () =>
        handle.query(executionWorkflowStateQuery),
      ),
    );
  }
}
