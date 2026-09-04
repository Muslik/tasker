import {
  WorkflowNotFoundError,
  type Client,
  type WorkflowExecutionStatusName,
  type WorkflowHandle,
} from '@temporalio/client';
import { err, ok, type Outcome } from '../shared/outcome.js';

export const temporalErrorMessage = (error: unknown): string => {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.length === 0 ? 'Temporal request failed' : messages.join(': ');
};

export const causedBy = (error: unknown, constructor: { readonly name: string }): boolean => {
  let current = error;
  while (current instanceof Error) {
    if (current.name === constructor.name) return true;
    current = current.cause;
  }
  return false;
};

export const readWorkflowExecutionStatus = async (
  client: Client,
  handle: WorkflowHandle,
  timeoutMs: number,
): Promise<
  Outcome<
    WorkflowExecutionStatusName | null,
    { readonly kind: 'runtime_unavailable'; readonly message: string }
  >
> => {
  try {
    const description = await client.withDeadline(Date.now() + timeoutMs, () => handle.describe());
    return ok(description.status.name);
  } catch (error) {
    return causedBy(error, WorkflowNotFoundError)
      ? ok(null)
      : err({ kind: 'runtime_unavailable', message: temporalErrorMessage(error) });
  }
};
