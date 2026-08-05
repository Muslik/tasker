import { createHash } from 'node:crypto';

import {
  WorkflowExecutionAlreadyStartedError,
  type Client,
  type WorkflowHandle,
} from '@temporalio/client';

import { err, ok } from '../shared/outcome.js';
import {
  TASK_WORKFLOW_SCHEMA_VERSION,
  TaskBootstrapWorkflowInputSchema,
  TaskDraftAssemblyResultSchema,
} from '../temporal/contracts.js';
import { taskBootstrapWorkflow } from '../temporal/workflows/task-bootstrap-workflow.js';
import type { TemporalClientConfiguration } from '../temporal/client.js';
import type { M1WorkflowService } from './m1-service.js';
import type { WorkflowGenerationResult, WorkflowGenerator } from './workflow-generator.js';

const bootstrapWorkflowIdFor = (taskReference: string, attemptKey: string): string =>
  `tasker:bootstrap:${taskReference}:${attemptKey}`;

const bootstrapAttemptKey = (persistedAt: string | null): string =>
  persistedAt === null
    ? 'initial'
    : createHash('sha256').update(persistedAt).digest('hex').slice(0, 16);

const messageFrom = (error: unknown): string => {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.length === 0 ? 'Temporal workflow bootstrap failed' : messages.join(': ');
};

export class TemporalWorkflowGenerator implements WorkflowGenerator {
  public constructor(
    private readonly client: Client,
    private readonly configuration: TemporalClientConfiguration,
    private readonly workflows: Pick<M1WorkflowService, 'read'>,
  ) {}

  public async generate(taskReference: string): Promise<WorkflowGenerationResult> {
    const existing = this.workflows.read(taskReference);
    if (!existing.ok) return existing;
    if (existing.value?.status === 'ready') return ok(existing.value);
    const workflowId = bootstrapWorkflowIdFor(
      taskReference,
      bootstrapAttemptKey(existing.value?.view.persistedAt ?? null),
    );
    const input = TaskBootstrapWorkflowInputSchema.parse({
      schemaVersion: TASK_WORKFLOW_SCHEMA_VERSION,
      taskReference,
    });

    try {
      let handle: WorkflowHandle<typeof taskBootstrapWorkflow>;
      try {
        handle = await this.client.workflow.start(taskBootstrapWorkflow, {
          workflowId,
          workflowIdReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY',
          taskQueue: this.configuration.taskQueue,
          args: [input],
          memo: {
            taskerBootstrap: {
              schemaVersion: TASK_WORKFLOW_SCHEMA_VERSION,
              taskReference,
            },
          },
        });
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
        handle = this.client.workflow.getHandle(workflowId);
      }

      TaskDraftAssemblyResultSchema.parse(await handle.result());
      const persisted = this.workflows.read(taskReference);
      if (!persisted.ok) return persisted;
      return persisted.value === null
        ? err({
            kind: 'generation_runtime_unavailable',
            message: `Temporal completed draft assembly for ${taskReference}, but no draft was persisted`,
          })
        : { ok: true, value: persisted.value };
    } catch (error) {
      return err({
        kind: 'generation_runtime_unavailable',
        message: messageFrom(error),
      });
    }
  }
}
