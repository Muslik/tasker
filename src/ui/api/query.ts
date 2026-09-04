import { type QueryClient } from '@tanstack/react-query';

export const operatorQueryKeys = {
  all: () => ['operator'] as const,
  taskList: () => [...operatorQueryKeys.all(), 'task-list'] as const,
  task: (taskReference: string) => [...operatorQueryKeys.all(), 'task', taskReference] as const,
  projection: (taskReference: string) =>
    [...operatorQueryKeys.task(taskReference), 'projection'] as const,
  activity: (taskReference: string) =>
    [...operatorQueryKeys.task(taskReference), 'activity'] as const,
  runLog: (taskReference: string) => [...operatorQueryKeys.task(taskReference), 'run-log'] as const,
  attempts: (taskReference: string) =>
    [...operatorQueryKeys.task(taskReference), 'attempts'] as const,
  attempt: (taskReference: string, nodeId: string, blockRun: number) =>
    [...operatorQueryKeys.attempts(taskReference), nodeId, blockRun] as const,
  currentRun: (taskReference: string) =>
    [...operatorQueryKeys.task(taskReference), 'current-run'] as const,
  invocations: (taskReference: string) =>
    [...operatorQueryKeys.task(taskReference), 'invocations'] as const,
  implementationPlan: (taskReference: string) =>
    [...operatorQueryKeys.task(taskReference), 'implementation-plan'] as const,
  planReviews: (taskReference: string) =>
    [...operatorQueryKeys.task(taskReference), 'plan-reviews'] as const,
  planningTranscript: (taskReference: string) =>
    [...operatorQueryKeys.task(taskReference), 'planning-transcript'] as const,
  retrospective: (taskReference: string) =>
    [...operatorQueryKeys.task(taskReference), 'retrospective'] as const,
  retrospectivePatterns: () => [...operatorQueryKeys.all(), 'retrospective-patterns'] as const,
  jiraIssue: (issueKey: string) => [...operatorQueryKeys.all(), 'jira', issueKey] as const,
  jiraProduct: (issueKey: string) =>
    [...operatorQueryKeys.all(), 'jira-product', issueKey] as const,
  repositories: () => [...operatorQueryKeys.all(), 'repositories'] as const,
  invocation: (taskReference: string, invocationId: string) =>
    ['invocation', taskReference, invocationId] as const,
} as const;

export interface InvalidateTaskQueriesOptions {
  readonly includeRunLog?: boolean;
  readonly includeAttempts?: boolean;
  readonly includeInvocations?: boolean;
}

const invalidate = (queryClient: QueryClient, queryKey: readonly unknown[]): void => {
  void queryClient.invalidateQueries({ queryKey });
};

export const invalidateTaskQueries = (
  queryClient: QueryClient,
  taskReference: string,
  options: InvalidateTaskQueriesOptions = {},
): void => {
  invalidate(queryClient, operatorQueryKeys.taskList());
  invalidate(queryClient, operatorQueryKeys.projection(taskReference));
  invalidate(queryClient, operatorQueryKeys.activity(taskReference));
  invalidate(queryClient, operatorQueryKeys.currentRun(taskReference));
  invalidate(queryClient, operatorQueryKeys.implementationPlan(taskReference));
  invalidate(queryClient, operatorQueryKeys.planReviews(taskReference));
  invalidate(queryClient, operatorQueryKeys.planningTranscript(taskReference));
  invalidate(queryClient, operatorQueryKeys.retrospective(taskReference));

  if (options.includeRunLog === true) {
    invalidate(queryClient, operatorQueryKeys.runLog(taskReference));
  }

  if (options.includeAttempts === true) {
    invalidate(queryClient, operatorQueryKeys.attempts(taskReference));
  }

  if (options.includeInvocations === true) {
    invalidate(queryClient, operatorQueryKeys.invocations(taskReference));
  }
};
