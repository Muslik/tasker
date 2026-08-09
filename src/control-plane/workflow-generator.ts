import type { JiraIssueService, JiraWorkflowPlanningSource } from '../integrations/index.js';
import { findTaskFixture, TaskFixtureSchema, type EvidenceBundle } from '../planning/index.js';
import type {
  WorkflowAnalyzerFailure,
  WorkflowAnalyzerRequest,
  WorkflowAnalyzerSuccess,
} from '../providers/index.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { JsonValueSchema, type JsonValue } from '../workflow/index.js';
import { WorkflowGenerationSubjectSchema, type WorkflowGenerationSubject } from './m1-contracts.js';
import type { M1ServiceError, M1WorkflowService } from './m1-service.js';
import type { EvidenceBundleStoreError } from './evidence-bundle.js';

export type { WorkflowGenerationSubject } from './m1-contracts.js';

export interface WorkflowAnalyzer {
  analyze(
    request: WorkflowAnalyzerRequest,
  ): Promise<Outcome<WorkflowAnalyzerSuccess, WorkflowAnalyzerFailure>>;
}

export interface WorkflowContextDiscovery {
  discover(input: {
    readonly taskReference: string;
    readonly operationId: string;
    readonly taskSnapshot: JsonValue;
    readonly plannerContext: JsonValue;
    readonly repositoryReference: string;
    readonly repositoryPath: string;
  }): Promise<Outcome<{ readonly bundle: EvidenceBundle }, EvidenceBundleStoreError>>;
}

const qualifiedRepositoryReference = (aliases: readonly string[]): string | null =>
  aliases.find((alias) => alias.includes('/')) ?? null;

const taskFromJira = (
  reference: string,
  issue: Extract<JiraWorkflowPlanningSource, { readonly status: 'ready' }>,
): Outcome<WorkflowGenerationSubject, M1ServiceError> => {
  const repository = qualifiedRepositoryReference(issue.binding.repository.aliases);
  if (repository === null) {
    return err({
      kind: 'generation_blocked',
      taskReference: reference,
      reason: 'The managed repository has no qualified project/repository identity',
    });
  }

  const isBug = issue.issue.issueType.toLocaleLowerCase('en-US') === 'bug';
  const task = TaskFixtureSchema.parse({
    origin: 'jira',
    fixtureId: reference,
    taskId: issue.issue.issueKey,
    title: issue.issue.summary,
    description: issue.issue.description.trim() || issue.issue.summary,
    repository,
    translationIntent: 'none',
    ...(isBug
      ? { family: 'short_bugfix', reproduction: 'required', verification: 'targeted' }
      : { family: 'feature_with_review', verification: 'full' }),
    expected: 'accepted',
    proposalVariant: 'valid',
  });

  return ok({
    schemaVersion: 1,
    repositoryPath: issue.binding.repository.checkout.path,
    task,
    taskSnapshot: JsonValueSchema.parse({
      origin: 'jira',
      issue: issue.issue,
      repository: {
        reference: repository,
        repositoryId: issue.binding.repository.repositoryId,
        remoteUrl: issue.binding.repository.remoteUrl,
      },
      admission: {
        family: task.family,
        note: 'Admission supplies task facts only; the analyzer assembles a complete task-specific graph from the registered catalog.',
      },
    }),
  });
};

export class WorkflowGenerationSubjectSource {
  public constructor(
    private readonly fixtureRepositoryPath: string,
    private readonly jiraIssueService?: JiraIssueService,
    private readonly dynamicSubjects?: Pick<M1WorkflowService, 'readGenerationSubject'>,
  ) {}

  public resolve(taskReference: string): Outcome<WorkflowGenerationSubject, M1ServiceError> {
    const fixture = findTaskFixture(taskReference);
    if (fixture !== undefined) {
      return ok({
        schemaVersion: 1,
        repositoryPath: this.fixtureRepositoryPath,
        task: fixture,
        taskSnapshot: JsonValueSchema.parse(fixture),
      });
    }

    const dynamic = this.dynamicSubjects?.readGenerationSubject(taskReference);
    if (dynamic !== undefined) {
      if (!dynamic.ok) return dynamic;
      if (dynamic.value !== null) return ok(WorkflowGenerationSubjectSchema.parse(dynamic.value));
    }

    if (!taskReference.startsWith('jira:') || this.jiraIssueService === undefined) {
      return err({ kind: 'task_not_found', taskReference });
    }

    const source = this.jiraIssueService.readWorkflowPlanningSource(
      taskReference.slice('jira:'.length),
    );
    if (!source.ok) {
      return source.error.kind === 'issue_not_imported'
        ? err({ kind: 'task_not_found', taskReference })
        : err({
            kind: 'generation_blocked',
            taskReference,
            reason: `Jira planning source failed: ${source.error.kind}`,
          });
    }
    if (source.value.status === 'blocked') {
      return err({
        kind: 'generation_blocked',
        taskReference,
        reason: source.value.reason,
      });
    }

    return taskFromJira(taskReference, source.value);
  }
}

export const providerFailureSummary = (failure: WorkflowAnalyzerFailure): string => {
  switch (failure.kind) {
    case 'provider_unavailable':
      return failure.message;
    case 'provider_timed_out':
      return `Agent provider timed out after ${String(Math.round(failure.durationMs))} ms`;
    case 'provider_failed':
      return failure.message;
    case 'invalid_event_stream':
      return failure.message;
    case 'invalid_analyzer_output':
      return failure.issues.join('; ');
  }
};
