import { queryOptions } from '@tanstack/react-query';

import {
  OperatorWorkflowProjectionSchema,
  type OperatorWorkflowProjection,
} from '../../control-plane/operator-contracts.js';
import { getJson } from './http.js';
import { operatorQueryKeys } from './query.js';

export const fetchTaskProjection = async (
  taskReference: string,
): Promise<OperatorWorkflowProjection> =>
  getJson(
    `/api/operator/tasks/${encodeURIComponent(taskReference)}/projection`,
    OperatorWorkflowProjectionSchema,
  );

export const taskProjectionQueryOptions = (taskReference: string) =>
  queryOptions({
    queryKey: operatorQueryKeys.projection(taskReference),
    queryFn: () => fetchTaskProjection(taskReference),
  });
