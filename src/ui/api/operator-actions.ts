import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import {
  CodeReviewSyncResponseSchema,
  DependencyAvailableCommandSchema,
  DependencyDiscoveryCommandSchema,
  ExecutionRunViewSchema,
  ExpectedRunCommandSchema,
  PlanningClarificationSubmissionSchema,
  ResearchDocumentReviewCommandSchema,
  RestartRunCommandSchema,
  RunStartCommandSchema,
  WorkflowChangeReviewCommandSchema,
  type CodeReviewSyncResponse,
  type DependencyAvailableCommand,
  type DependencyDiscoveryCommand,
  type ExecutionRunView,
  type ExpectedRunCommand,
  type PlanningClarificationSubmission,
  type ResearchDocumentReviewCommand,
  type RestartRunCommand,
  type RunStartCommand,
  type WorkflowChangeReviewCommand,
} from '../../server/operator-contracts.js';
import {
  PlanReviewCommandSchema,
  PlanReviewHistoryResponseSchema,
  type PlanReviewCommand,
  type PlanReviewRound,
} from '../../server/plan-review.js';
import {
  ImplementationPlanningRecordSchema,
  type ImplementationPlanningRecord,
} from '../../server/implementation-planning-contracts.js';
import {
  PlanningTranscriptViewSchema,
  type PlanningTranscriptView,
} from '../../server/planning-transcript.js';
import {
  JiraIssueSnapshotSchema,
  JiraIssueStateSchema,
  type JiraIssueSnapshot,
  type JiraIssueState,
} from '../../integrations/jira/contracts.js';
import {
  RepositoryCatalogResponseSchema,
  type RepositoryCatalogEntry,
} from '../../workspace/contracts.js';
import { JiraProductResolutionSchema, type JiraProductResolution } from '../../shared/product.js';
import { RetrospectiveResponseSchema, type RetrospectiveResponse } from '../../server/report.js';
import { deleteJson, getJson, getOptionalJson, postJson } from './http.js';
import { operatorQueryKeys } from './query.js';

const EmptyResponseSchema = z.looseObject({});
const RemoveTaskCommandSchema = z.object({ confirmation: z.string().min(1) }).strict();

export const fetchRepositories = async (): Promise<readonly RepositoryCatalogEntry[]> =>
  (await getJson('/api/repositories', RepositoryCatalogResponseSchema)).repositories;

export const repositoriesQueryOptions = () =>
  queryOptions({ queryKey: operatorQueryKeys.repositories(), queryFn: fetchRepositories });

export const fetchJiraIssue = (issueKey: string): Promise<JiraIssueState> =>
  getJson(`/api/jira/issues/${encodeURIComponent(issueKey)}`, JiraIssueStateSchema);

export const jiraIssueQueryOptions = (issueKey: string) =>
  queryOptions({
    queryKey: operatorQueryKeys.jiraIssue(issueKey),
    queryFn: () => fetchJiraIssue(issueKey),
  });

export const previewJiraIssue = (issueKey: string): Promise<JiraIssueSnapshot> =>
  getJson(`/api/jira/issues/${encodeURIComponent(issueKey)}/preview`, JiraIssueSnapshotSchema);

export const resolveJiraProduct = (issueKey: string): Promise<JiraProductResolution> =>
  getJson(`/api/jira/issues/${encodeURIComponent(issueKey)}/product`, JiraProductResolutionSchema);

export const syncJiraIssue = (issueKey: string, repository?: string): Promise<JiraIssueState> =>
  postJson(
    `/api/jira/issues/${encodeURIComponent(issueKey)}/sync`,
    z.object({ repository: z.string().optional() }).strict(),
    JiraIssueStateSchema,
    repository === undefined ? {} : { repository },
  );

export const restoreTask = async (taskReference: string): Promise<void> => {
  await postJson(
    `/api/operator/tasks/${encodeURIComponent(taskReference)}/restore`,
    z.object({}).strict(),
    EmptyResponseSchema,
    {},
  );
};

export const removeTask = async (taskReference: string, confirmation: string): Promise<void> => {
  await fetchRemoveTask(taskReference, { confirmation });
};

const fetchRemoveTask = async (taskReference: string, input: { confirmation: string }) => {
  await deleteJson(
    `/api/operator/tasks/${encodeURIComponent(taskReference)}`,
    RemoveTaskCommandSchema,
    EmptyResponseSchema,
    input,
  );
};

