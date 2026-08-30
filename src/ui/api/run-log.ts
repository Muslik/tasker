import { queryOptions } from '@tanstack/react-query';

import {
  OperatorExecutionAttemptSchema,
  OperatorRunLogResponseSchema,
  type OperatorExecutionAttempt,
  type OperatorRunLogResponse,
} from '../../control-plane/operator-contracts.js';
import { getOptionalJson } from './http.js';
import { operatorQueryKeys } from './query.js';

export interface TaskExecutionAttemptIdentity {
  readonly nodeId: string;
  readonly blockRun: number;
}

export const fetchTaskRunLog = async (
  taskReference: string,
): Promise<OperatorRunLogResponse | null> =>
  getOptionalJson(
    `/api/operator/tasks/${encodeURIComponent(taskReference)}/run-log`,
    OperatorRunLogResponseSchema,
  );

export const taskRunLogQueryOptions = (taskReference: string) =>
  queryOptions({
    queryKey: operatorQueryKeys.runLog(taskReference),
    queryFn: () => fetchTaskRunLog(taskReference),
  });

export const fetchTaskExecutionAttempt = async (
  taskReference: string,
  identity: TaskExecutionAttemptIdentity,
): Promise<OperatorExecutionAttempt | null> =>
  getOptionalJson(
    `/api/operator/tasks/${encodeURIComponent(taskReference)}/execution-attempts/${encodeURIComponent(identity.nodeId)}/${encodeURIComponent(String(identity.blockRun))}`,
    OperatorExecutionAttemptSchema,
  );

export const taskExecutionAttemptQueryOptions = (
  taskReference: string,
  identity: TaskExecutionAttemptIdentity,
) =>
  queryOptions({
    queryKey: operatorQueryKeys.attempt(taskReference, identity.nodeId, identity.blockRun),
    queryFn: () => fetchTaskExecutionAttempt(taskReference, identity),
  });
