import { queryOptions } from '@tanstack/react-query';

import {
  OperatorTaskInvocationDetailSchema,
  OperatorTaskInvocationListResponseSchema,
  type OperatorTaskInvocationDetail,
  type OperatorTaskInvocationListResponse,
} from '../../server/operator-contracts.js';
import { getJson, getOptionalJson } from './http.js';
import { operatorQueryKeys } from './query.js';

export const fetchTaskInvocations = async (
  taskReference: string,
): Promise<OperatorTaskInvocationListResponse> =>
  getJson(
    `/api/operator/tasks/${encodeURIComponent(taskReference)}/invocations`,
    OperatorTaskInvocationListResponseSchema,
  );

export const taskInvocationsQueryOptions = (taskReference: string) =>
  queryOptions({
    queryKey: operatorQueryKeys.invocations(taskReference),
    queryFn: () => fetchTaskInvocations(taskReference),
  });

export const fetchTaskInvocation = async (
  taskReference: string,
  invocationId: string,
): Promise<OperatorTaskInvocationDetail | null> =>
  getOptionalJson(
    `/api/operator/tasks/${encodeURIComponent(taskReference)}/invocations/${encodeURIComponent(invocationId)}`,
    OperatorTaskInvocationDetailSchema,
  );

export const taskInvocationQueryOptions = (taskReference: string, invocationId: string) =>
  queryOptions({
    queryKey: operatorQueryKeys.invocation(taskReference, invocationId),
    queryFn: () => fetchTaskInvocation(taskReference, invocationId),
  });
