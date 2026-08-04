import type { JiraIssueService, JiraWorkflowPlanningSource } from '../integrations/index.js';
import {
  createWorkflowAnalyzerContext,
  findTaskFixture,
  TaskFixtureSchema,
} from '../planning/index.js';
import type {
  CodexWorkflowAnalyzerFailure,
  CodexWorkflowAnalyzerRequest,
  CodexWorkflowAnalyzerSuccess,
} from '../providers/index.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { JsonValueSchema } from '../workflow/index.js';
import {
  WorkflowGenerationSubjectSchema,
  type WorkflowGenerationSubject,
  type WorkflowResponse,
} from './m1-contracts.js';
import type { M1ServiceError, M1WorkflowService } from './m1-service.js';

export type { WorkflowGenerationSubject } from './m1-contracts.js';

export type WorkflowGenerationResult = Outcome<WorkflowResponse, M1ServiceError>;

export interface WorkflowGenerator {
  generate(taskReference: string): Promise<WorkflowGenerationResult>;
}

export interface WorkflowAnalyzer {
  analyze(
    request: CodexWorkflowAnalyzerRequest,
  ): Promise<Outcome<CodexWorkflowAnalyzerSuccess, CodexWorkflowAnalyzerFailure>>;
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

export class CodexWorkflowGenerator implements WorkflowGenerator {
  private readonly inFlight = new Map<string, Promise<WorkflowGenerationResult>>();

  public constructor(
    private readonly service: M1WorkflowService,
    private readonly subjects: WorkflowGenerationSubjectSource,
    private readonly analyzer?: WorkflowAnalyzer,
  ) {}

  public generate(taskReference: string): Promise<WorkflowGenerationResult> {
    const current = this.inFlight.get(taskReference);
    if (current !== undefined) return current;

    const generation = this.generateOnce(taskReference).finally(() => {
      this.inFlight.delete(taskReference);
    });
    this.inFlight.set(taskReference, generation);
    return generation;
  }

  private async generateOnce(taskReference: string): Promise<WorkflowGenerationResult> {
    const existing = this.service.read(taskReference);
    if (!existing.ok) return existing;
    if (existing.value?.status === 'ready') return { ok: true, value: existing.value };

    const subject = this.subjects.resolve(taskReference);
    if (!subject.ok) return subject;
    if (this.analyzer === undefined) return this.service.generateTask(subject.value.task);

    const analyzed = await this.analyzer.analyze({
      ...createWorkflowAnalyzerContext(subject.value.task, subject.value.taskSnapshot),
      repositoryPath: subject.value.repositoryPath,
    });
    if (!analyzed.ok) {
      return err({
        kind: 'provider_failure',
        provider: 'codex_cli',
        failure: analyzed.error,
      });
    }

    return this.service.generateFromAnalyzerOutputForTask(
      subject.value.task,
      analyzed.value.output,
      analyzed.value.receipt,
    );
  }
}

export const providerFailureSummary = (failure: CodexWorkflowAnalyzerFailure): string => {
  switch (failure.kind) {
    case 'provider_unavailable':
      return failure.message;
    case 'provider_timed_out':
      return `Codex timed out after ${String(Math.round(failure.durationMs))} ms`;
    case 'provider_failed':
      return failure.message;
    case 'invalid_event_stream':
      return failure.message;
    case 'invalid_analyzer_output':
      return failure.issues.join('; ');
  }
};