export const generateTask = (
  taskReference: string,
  input: RunStartCommand,
): Promise<ExecutionRunView> =>
  postJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/generate`,
    RunStartCommandSchema,
    ExecutionRunViewSchema,
    input,
  );

export const reviewWorkflowChange = (
  taskReference: string,
  input: WorkflowChangeReviewCommand,
): Promise<ExecutionRunView> =>
  postJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/workflow-change-review`,
    WorkflowChangeReviewCommandSchema,
    ExecutionRunViewSchema,
    input,
  );

export const syncCodeReview = (
  taskReference: string,
  input: ExpectedRunCommand,
): Promise<CodeReviewSyncResponse> =>
  postJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/code-review/sync`,
    ExpectedRunCommandSchema,
    CodeReviewSyncResponseSchema,
    input,
  );

export const completeCodeReview = (
  taskReference: string,
  input: ExpectedRunCommand,
): Promise<CodeReviewSyncResponse> =>
  postJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/code-review/complete`,
    ExpectedRunCommandSchema,
    CodeReviewSyncResponseSchema,
    input,
  );

export const resolveDependencyAvailable = (
  taskReference: string,
  input: DependencyAvailableCommand,
): Promise<ExecutionRunView> =>
  postJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/dependency/available`,
    DependencyAvailableCommandSchema,
    ExecutionRunViewSchema,
    input,
  );

export const resolveDependencyDiscovery = (
  taskReference: string,
  input: DependencyDiscoveryCommand,
): Promise<ExecutionRunView> =>
  postJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/dependency/discovery`,
    DependencyDiscoveryCommandSchema,
    ExecutionRunViewSchema,
    input,
  );

export const answerPlanningClarification = (
  taskReference: string,
  input: PlanningClarificationSubmission,
): Promise<ExecutionRunView> =>
  postJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/planning-clarification`,
    PlanningClarificationSubmissionSchema,
    ExecutionRunViewSchema,
    input,
  );

export const reviewPlan = (
  taskReference: string,
  input: PlanReviewCommand,
): Promise<ExecutionRunView> =>
  postJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/plan-review`,
    PlanReviewCommandSchema,
    ExecutionRunViewSchema,
    input,
  );

export const reviewResearchDocument = (
  taskReference: string,
  input: ResearchDocumentReviewCommand,
): Promise<ExecutionRunView> =>
  postJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/research-document-review`,
    ResearchDocumentReviewCommandSchema,
    ExecutionRunViewSchema,
    input,
  );

export const fetchImplementationPlan = (
  taskReference: string,
): Promise<ImplementationPlanningRecord | null> =>
  getOptionalJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/implementation-plan`,
    ImplementationPlanningRecordSchema,
  );

export const implementationPlanQueryOptions = (taskReference: string) =>
  queryOptions({
    queryKey: operatorQueryKeys.implementationPlan(taskReference),
    queryFn: () => fetchImplementationPlan(taskReference),
  });

export const fetchPlanningTranscript = (
  taskReference: string,
): Promise<PlanningTranscriptView | null> =>
  getOptionalJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/planning-transcript`,
    PlanningTranscriptViewSchema,
  );

export const planningTranscriptQueryOptions = (taskReference: string) =>
  queryOptions({
    queryKey: operatorQueryKeys.planningTranscript(taskReference),
    queryFn: () => fetchPlanningTranscript(taskReference),
  });

export const fetchPlanReviewHistory = async (
  taskReference: string,
): Promise<readonly PlanReviewRound[]> =>
  (
    await getJson(
      `/api/workflows/${encodeURIComponent(taskReference)}/plan-reviews`,
      PlanReviewHistoryResponseSchema,
    )
  ).rounds;

export const planReviewHistoryQueryOptions = (taskReference: string) =>
  queryOptions({
    queryKey: operatorQueryKeys.planReviews(taskReference),
    queryFn: () => fetchPlanReviewHistory(taskReference),
  });

export const fetchRetrospective = (taskReference: string): Promise<RetrospectiveResponse> =>
  getJson(
    `/api/operator/tasks/${encodeURIComponent(taskReference)}/retrospective`,
    RetrospectiveResponseSchema,
  );

export const retrospectiveQueryOptions = (taskReference: string) =>
  queryOptions({
    queryKey: operatorQueryKeys.retrospective(taskReference),
    queryFn: () => fetchRetrospective(taskReference),
  });

export const restartTask = (
  taskReference: string,
  input: RestartRunCommand,
): Promise<ExecutionRunView> =>
  postJson(
    `/api/workflows/${encodeURIComponent(taskReference)}/restart`,
    RestartRunCommandSchema,
    ExecutionRunViewSchema,
    input,
  );
