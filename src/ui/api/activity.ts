import { queryOptions } from '@tanstack/react-query';

import {
  OperatorActivityResponseSchema,
  type OperatorActivityResponse,
} from '../../control-plane/operator-contracts.js';
import { getJson } from './http.js';
import { operatorQueryKeys } from './query.js';

export const fetchTaskActivity = async (taskReference: string): Promise<OperatorActivityResponse> =>
  getJson(
    `/api/operator/tasks/${encodeURIComponent(taskReference)}/activity`,
    OperatorActivityResponseSchema,
  );

export const taskActivityQueryOptions = (taskReference: string) =>
  queryOptions({
    queryKey: operatorQueryKeys.activity(taskReference),
    queryFn: () => fetchTaskActivity(taskReference),
  });
