import { readFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';

import type { BlockReceiptStore } from '../blocks/index.js';
import type { LedgerRepository } from '../ledger/repository.js';
import { type ImplementationPlanningCoordinator } from './implementation-planning.js';
import { ImplementationPlanningRecordSchema } from './implementation-planning-contracts.js';
import { PlanningTranscriptViewSchema } from './planning-transcript.js';
import { JiraIssueSnapshotSchema } from '../integrations/index.js';
import type {
  BitbucketReviewCoordinator,
  BitbucketReviewSyncError,
  JiraIssueService,
  JiraIssueServiceError,
} from '../integrations/index.js';
import {
  RepositoryCatalogResponseSchema,
  RepositoryReferenceSchema,
} from '../repositories/contracts.js';
import {
  ApiErrorResponseSchema,
  CodeReviewSyncResponseSchema,
  ConfigureTaskDependencyCommandSchema,
  DEFAULT_RUN_START_COMMAND,
  DependencyAvailableCommandSchema,
  DependencyDiscoveryCommandSchema,
  ExecutionRunViewSchema,
  ExpectedRunCommandSchema,
  OperatorActivityResponseSchema,
  OperatorExecutionAttemptSchema,
  OperatorRunLogResponseSchema,
  PlanningClarificationSubmissionSchema,
  OperatorWorkflowProjectionSchema,
  OperatorTaskSummarySchema,
  RestartRunCommandSchema,
  ResumeRunCommandSchema,
  RunStartCommandSchema,
  WorkflowChangeReviewCommandSchema,
  WorkflowResponseSchema,
  type OperatorTaskSummary,
} from './operator-contracts.js';
import {
  DependencyDeclarationSchema,
  type DependencyDeclarationStore,
} from './dependency-declaration.js';
import {
  type DependencyOperatorService,
  type DependencyOperatorServiceError,
} from './dependency-operator-service.js';
import {
  PlanReviewCommandSchema,
  PlanReviewHistoryResponseSchema,
  planReviewResolution,
  type PlanReviewStore,
} from './plan-review.js';
import type { OperatorServiceError, OperatorWorkflowService } from './operator-service.js';
import { RetrospectiveResponseSchema, type RetrospectiveStore } from '../retrospective/index.js';
import { createOperatorWorkflowProjection } from './operator-workflow-projection.js';
import type { ExecutionActivityReader } from './execution-activity.js';
import type { CompletedRunLifecycleReader } from './completed-run-lifecycle.js';
import { JsonValueSchema } from '../workflow/schema.js';
import { orderOperatorTasks } from './operator-task-order.js';
import type { TaskPresenceStore } from './task-presence.js';
import type { TaskRemovalError, TaskRemovalService } from './task-removal.js';
import { projectOperatorActivity } from './operator-activity-projection.js';
import { providerFailureSummary } from './workflow-generator.js';
import type { VerifiedPackagePublicationStore } from './verified-package-publication.js';
import {
  type TaskRunError,
  type TaskRunLifecycle,
  type TaskRunPublicState,
  type TaskRunService,
} from '../temporal/index.js';

const TaskReferenceParamsSchema = z.object({ taskReference: z.string().min(1) }).strict();
const ExecutionAttemptParamsSchema = z
  .object({
    taskReference: z.string().min(1),
    nodeId: z.string().min(1),
    blockRun: z.coerce.number().int().positive(),
  })
  .strict();
const TaskEvidenceParamsSchema = z
  .object({ taskReference: z.string().min(1), artifactId: z.string().min(1) })
  .strict();
const JiraIssueParamsSchema = z.object({ issueKey: z.string().min(1) }).strict();
const JiraSyncBodySchema = z.object({ repository: RepositoryReferenceSchema.optional() }).strict();
const JiraAttachmentParamsSchema = z
  .object({ issueKey: z.string().min(1), attachmentId: z.string().min(1) })
  .strict();
const AssetParamsSchema = z.object({ '*': z.string().min(1) }).strict();
const RemoveTaskCommandSchema = z.object({ confirmation: z.string().min(1) }).strict();
const StreamQuerySchema = z
  .object({ after: z.coerce.number().int().nonnegative().optional() })
  .strict();

export interface BuildOperatorApiOptions {
  readonly service: OperatorWorkflowService;
  readonly cockpitDirectory?: string | undefined;
  readonly logger?: boolean | undefined;
  readonly jiraIssueService?: JiraIssueService | undefined;
  readonly implementationPlanning?: ImplementationPlanningCoordinator | undefined;
  readonly executionActivity?: ExecutionActivityReader | undefined;
  readonly bitbucketReview?: Pick<BitbucketReviewCoordinator, 'sync'> | undefined;
  readonly dependencyOperator?: DependencyOperatorService | undefined;
  readonly dependencyDeclarations?: Pick<
    DependencyDeclarationStore,
    'listLatestByConsumerTask' | 'readLatest' | 'readRevision'
  >;
  readonly artifacts?: Pick<LedgerRepository, 'readArtifact'>;
  readonly verifiedPackagePublications?: Pick<VerifiedPackagePublicationStore, 'read'>;
  readonly temporalRunService: TaskRunService;
  readonly blockReceipts: Pick<BlockReceiptStore, 'read'>;
  readonly planReviews?: PlanReviewStore | undefined;
  readonly retrospectives?: Pick<RetrospectiveStore, 'readLatest'> | undefined;
  readonly completedRuns?: Pick<CompletedRunLifecycleReader, 'read'> | undefined;
  readonly taskPresence?: Pick<TaskPresenceStore, 'isRemoved' | 'restore'> | undefined;
  readonly taskRemoval?: Pick<TaskRemovalService, 'remove'> | undefined;
}

const apiError = (error: string, message: string) =>
  ApiErrorResponseSchema.parse({ error, message });

const sendServiceError = (reply: FastifyReply, error: OperatorServiceError): FastifyReply => {
  switch (error.kind) {
    case 'task_not_found':
      return reply
        .code(404)
        .send(apiError('task_not_found', `Task ${error.taskReference} does not exist`));
    case 'generation_blocked':
      return reply.code(409).send(apiError('generation_blocked', error.reason));
    case 'planner_contract_failure':
      return reply
        .code(500)
        .send(apiError('planner_contract_failure', `Planner stopped at ${error.stage}`));
    case 'non_json_artifact':
      return reply
        .code(500)
        .send(apiError('non_json_artifact', `Planner produced non-JSON ${error.artifact}`));
    case 'store_failure':
      return reply
        .code(500)
        .send(
          apiError('store_failure', `Ledger could not serve the workflow: ${error.error.kind}`),
        );
    case 'provider_failure':
      return reply
        .code(502)
        .send(apiError('provider_failure', providerFailureSummary(error.failure)));
    case 'generation_runtime_unavailable':
      return reply.code(503).send(apiError(error.kind, error.message));
  }
};

const sendJiraServiceError = (reply: FastifyReply, error: JiraIssueServiceError): FastifyReply => {
  switch (error.kind) {
    case 'invalid_issue_key':
      return reply
        .code(400)
        .send(apiError('invalid_issue_key', 'Use a Jira key such as AVIA-13235'));
    case 'issue_not_imported':
      return reply
        .code(404)
        .send(apiError('jira_issue_not_imported', 'Import the Jira issue first'));
    case 'attachment_not_found':
      return reply.code(404).send(apiError('jira_attachment_not_found', 'Attachment not found'));
    case 'attachment_unavailable':
      return reply
        .code(error.retryable ? 503 : 422)
        .send(apiError('jira_attachment_unavailable', error.message));
    case 'store_failure':
      return reply.code(500).send(apiError('jira_store_failure', error.error.kind));
    case 'preview_failed':
      return reply
        .code(
          'httpStatus' in error.problem
            ? (error.problem.httpStatus ?? 503)
            : error.problem.retryable
              ? 503
              : 422,
        )
        .send(apiError(`jira_${error.problem.kind}`, error.problem.message));
  }
};

const sendTemporalRunError = (reply: FastifyReply, error: TaskRunError): FastifyReply => {
  switch (error.kind) {
    case 'run_not_found':
      return reply.code(404).send(apiError(error.kind, 'This workflow has not started'));
    case 'run_input_conflict':
      return reply
        .code(409)
        .send(apiError(error.kind, 'This run already exists with different immutable settings'));
    case 'run_not_restartable':
      return reply
        .code(409)
        .send(apiError(error.kind, 'Completed workflows cannot be restarted from scratch'));
    case 'stale_run':
      return reply
        .code(409)
        .send(apiError(error.kind, 'This command targets an obsolete workflow run; refresh first'));
    case 'runtime_unavailable':
      return reply.code(503).send(apiError(error.kind, error.message));
  }
};

const sendTaskRemovalError = (reply: FastifyReply, error: TaskRemovalError): FastifyReply =>
  reply
    .code(error.kind === 'presence' ? 409 : 503)
    .send(apiError(`task_removal_${error.kind}`, 'Task removal did not complete; retry safely'));

const sendBitbucketReviewError = (
  reply: FastifyReply,
  error: BitbucketReviewSyncError,
): FastifyReply => {
  switch (error.kind) {
    case 'pull_request_evidence_missing':
    case 'invalid_pull_request_evidence':
      return reply.code(409).send(apiError(error.kind, 'Pull request evidence is unavailable'));
    case 'review_failed':
      return reply
        .code(error.problem.retryable ? 503 : 422)
        .send(apiError(error.problem.kind, error.problem.message));
    case 'store_failed':
      return reply.code(500).send(apiError('review_store_failed', error.error.kind));
  }
};

const sendDependencyOperatorError = (
  reply: FastifyReply,
  error: DependencyOperatorServiceError,
): FastifyReply => {
  switch (error.kind) {
    case 'wait_input_unavailable':
      return reply
        .code(409)
        .send(apiError(error.kind, `The active ${error.waitKind} wait cannot be resolved here`));
    case 'wait_input_mismatch':
    case 'dependency_declaration_mismatch':
      return reply.code(409).send(apiError(error.kind, error.reason));
    case 'dependency_declaration_not_found':
      return reply
        .code(409)
        .send(
          apiError(
            error.kind,
            `Declaration ${error.declarationId} revision ${String(error.declarationRevision)} is unavailable`,
          ),
        );
    case 'dependency_request_mismatch':
      return reply
        .code(409)
        .send(
          apiError(
            error.kind,
            `Stored dependency declaration ${error.declarationId} conflicts with this request`,
          ),
        );
    case 'dependency_declaration_store_failed':
      return reply
        .code(error.error.kind === 'ledger_conflict' ? 409 : 500)
        .send(apiError(error.error.kind, 'Dependency declarations could not be persisted'));
    case 'verified_package_publication_store_failed':
      return reply
        .code(
          error.error.kind === 'ledger_conflict' || error.error.kind === 'publication_conflict'
            ? 409
            : 500,
        )
        .send(apiError(error.error.kind, 'Verified package publications could not be stored'));
    case 'nexus_observation_failed':
      return reply
        .code(
          error.problem.kind === 'invalid_input'
            ? 400
            : error.problem.kind === 'invalid_response'
              ? 502
              : error.problem.retryable
                ? 503
                : 422,
        )
        .send(apiError(error.problem.kind, error.problem.message));
  }
};

const applyTemporalRunToTask = (
  task: OperatorTaskSummary,
  run: TaskRunPublicState | null,
): OperatorTaskSummary => {
  if (run === null) return task;

  switch (run.status) {
    case 'running':
      return OperatorTaskSummarySchema.parse({
        ...task,
        status: 'running',
        attention: 'none',
        currentStage:
          run.currentNodeId === null ? 'Temporal workflow running' : `Running ${run.currentNodeId}`,
      });
    case 'waiting': {
      const codeReview = run.wait.waitKind === 'code_review@1';
      const planReview = run.wait.waitKind === 'plan.approved@1';
      const workflowChangeReview = run.wait.waitKind === 'workflow_change.review@1';
      return OperatorTaskSummarySchema.parse({
        ...task,
        status: codeReview ? 'code_review' : planReview ? 'plan_review' : 'waiting',
        attention: 'operator',
        currentStage: workflowChangeReview
          ? 'Review proposed workflow change'
          : (run.wait.reason ??
            (codeReview
              ? 'Waiting for code review'
              : planReview
                ? 'Plan review required'
                : `Waiting for ${run.wait.waitKind.replace('@1', '').replaceAll('_', ' ')}`)),
      });
    }
    case 'completed':
      return OperatorTaskSummarySchema.parse({
        ...task,
        status: 'done',
        attention: 'none',
        currentStage: `Workflow completed · ${run.outcome}`,
      });
  }
};

const contentType = (filename: string): string => {
  switch (extname(filename)) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
};

const resolveCockpitAsset = (directory: string, asset: string): string | null => {
  const root = resolve(directory);
  const filename = resolve(join(root, 'assets', asset));
  const pathFromRoot = relative(root, filename);

  return pathFromRoot.startsWith('..') || pathFromRoot.length === 0 ? null : filename;
};

export const buildOperatorApi = (options: BuildOperatorApiOptions): FastifyInstance => {
  const api = Fastify({ logger: options.logger ?? false });
  const temporalRunService = options.temporalRunService;

  const readCurrentLifecycle = async (taskReference: string, reply: FastifyReply) => {
    const completed = options.completedRuns?.read(taskReference);
    if (completed?.ok === false) {
      reply
        .code(500)
        .send(apiError('completed_run_corrupt', `Completed run history is unavailable`));
      return null;
    }
    if (completed?.value !== null && completed?.value !== undefined) return completed.value;
    const lifecycle = await temporalRunService.readLifecycle(taskReference);
    if (!lifecycle.ok) {
      sendTemporalRunError(reply, lifecycle.error);
      return null;
    }
    return lifecycle.value;
  };

  const currentPlanningEpisodeId = (lifecycle: TaskRunLifecycle | null): string | null =>
    lifecycle?.bootstrap.planning?.planningEpisodeId ?? null;

  const sendTemporalState = (
    reply: FastifyReply,
    _taskReference: string,
    run: TaskRunPublicState,
  ): FastifyReply => reply.send(ExecutionRunViewSchema.parse(run));

  api.get('/api/health', () => ({
    status: 'ok',
    executionRuntime: 'temporal',
  }));

  api.get('/api/repositories', (_request, reply) => {
    if (options.jiraIssueService === undefined) {
      return reply.code(503).send(apiError('jira_not_configured', 'Jira integration is disabled'));
    }
    return reply.send(
      RepositoryCatalogResponseSchema.parse({
        repositories: options.jiraIssueService.listRepositories(),
      }),
    );
  });

  api.get('/api/operator/tasks', async (_request, reply) => {
    const result = options.service.listOperatorTasks();
    if (!result.ok) return sendServiceError(reply, result.error);
    const withRunState = async (task: OperatorTaskSummary): Promise<OperatorTaskSummary> => {
      const withPlanning = options.implementationPlanning?.decorateTask(task) ?? task;
      const retrospective = options.retrospectives?.readLatest(task.id);
      if (retrospective?.ok === true && retrospective.value !== null) {
        return OperatorTaskSummarySchema.parse({
          ...withPlanning,
          status: 'done',
          attention: 'none',
          currentStage: `Workflow completed · ${retrospective.value.outcome}`,
        });
      }
      const run = await temporalRunService.read(task.id);
      if (!run.ok) {
        return OperatorTaskSummarySchema.parse({
          ...withPlanning,
          status: 'needs_attention',
          attention: 'operator',
          currentStage: 'Temporal runtime unavailable',
        });
      }
      const withExecution = applyTemporalRunToTask(withPlanning, run.value);
      return withExecution;
    };
    if (options.jiraIssueService === undefined) {
      return reply.send({
        ...result.value,
        tasks: orderOperatorTasks(
          (await Promise.all(result.value.tasks.map(withRunState))).filter(
            (task) => options.taskPresence?.isRemoved(task.id) !== true,
          ),
        ),
      });
    }
    const jiraTasks = options.jiraIssueService.listOperatorTasks();
    if (!jiraTasks.ok) return sendJiraServiceError(reply, jiraTasks.error);
    const hydratedJiraTasks = [];
    for (const task of jiraTasks.value) {
      hydratedJiraTasks.push(await withRunState(task));
    }
    return reply.send({
      tasks: orderOperatorTasks(
        [...hydratedJiraTasks, ...(await Promise.all(result.value.tasks.map(withRunState)))].filter(
          (task) => options.taskPresence?.isRemoved(task.id) !== true,
        ),
      ),
      streamCursor: result.value.streamCursor,
    });
  });

  api.post('/api/operator/tasks/:taskReference/restore', (request, reply) => {
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }
    const restored = options.taskPresence?.restore(params.data.taskReference);
    return restored?.ok === false
      ? reply.code(409).send(apiError('task_restore_conflict', 'Task could not be restored'))
      : reply.send({ restored: true });
  });

  api.delete('/api/operator/tasks/:taskReference', async (request, reply) => {
    if (options.taskRemoval === undefined) {
      return reply.code(503).send(apiError('task_removal_unavailable', 'Task removal is disabled'));
    }
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    const command = RemoveTaskCommandSchema.safeParse(request.body);
    if (!params.success || !command.success) {
      return reply.code(400).send(apiError('invalid_request', 'Removal confirmation is required'));
    }
    const taskKey = params.data.taskReference.replace(/^jira:/u, '');
    if (command.data.confirmation !== taskKey) {
      return reply
        .code(400)
        .send(apiError('task_removal_confirmation_mismatch', `Type ${taskKey} to confirm`));
    }
    const removed = await options.taskRemoval.remove(params.data.taskReference);
    return removed.ok ? reply.send({ removed: true }) : sendTaskRemovalError(reply, removed.error);
  });

  api.get('/api/operator/tasks/:taskReference/retrospective', async (request, reply) => {
    if (options.retrospectives === undefined) {
      return reply
        .code(503)
        .send(apiError('retrospective_unavailable', 'Retrospective storage is unavailable'));
    }
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }
    const report = options.retrospectives.readLatest(params.data.taskReference);
    if (!report.ok) {
      return reply
        .code(500)
        .send(apiError('retrospective_corrupt', 'Retrospective report is unavailable'));
    }
    return reply.send(
      RetrospectiveResponseSchema.parse(
        report.value === null ? { status: 'pending' } : { status: 'ready', report: report.value },
      ),
    );
  });

  api.get('/api/operator/tasks/:taskReference/activity', async (request, reply) => {
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }

    const lifecycle = await readCurrentLifecycle(params.data.taskReference, reply);
    if (reply.sent) return reply;
    const planningEpisodeId = currentPlanningEpisodeId(lifecycle);
    const executionWorkflowId = lifecycle?.execution?.workflowId ?? null;

    if (params.data.taskReference.startsWith('jira:') && options.jiraIssueService !== undefined) {
      const jiraResult = options.jiraIssueService.readActivity(params.data.taskReference);
      if (!jiraResult.ok) return sendJiraServiceError(reply, jiraResult.error);
      const workflowResult = options.service.readActivity(
        params.data.taskReference,
        planningEpisodeId,
      );
      if (!workflowResult.ok) return sendServiceError(reply, workflowResult.error);
      const entries = projectOperatorActivity({
        jira: jiraResult.value.entries,
        workflow: workflowResult.value.entries,
        implementationPlanning:
          planningEpisodeId === null
            ? []
            : (options.implementationPlanning?.readActivity(planningEpisodeId) ?? []),
        continuation: [],
        execution:
          executionWorkflowId === null
            ? []
            : (options.executionActivity?.readActivity(executionWorkflowId) ?? []),
      });
      return reply.send(
        OperatorActivityResponseSchema.parse({
          taskReference: params.data.taskReference,
          providerSession:
            workflowResult.value.providerSession.status === 'completed'
              ? workflowResult.value.providerSession
              : jiraResult.value.providerSession,
          entries,
        }),
      );
    }

    const result = options.service.readActivity(params.data.taskReference, planningEpisodeId);
    if (!result.ok) {
      return sendServiceError(reply, result.error);
    }
    const entries = projectOperatorActivity({
      jira: [],
      workflow: result.value.entries,
      implementationPlanning:
        planningEpisodeId === null
          ? []
          : (options.implementationPlanning?.readActivity(planningEpisodeId) ?? []),
      continuation: [],
      execution:
        executionWorkflowId === null
          ? []
          : (options.executionActivity?.readActivity(executionWorkflowId) ?? []),
    });
    return reply.send(
      OperatorActivityResponseSchema.parse({
        ...result.value,
        entries,
      }),
    );
  });

  api.get('/api/operator/tasks/:taskReference/projection', async (request, reply) => {
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }

    const lifecycle = await readCurrentLifecycle(params.data.taskReference, reply);
    if (reply.sent) return reply;
    return reply.send(
      OperatorWorkflowProjectionSchema.parse(
        createOperatorWorkflowProjection(
          params.data.taskReference,
          lifecycle,
          options.blockReceipts,
          (run) => {
            const reference = run.bootstrap.draft?.planningSnapshot;
            if (reference === undefined || options.implementationPlanning === undefined)
              return null;
            const snapshot = options.implementationPlanning.readRunSnapshot(reference);
            return snapshot.ok ? snapshot.value : null;
          },
          (execution) => options.executionActivity?.readCurrentTranscript(execution) ?? null,
          (operationId) => {
            const transcript = options.implementationPlanning?.readOperationTranscript(operationId);
            return transcript?.ok === true ? transcript.value : null;
          },
          {
            listDeclarations: (taskReference) => {
              const declarations =
                options.dependencyDeclarations?.listLatestByConsumerTask(taskReference);
              return declarations?.ok === true
                ? declarations.value.map((declaration) => ({
                    declarationId: declaration.declarationId,
                    revision: declaration.revision,
                    producerTaskReference: declaration.producerTaskReference,
                    producerRepository: declaration.producerRepository,
                    packages: declaration.packages,
                    mode: declaration.mode,
                    source: declaration.source,
                    createdAt: declaration.createdAt,
                  }))
                : [];
            },
            readDeclaration: (declarationId) => {
              const declaration = options.dependencyDeclarations?.readLatest(declarationId);
              return declaration?.ok === true ? declaration.value : null;
            },
            readPublication: (observationId) => {
              const publication = options.verifiedPackagePublications?.read(observationId);
              return publication?.ok === true ? publication.value : null;
            },
            readArtifact: (artifactId) => options.artifacts?.readArtifact(artifactId) ?? null,
          },
        ),
      ),
    );
  });

  api.post('/api/operator/tasks/:taskReference/dependencies/configure', async (request, reply) => {
    if (
      options.dependencyOperator === undefined ||
      options.dependencyDeclarations === undefined ||
      options.verifiedPackagePublications === undefined ||
      options.jiraIssueService === undefined
    ) {
      return reply
        .code(503)
        .send(apiError('dependency_operator_unavailable', 'Dependency configuration is disabled'));
    }
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }
    const command = ConfigureTaskDependencyCommandSchema.safeParse(request.body);
    if (!command.success) {
      return reply
        .code(400)
        .send(apiError('invalid_dependency_configuration', 'Dependency configuration is invalid'));
    }
    if (command.data.consumerTaskReference !== params.data.taskReference) {
      return reply
        .code(409)
        .send(
          apiError(
            'dependency_consumer_mismatch',
            'The configured consumer task does not match the selected task',
          ),
        );
    }
    const consumerIssueKey = params.data.taskReference.startsWith('jira:')
      ? params.data.taskReference.slice('jira:'.length)
      : null;
    const producerIssueKey = command.data.producerTaskReference.startsWith('jira:')
      ? command.data.producerTaskReference.slice('jira:'.length)
      : null;
    if (consumerIssueKey === null || producerIssueKey === null) {
      return reply
        .code(409)
        .send(apiError('dependency_jira_link_required', 'Dependency tasks must be Jira tasks'));
    }
    const jiraState = options.jiraIssueService.read(consumerIssueKey);
    if (!jiraState.ok) return sendJiraServiceError(reply, jiraState.error);
    if (jiraState.value === null || jiraState.value.status === 'unavailable') {
      return reply
        .code(409)
        .send(
          apiError(
            'dependency_jira_snapshot_required',
            'Sync the consumer Jira task before configuring its dependency',
          ),
        );
    }
    const matchingLink = jiraState.value.issue.links.find(
      (link) =>
        link.linkId === command.data.source.linkId &&
        link.linkTypeId === command.data.source.linkTypeId &&
        link.direction === command.data.source.direction &&
        link.issueKey === producerIssueKey &&
        link.linkTypeName.toLocaleLowerCase('en-US') === 'blocks',
    );
    if (matchingLink === undefined) {
      return reply
        .code(409)
        .send(
          apiError(
            'dependency_jira_link_mismatch',
            'The selected Jira Blocks link does not point at the declared producer task',
          ),
        );
    }
    const configured = options.dependencyOperator.configureTaskDependency(command.data);
    return configured.ok
      ? reply.send(DependencyDeclarationSchema.parse(configured.value))
      : sendDependencyOperatorError(reply, configured.error);
  });

  api.get('/api/operator/tasks/:taskReference/run-log', async (request, reply) => {
    if (options.executionActivity === undefined) {
      return reply
        .code(503)
        .send(apiError('execution_activity_unavailable', 'Run log is unavailable'));
    }
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }
    const lifecycle = await readCurrentLifecycle(params.data.taskReference, reply);
    if (reply.sent) return reply;
    if (lifecycle === null) {
      return reply.code(404).send(apiError('run_not_found', 'This workflow has not started'));
    }
    return reply.send(
      OperatorRunLogResponseSchema.parse(options.executionActivity.readRunLog(lifecycle)),
    );
  });

  api.get('/api/operator/tasks/:taskReference/evidence/:artifactId', async (request, reply) => {
    if (options.executionActivity === undefined) {
      return reply
        .code(503)
        .send(apiError('execution_activity_unavailable', 'Run evidence is unavailable'));
    }
    const params = TaskEvidenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send(apiError('invalid_request', 'Valid evidence identity is required'));
    }
    const lifecycle = await readCurrentLifecycle(params.data.taskReference, reply);
    if (reply.sent) return reply;
    if (lifecycle === null) {
      return reply.code(404).send(apiError('run_not_found', 'This workflow has not started'));
    }
    const runLog = options.executionActivity.readRunLog(lifecycle);
    const belongsToRun = runLog.entries.some((entry) =>
      entry.evidence.some(({ artifactId }) => artifactId === params.data.artifactId),
    );
    if (!belongsToRun) {
      return reply.code(404).send(apiError('evidence_not_found', 'Run evidence does not exist'));
    }
    const evidence = await options.executionActivity.readEvidence(params.data.artifactId);
    if (evidence.status === 'failed') {
      return reply.code(409).send(apiError('evidence_unavailable', evidence.message));
    }
    if (evidence.status !== 'found') {
      return reply.code(404).send(apiError('evidence_not_found', 'Run evidence does not exist'));
    }
    const filename = basename(evidence.artifact.relativePath);
    return reply
      .type(evidence.artifact.mimeType)
      .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(Buffer.from(evidence.artifact.content));
  });

  api.get(
    '/api/operator/tasks/:taskReference/execution-attempts/:nodeId/:blockRun',
    async (request, reply) => {
      if (options.executionActivity === undefined) {
        return reply
          .code(503)
          .send(apiError('execution_activity_unavailable', 'Execution activity is unavailable'));
      }
      const params = ExecutionAttemptParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .code(400)
          .send(apiError('invalid_request', 'Valid attempt identity is required'));
      }
      const lifecycle = await readCurrentLifecycle(params.data.taskReference, reply);
      if (reply.sent) return reply;
      if (lifecycle?.execution === null || lifecycle?.execution === undefined) {
        return reply.code(404).send(apiError('attempt_not_found', 'Execution has not started'));
      }
      const attempt = options.executionActivity.readAttempt(
        lifecycle.execution,
        params.data.nodeId,
        params.data.blockRun,
      );
      return attempt === null
        ? reply.code(404).send(apiError('attempt_not_found', 'Execution attempt does not exist'))
        : reply.send(OperatorExecutionAttemptSchema.parse(attempt));
    },
  );

  api.get('/api/jira/issues/:issueKey', (request, reply) => {
    if (options.jiraIssueService === undefined) {
      return reply.code(503).send(apiError('jira_not_configured', 'Jira integration is disabled'));
    }
    const params = JiraIssueParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'issueKey is required'));
    }
    const result = options.jiraIssueService.read(params.data.issueKey);
    if (!result.ok) return sendJiraServiceError(reply, result.error);
    return result.value === null
      ? reply.code(404).send(apiError('jira_issue_not_imported', 'Import the Jira issue first'))
      : reply.send(result.value);
  });

  api.post('/api/jira/issues/:issueKey/sync', async (request, reply) => {
    if (options.jiraIssueService === undefined) {
      return reply.code(503).send(apiError('jira_not_configured', 'Jira integration is disabled'));
    }
    const params = JiraIssueParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'issueKey is required'));
    }
    const body = JiraSyncBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply
        .code(400)
        .send(
          apiError('invalid_repository', 'Repository must be a catalog name such as front-avia'),
        );
    }
    const result = await options.jiraIssueService.sync(params.data.issueKey, body.data.repository);
    return result.ok ? reply.send(result.value) : sendJiraServiceError(reply, result.error);
  });

  api.get('/api/jira/issues/:issueKey/preview', async (request, reply) => {
    if (options.jiraIssueService === undefined) {
      return reply.code(503).send(apiError('jira_not_configured', 'Jira integration is disabled'));
    }
    const params = JiraIssueParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'issueKey is required'));
    }
    const result = await options.jiraIssueService.preview(params.data.issueKey);
    return result.ok
      ? reply.send(JiraIssueSnapshotSchema.parse(result.value))
      : sendJiraServiceError(reply, result.error);
  });

  api.get('/api/jira/issues/:issueKey/attachments/:attachmentId', async (request, reply) => {
    if (options.jiraIssueService === undefined) {
      return reply.code(503).send(apiError('jira_not_configured', 'Jira integration is disabled'));
    }
    const params = JiraAttachmentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'Attachment identity is required'));
    }
    const result = await options.jiraIssueService.readAttachment(
      params.data.issueKey,
      params.data.attachmentId,
    );
    return result.ok
      ? reply.type(result.value.contentType).send(Buffer.from(result.value.bytes))
      : sendJiraServiceError(reply, result.error);
  });

  api.get('/api/events', (request, reply) => {
    const query = StreamQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply
        .code(400)
        .send(apiError('invalid_request', 'after must be a non-negative cursor'));
    }

    const header = request.headers['last-event-id'];
    const headerValue = Array.isArray(header) ? header[0] : header;
    const headerCursor = headerValue === undefined ? 0 : Number(headerValue);
    let cursor = Math.max(
      query.data.after ?? 0,
      Number.isSafeInteger(headerCursor) ? headerCursor : 0,
    );

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const flush = (): void => {
      const events = [
        ...options.service.listStreamEventsAfter(cursor),
        ...(options.implementationPlanning?.listStreamEventsAfter(cursor) ?? []),
      ].sort((left, right) => left.sequence - right.sequence);
      for (const event of events) {
        reply.raw.write(
          `id: ${String(event.sequence)}\nevent: ledger\ndata: ${JSON.stringify(event)}\n\n`,
        );
        cursor = event.sequence;
      }
    };

    flush();
    const poll = setInterval(flush, 500);
    const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000);
    reply.raw.once('close', () => {
      clearInterval(poll);
      clearInterval(keepAlive);
    });

    return reply;
  });

  api.get('/api/workflows/:taskReference', async (request, reply) => {
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }

    const lifecycle = await readCurrentLifecycle(params.data.taskReference, reply);
    if (reply.sent) return reply;
    const operationId =
      lifecycle?.bootstrap.planning?.status === 'ready'
        ? lifecycle.bootstrap.planning.workflowOperationId
        : null;
    const result =
      operationId === null
        ? { ok: true as const, value: null }
        : options.service.readPlanningOperation(params.data.taskReference, operationId);
    if (!result.ok) return sendServiceError(reply, result.error);
    if (result.value === null) {
      return reply.code(404).send(apiError('workflow_not_found', 'Generate this workflow first'));
    }

    return reply.send(WorkflowResponseSchema.parse(result.value));
  });

  api.get('/api/workflows/:taskReference/run', async (request, reply) => {
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }
    const lifecycle = await readCurrentLifecycle(params.data.taskReference, reply);
    if (reply.sent) return reply;
    const current = lifecycle?.execution ?? lifecycle?.bootstrap ?? null;
    return current === null
      ? reply.code(404).send(apiError('run_not_found', 'This workflow has not started'))
      : reply.send(ExecutionRunViewSchema.parse(current));
  });

  api.get('/api/workflows/:taskReference/implementation-plan', async (request, reply) => {
    if (options.implementationPlanning === undefined) {
      return reply
        .code(404)
        .send(apiError('implementation_plan_not_found', 'No implementation plan exists'));
    }
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }
    const lifecycle = await readCurrentLifecycle(params.data.taskReference, reply);
    if (reply.sent) return reply;
    const planningEpisodeId = currentPlanningEpisodeId(lifecycle);
    if (planningEpisodeId === null) {
      return reply
        .code(404)
        .send(apiError('implementation_plan_not_found', 'No plan exists for the current run'));
    }
    const result = options.implementationPlanning.read(planningEpisodeId);
    if (!result.ok) {
      return reply
        .code(500)
        .send(apiError('implementation_plan_store_failure', 'The plan projection is invalid'));
    }
    return result.value === null
      ? reply
          .code(404)
          .send(apiError('implementation_plan_not_found', 'No implementation plan exists'))
      : reply.send(ImplementationPlanningRecordSchema.parse(result.value));
  });

  api.get('/api/workflows/:taskReference/planner-input', async (request, reply) => {
    if (options.implementationPlanning === undefined || options.artifacts === undefined) {
      return reply
        .code(503)
        .send(apiError('planner_input_unavailable', 'Planner input storage is unavailable'));
    }
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }
    const lifecycle = await readCurrentLifecycle(params.data.taskReference, reply);
    if (reply.sent) return reply;
    const planningEpisodeId = currentPlanningEpisodeId(lifecycle);
    if (planningEpisodeId === null) {
      return reply.code(404).send(apiError('planner_input_not_found', 'No planning input exists'));
    }
    const planning = options.implementationPlanning.read(planningEpisodeId);
    if (!planning.ok || planning.value === null || planning.value.planningSnapshot === null) {
      return reply.code(404).send(apiError('planner_input_not_found', 'No planning input exists'));
    }
    const snapshot = options.implementationPlanning.readRunSnapshot(
      planning.value.planningSnapshot,
    );
    if (!snapshot.ok) {
      return reply
        .code(409)
        .send(apiError('planner_input_corrupt', 'Planning context snapshot is unavailable'));
    }
    const evidence = options.artifacts.readArtifact(planning.value.evidenceBundle.artifactId);
    return reply.send(
      JsonValueSchema.parse({
        taskReference: params.data.taskReference,
        planningEpisodeId,
        planningAttempt: planning.value.attempt,
        promptHash:
          planning.value.status === 'planning' || planning.value.receipt === null
            ? null
            : planning.value.receipt.promptHash,
        operatorGuidance: planning.value.operatorGuidance,
        validationFeedback: planning.value.validationFeedback,
        previousDecision: planning.value.previousDecision,
        planningContext: snapshot.value,
        evidenceBundle: evidence?.payload ?? null,
      }),
    );
  });

  api.get('/api/workflows/:taskReference/planning-transcript', async (request, reply) => {
    if (options.implementationPlanning === undefined) {
      return reply
        .code(404)
        .send(apiError('planning_transcript_not_found', 'No planning transcript exists'));
    }
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }
    const lifecycle = await readCurrentLifecycle(params.data.taskReference, reply);
    if (reply.sent) return reply;
    const planningEpisodeId = currentPlanningEpisodeId(lifecycle);
    if (planningEpisodeId === null) {
      return reply
        .code(404)
        .send(
          apiError('planning_transcript_not_found', 'No transcript exists for the current run'),
        );
    }
    const result = options.implementationPlanning.readTranscript(planningEpisodeId);
    if (!result.ok) {
      return reply
        .code(500)
        .send(apiError('planning_transcript_store_failure', 'The transcript is invalid'));
    }
    return result.value === null
      ? reply
          .code(404)
          .send(apiError('planning_transcript_not_found', 'No planning transcript exists'))
      : reply.send(PlanningTranscriptViewSchema.parse(result.value));
  });

  api.post('/api/workflows/:taskReference/code-review/sync', async (request, reply) => {
    if (options.bitbucketReview === undefined) {
      return reply
        .code(503)
        .send(apiError('bitbucket_review_not_configured', 'Bitbucket review intake is disabled'));
    }
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }
    const command = ExpectedRunCommandSchema.safeParse(request.body);
    if (!command.success) {
      return reply.code(400).send(apiError('invalid_request', 'expectedRunId is required'));
    }
    const current = await temporalRunService.read(params.data.taskReference);
    if (!current.ok) return sendTemporalRunError(reply, current.error);
    if (
      current.value === null ||
      current.value.runtime !== 'execution' ||
      current.value.status !== 'waiting' ||
      current.value.wait.waitKind !== 'code_review@1'
    ) {
      return reply
        .code(409)
        .send(apiError('run_not_at_code_review', 'The run is not waiting for code review'));
    }
    if (command.data.expectedRunId !== current.value.runId) {
      return reply.code(409).send(apiError('stale_run', 'Refresh before syncing code review'));
    }
    const synced = await options.bitbucketReview.sync({
      taskReference: params.data.taskReference,
      workflowId: current.value.workflowId,
      workflowRunId: current.value.runId,
    });
    if (!synced.ok) return sendBitbucketReviewError(reply, synced.error);
    if (synced.value.status === 'pending') {
      return reply.send(
        CodeReviewSyncResponseSchema.parse({
          status: 'pending',
          reviewId: null,
          pullRequestUrl: synced.value.pullRequestUrl,
          run: current.value,
        }),
      );
    }
    const resumed = await temporalRunService.resolveWait(params.data.taskReference, {
      runId: command.data.expectedRunId,
      nodeId: current.value.wait.nodeId,
      waitKind: current.value.wait.waitKind,
      resolution: {
        decision: synced.value.status,
        reviewId: synced.value.reviewId,
      },
    });
    if (!resumed.ok) return sendTemporalRunError(reply, resumed.error);
    return reply.send(
      CodeReviewSyncResponseSchema.parse({
        status: synced.value.status,
        reviewId: synced.value.reviewId,
        pullRequestUrl: synced.value.evidence.snapshot.pullRequestUrl,
        run: resumed.value,
      }),
    );
  });

  api.post('/api/workflows/:taskReference/code-review/complete', async (request, reply) => {
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }
    const command = ExpectedRunCommandSchema.safeParse(request.body);
    if (!command.success) {
      return reply.code(400).send(apiError('invalid_request', 'expectedRunId is required'));
    }
    const current = await temporalRunService.read(params.data.taskReference);
    if (!current.ok) return sendTemporalRunError(reply, current.error);
    if (
      current.value === null ||
      current.value.runtime !== 'execution' ||
      current.value.status !== 'waiting' ||
      current.value.wait.waitKind !== 'code_review@1'
    ) {
      return reply
        .code(409)
        .send(apiError('run_not_at_code_review', 'The run is not waiting for code review'));
    }
    const reviewId = `operator:${current.value.runId}:${current.value.wait.nodeId}`;
    const completed = await temporalRunService.resolveWait(params.data.taskReference, {
      runId: command.data.expectedRunId,
      nodeId: current.value.wait.nodeId,
      waitKind: current.value.wait.waitKind,
      resolution: { decision: 'approved', reviewId },
    });
    if (!completed.ok) return sendTemporalRunError(reply, completed.error);
    return reply.send(
      CodeReviewSyncResponseSchema.parse({
        status: 'approved',
        reviewId,
        pullRequestUrl: null,
        run: completed.value,
      }),
    );
  });

  api.post('/api/workflows/:taskReference/dependency/available', async (request, reply) => {
    if (options.dependencyOperator === undefined) {
      return reply
        .code(503)
        .send(apiError('dependency_operator_unavailable', 'Dependency verification is disabled'));
    }
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }
    const command = DependencyAvailableCommandSchema.safeParse(request.body);
    if (!command.success) {
      return reply
        .code(400)
        .send(
          apiError('invalid_dependency_available_command', 'Published versions payload is invalid'),
        );
    }
    const current = await temporalRunService.read(params.data.taskReference);
    if (!current.ok) return sendTemporalRunError(reply, current.error);
    if (
      current.value === null ||
      current.value.runtime !== 'execution' ||
      current.value.status !== 'waiting' ||
      current.value.wait.waitKind !== 'dependency.available@1'
    ) {
      return reply
        .code(409)
        .send(
          apiError(
            'run_not_at_dependency_available',
            'The run is not waiting for published versions',
          ),
        );
    }
    if (
      command.data.expectedRunId !== current.value.runId ||
      command.data.nodeId !== current.value.wait.nodeId
    ) {
      return reply
        .code(409)
        .send(apiError('stale_run', 'Refresh before verifying published versions'));
    }
    const waitingRun = current.value;
    const lifecycle = await readCurrentLifecycle(params.data.taskReference, reply);
    if (reply.sent || lifecycle === null || lifecycle.execution === null) return reply;
    const prepared = await options.dependencyOperator.prepareAvailableResolution(
      params.data.taskReference,
      lifecycle,
      waitingRun,
      command.data,
    );
    if (!prepared.ok) return sendDependencyOperatorError(reply, prepared.error);
    const resumed = await temporalRunService.resolveWait(params.data.taskReference, {
      runId: command.data.expectedRunId,
      nodeId: waitingRun.wait.nodeId,
      waitKind: waitingRun.wait.waitKind,
      resolution: prepared.value.resolution,
    });
    return resumed.ok
      ? sendTemporalState(reply, params.data.taskReference, resumed.value)
      : sendTemporalRunError(reply, resumed.error);
  });

  api.post('/api/workflows/:taskReference/dependency/discovery', async (request, reply) => {
    if (options.dependencyOperator === undefined) {
      return reply
        .code(503)
        .send(apiError('dependency_operator_unavailable', 'Dependency configuration is disabled'));
    }
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }
    const command = DependencyDiscoveryCommandSchema.safeParse(request.body);
    if (!command.success) {
      return reply
        .code(400)
        .send(
          apiError(
            'invalid_dependency_discovery_command',
            'Dependency discovery payload is invalid',
          ),
        );
    }
    const current = await temporalRunService.read(params.data.taskReference);
    if (!current.ok) return sendTemporalRunError(reply, current.error);
    if (
      current.value === null ||
      current.value.runtime !== 'execution' ||
      current.value.status !== 'waiting' ||
      current.value.wait.waitKind !== 'dependency.discovery@1'
    ) {
      return reply
        .code(409)
        .send(
          apiError(
            'run_not_at_dependency_discovery',
            'The run is not waiting for dependency configuration',
          ),
        );
    }
    if (
      command.data.expectedRunId !== current.value.runId ||
      command.data.nodeId !== current.value.wait.nodeId
    ) {
      return reply
        .code(409)
        .send(apiError('stale_run', 'Refresh before configuring the dependency wait'));
    }
    const waitingRun = current.value;
    const lifecycle = await readCurrentLifecycle(params.data.taskReference, reply);
    if (reply.sent || lifecycle === null || lifecycle.execution === null) return reply;
    const prepared = options.dependencyOperator.prepareDiscoveryResolution(
      params.data.taskReference,
      waitingRun,
      command.data,
    );
    if (!prepared.ok) return sendDependencyOperatorError(reply, prepared.error);
    const resumed = await temporalRunService.resolveWait(params.data.taskReference, {
      runId: command.data.expectedRunId,
      nodeId: waitingRun.wait.nodeId,
      waitKind: waitingRun.wait.waitKind,
      resolution: prepared.value.resolution,
    });
    return resumed.ok
      ? sendTemporalState(reply, params.data.taskReference, resumed.value)
      : sendTemporalRunError(reply, resumed.error);
  });

  api.post('/api/workflows/:taskReference/resume', async (request, reply) => {
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }
    const command = ResumeRunCommandSchema.safeParse(request.body ?? {});
    if (!command.success) {
      return reply
        .code(400)
        .send(apiError('invalid_resume_guidance', 'Guidance must be non-empty when provided'));
    }
    const current = await temporalRunService.read(params.data.taskReference);
    if (!current.ok) return sendTemporalRunError(reply, current.error);
    if (current.value === null) {
      return sendTemporalRunError(reply, {
        kind: 'run_not_found',
        taskReference: params.data.taskReference,
      });
    }
    if (current.value.status !== 'waiting') {
      return reply
        .code(409)
        .send(apiError('run_not_waiting', 'The run is not waiting for an operator command'));
    }
    if (
      current.value.wait.waitKind === 'human_clarification' ||
      current.value.wait.waitKind === 'dependency.available@1' ||
      current.value.wait.waitKind === 'dependency.discovery@1' ||
      current.value.wait.waitKind === 'plan.approved@1' ||
      current.value.wait.waitKind === 'workflow_change.review@1' ||
      current.value.wait.waitKind === 'code_review@1'
    ) {
      return reply
        .code(409)
        .send(
          apiError(
            'typed_resolution_required',
            'Use the dedicated planning or workflow-review command for this wait',
          ),
        );
    }
    const resumed = await temporalRunService.resolveWait(params.data.taskReference, {
      runId: command.data.expectedRunId,
      nodeId: current.value.wait.nodeId,
      waitKind: current.value.wait.waitKind,
      resolution: {
        decision:
          command.data.dismissWorkflowChange === true ? 'dismiss_workflow_change' : 'resume',
        ...(command.data.guidance === undefined ? {} : { guidance: command.data.guidance }),
      },
    });
    return resumed.ok
      ? sendTemporalState(reply, params.data.taskReference, resumed.value)
      : sendTemporalRunError(reply, resumed.error);
  });

  api.post('/api/workflows/:taskReference/workflow-change-review', async (request, reply) => {
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }
    const command = WorkflowChangeReviewCommandSchema.safeParse(request.body);
    if (!command.success) {
      return reply
        .code(400)
        .send(apiError('invalid_workflow_change_review', 'Workflow change review is invalid'));
    }
    const current = await temporalRunService.read(params.data.taskReference);
    if (!current.ok) return sendTemporalRunError(reply, current.error);
    if (
      current.value === null ||
      current.value.runtime !== 'execution' ||
      current.value.status !== 'waiting' ||
      current.value.wait.waitKind !== 'workflow_change.review@1'
    ) {
      return reply
        .code(409)
        .send(
          apiError('run_not_at_workflow_change_review', 'No workflow change is awaiting review'),
        );
    }
    const candidate = current.value.continuations.find(
      ({ continuationId, status }) =>
        continuationId === command.data.continuationId && status === 'awaiting_review',
    );
    if (candidate === undefined) {
      return reply
        .code(409)
        .send(apiError('continuation_mismatch', 'The reviewed continuation is not active'));
    }
    const reviewed = await temporalRunService.resolveWait(params.data.taskReference, {
      runId: command.data.expectedRunId,
      nodeId: current.value.wait.nodeId,
      waitKind: current.value.wait.waitKind,
      resolution:
        command.data.decision === 'accept'
          ? { decision: 'accept', continuationId: candidate.continuationId }
          : {
              decision: 'reject',
              continuationId: candidate.continuationId,
              guidance: command.data.guidance,
            },
    });
    return reviewed.ok
      ? sendTemporalState(reply, params.data.taskReference, reviewed.value)
      : sendTemporalRunError(reply, reviewed.error);
  });

  api.post('/api/workflows/:taskReference/plan-review', async (request, reply) => {
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }
    const command = PlanReviewCommandSchema.safeParse(request.body);
    if (!command.success) {
      return reply
        .code(400)
        .send(apiError('invalid_plan_review', 'Approve or provide non-empty plan guidance'));
    }
    const lifecycle = await readCurrentLifecycle(params.data.taskReference, reply);
    if (reply.sent) return reply;
    const planningEpisodeId = currentPlanningEpisodeId(lifecycle);
    const planning =
      planningEpisodeId === null
        ? undefined
        : options.implementationPlanning?.read(planningEpisodeId);
    if (
      planning !== undefined &&
      (!planning.ok ||
        planning.value?.status !== 'ready' ||
        planning.value.artifactId !== command.data.planArtifactId ||
        planning.value.attempt !== command.data.planAttempt)
    ) {
      return reply
        .code(409)
        .send(apiError('stale_plan_review', 'Refresh and review the current planning attempt'));
    }
    const current = await temporalRunService.read(params.data.taskReference);
    if (!current.ok) return sendTemporalRunError(reply, current.error);
    if (
      current.value === null ||
      current.value.runtime !== 'bootstrap' ||
      current.value.status !== 'waiting' ||
      current.value.wait.waitKind !== 'plan.approved@1'
    ) {
      return reply
        .code(409)
        .send(apiError('run_not_at_plan_review', 'The run is not waiting for plan review'));
    }
    if (command.data.expectedRunId !== current.value.runId) {
      return reply.code(409).send(apiError('stale_run', 'Refresh before reviewing the plan'));
    }
    if (planningEpisodeId === null) {
      return reply
        .code(409)
        .send(apiError('stale_plan_review', 'The current run has no planning episode'));
    }
    const submitted = options.planReviews?.submit(
      planningEpisodeId,
      params.data.taskReference,
      command.data,
    );
    if (submitted !== undefined && !submitted.ok) {
      return reply
        .code(409)
        .send(apiError(submitted.error.kind, 'Plan review could not be stored'));
    }
    const reviewed = await temporalRunService.resolveWait(params.data.taskReference, {
      runId: command.data.expectedRunId,
      nodeId: current.value.wait.nodeId,
      waitKind: current.value.wait.waitKind,
      resolution: planReviewResolution(command.data),
    });
    if (!reviewed.ok) return sendTemporalRunError(reply, reviewed.error);
    const applied = options.planReviews?.markApplied(planningEpisodeId, command.data.reviewId);
    if (applied !== undefined && !applied.ok) {
      return reply
        .code(500)
        .send(apiError('plan_review_store_failed', 'Plan review was accepted but not projected'));
    }
    return sendTemporalState(reply, params.data.taskReference, reviewed.value);
  });

  api.get('/api/workflows/:taskReference/plan-reviews', async (request, reply) => {
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }
    if (options.planReviews === undefined) {
      return PlanReviewHistoryResponseSchema.parse({ rounds: [] });
    }
    const lifecycle = await readCurrentLifecycle(params.data.taskReference, reply);
    if (reply.sent) return reply;
    const planningEpisodeId = currentPlanningEpisodeId(lifecycle);
    if (planningEpisodeId === null) {
      return PlanReviewHistoryResponseSchema.parse({ rounds: [] });
    }
    const history = options.planReviews.read(planningEpisodeId);
    return history.ok
      ? PlanReviewHistoryResponseSchema.parse({ rounds: history.value })
      : reply.code(500).send(apiError(history.error.kind, 'Plan review history is unavailable'));
  });

  api.post('/api/workflows/:taskReference/planning-clarification', async (request, reply) => {
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }
    const command = PlanningClarificationSubmissionSchema.safeParse(request.body);
    if (!command.success) {
      return reply
        .code(400)
        .send(apiError('invalid_clarification_answers', 'Provide a non-empty answer per question'));
    }
    const current = await temporalRunService.read(params.data.taskReference);
    if (!current.ok) return sendTemporalRunError(reply, current.error);
    if (
      current.value === null ||
      current.value.runtime !== 'bootstrap' ||
      current.value.status !== 'waiting' ||
      current.value.wait.waitKind !== 'human_clarification' ||
      current.value.planning?.status !== 'needs_clarification'
    ) {
      return reply
        .code(409)
        .send(
          apiError(
            'run_not_at_planning_clarification',
            'The run is not waiting for planning clarification',
          ),
        );
    }
    const expected = new Set(current.value.planning.questions.map((question) => question.id));
    const received = new Set(command.data.answers.map((answer) => answer.questionId));
    if (
      received.size !== command.data.answers.length ||
      received.size !== expected.size ||
      [...received].some((questionId) => !expected.has(questionId))
    ) {
      return reply
        .code(400)
        .send(
          apiError(
            'invalid_clarification_answers',
            'Provide exactly one answer for every active planning question',
          ),
        );
    }
    const answered = await temporalRunService.resolveWait(params.data.taskReference, {
      runId: command.data.expectedRunId,
      nodeId: current.value.wait.nodeId,
      waitKind: current.value.wait.waitKind,
      resolution: { answers: command.data.answers },
    });
    return answered.ok
      ? sendTemporalState(reply, params.data.taskReference, answered.value)
      : sendTemporalRunError(reply, answered.error);
  });

  api.post('/api/workflows/:taskReference/generate', async (request, reply) => {
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }

    const command = RunStartCommandSchema.safeParse(
      request.body === undefined || request.body === null
        ? DEFAULT_RUN_START_COMMAND
        : request.body,
    );
    if (!command.success) {
      return reply.code(400).send(apiError('invalid_run_settings', 'Run settings are invalid'));
    }
    const started = await temporalRunService.start({
      schemaVersion: 3,
      taskReference: params.data.taskReference,
      settings: command.data.settings,
    });
    return started.ok
      ? sendTemporalState(reply, params.data.taskReference, started.value)
      : sendTemporalRunError(reply, started.error);
  });

  api.post('/api/workflows/:taskReference/restart', async (request, reply) => {
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }
    const command = RestartRunCommandSchema.safeParse(request.body);
    if (!command.success) {
      return reply
        .code(400)
        .send(
          apiError('restart_confirmation_required', 'Explicit restart confirmation is required'),
        );
    }
    const restarted = await temporalRunService.restart(
      params.data.taskReference,
      command.data.expectedRunId,
    );
    return restarted.ok
      ? sendTemporalState(reply, params.data.taskReference, restarted.value)
      : sendTemporalRunError(reply, restarted.error);
  });

  api.get('/api/workflows/:taskReference/graph.json', async (request, reply) => {
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }

    const lifecycle = await readCurrentLifecycle(params.data.taskReference, reply);
    if (reply.sent) return reply;
    const operationId =
      lifecycle?.bootstrap.planning?.status === 'ready'
        ? lifecycle.bootstrap.planning.workflowOperationId
        : null;
    const result =
      operationId === null
        ? { ok: true as const, value: null }
        : options.service.readPlanningOperation(params.data.taskReference, operationId);
    if (!result.ok) return sendServiceError(reply, result.error);
    if (result.value === null) {
      return reply.code(404).send(apiError('workflow_not_found', 'Generate this workflow first'));
    }
    if (result.value.status === 'rejected') {
      return reply
        .code(409)
        .send(apiError('workflow_rejected', 'Rejected graphs cannot be downloaded'));
    }

    return reply
      .header(
        'content-disposition',
        `attachment; filename="${params.data.taskReference}-graph.json"`,
      )
      .type('application/json; charset=utf-8')
      .send(result.value.view.workflow.graph);
  });

  api.get('/api/graphs/:taskReference', async (request, reply) => {
    const params = TaskReferenceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(apiError('invalid_request', 'taskReference is required'));
    }

    const lifecycle = await readCurrentLifecycle(params.data.taskReference, reply);
    if (reply.sent) return reply;
    const operationId =
      lifecycle?.bootstrap.planning?.status === 'ready'
        ? lifecycle.bootstrap.planning.workflowOperationId
        : null;
    const result =
      operationId === null
        ? { ok: true as const, value: null }
        : options.service.readPlanningOperation(params.data.taskReference, operationId);
    if (!result.ok) return sendServiceError(reply, result.error);
    if (result.value === null) {
      return reply.code(404).send(apiError('workflow_not_found', 'Generate this workflow first'));
    }

    return reply.send(result.value.view.workflow);
  });

  if (options.cockpitDirectory !== undefined) {
    api.get('/', async (_request, reply) => {
      const body = await readFile(join(options.cockpitDirectory as string, 'index.html'));
      return reply.type('text/html; charset=utf-8').send(body);
    });

    api.get('/assets/*', async (request, reply) => {
      const params = AssetParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(404).send();
      }

      const filename = resolveCockpitAsset(options.cockpitDirectory as string, params.data['*']);
      if (filename === null) {
        return reply.code(404).send();
      }

      let body: Buffer;
      try {
        body = await readFile(filename);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return reply.code(404).send();
        }
        throw error;
      }

      return reply.type(contentType(filename)).send(body);
    });
  }

  return api;
};
