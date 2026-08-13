import {
  PlanningTaskSnapshotSchema,
  WorkflowGenerationSubjectSchema,
  type WorkflowGenerationSubject,
  type WorkflowGenerationSubjectError,
  type WorkflowGenerationSubjectResolver,
} from '../../planning/index.js';
import { err, ok, type Outcome } from '../../shared/outcome.js';
import { JsonValueSchema } from '../../workflow/index.js';
import type { JiraIssueService, JiraWorkflowPlanningSource } from './service.js';

const qualifiedRepositoryReference = (aliases: readonly string[]): string | null =>
  aliases.find((alias) => alias.includes('/')) ?? null;

const subjectFromJira = (
  reference: string,
  issue: Extract<JiraWorkflowPlanningSource, { readonly status: 'ready' }>,
): Outcome<WorkflowGenerationSubject, WorkflowGenerationSubjectError> => {
  const repository = qualifiedRepositoryReference(issue.binding.repository.aliases);
  if (repository === null) {
    return err({
      kind: 'generation_blocked',
      taskReference: reference,
      reason: 'The managed repository has no qualified project/repository identity',
    });
  }
  const task = PlanningTaskSnapshotSchema.parse({
    schemaVersion: 1,
    origin: 'jira',
    reference,
    taskId: issue.issue.issueKey,
    title: issue.issue.summary,
    description: issue.issue.description.trim() || issue.issue.summary,
    repository,
    kind: issue.issue.issueType.toLocaleLowerCase('en-US') === 'bug' ? 'bug' : 'feature',
    labels: issue.issue.labels,
  });
  return ok(
    WorkflowGenerationSubjectSchema.parse({
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
      }),
    }),
  );
};

export class JiraWorkflowGenerationSubjectResolver implements WorkflowGenerationSubjectResolver {
  public constructor(private readonly issues: JiraIssueService) {}

  public resolve(
    taskReference: string,
  ): Outcome<WorkflowGenerationSubject | null, WorkflowGenerationSubjectError> {
    if (!taskReference.startsWith('jira:')) return ok(null);
    const source = this.issues.readWorkflowPlanningSource(taskReference.slice('jira:'.length));
    if (!source.ok) {
      return source.error.kind === 'issue_not_imported'
        ? ok(null)
        : err({
            kind: 'generation_blocked',
            taskReference,
            reason: `Jira planning source failed: ${source.error.kind}`,
          });
    }
    return source.value.status === 'blocked'
      ? err({ kind: 'generation_blocked', taskReference, reason: source.value.reason })
      : subjectFromJira(taskReference, source.value);
  }
}
