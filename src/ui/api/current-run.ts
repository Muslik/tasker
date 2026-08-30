import { queryOptions } from '@tanstack/react-query';

import { ExecutionRunViewSchema, type ExecutionRunView } from '../../server/operator-contracts.js';
import { getOptionalJson } from './http.js';
import { operatorQueryKeys } from './query.js';

export const fetchTaskCurrentRun = async (
  taskReference: string,
): Promise<ExecutionRunView | null> =>
  getOptionalJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/run`,
    ExecutionRunViewSchema,
  );

export const taskCurrentRunQueryOptions = (taskReference: string) =>
  queryOptions({
    queryKey: operatorQueryKeys.currentRun(taskReference),
    queryFn: () => fetchTaskCurrentRun(taskReference),
  });
