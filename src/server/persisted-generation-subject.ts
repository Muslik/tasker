import {
  type WorkflowGenerationSubject,
  type WorkflowGenerationSubjectError,
  type WorkflowGenerationSubjectResolver,
  type WorkflowGenerationSubjectRunStore,
} from '../planning/index.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import type { OperatorWorkflowService } from './operator-service.js';

export class PersistedGenerationSubjectResolver implements WorkflowGenerationSubjectResolver {
  public constructor(
    private readonly subjects: Pick<OperatorWorkflowService, 'readGenerationSubject'>,
  ) {}

  public resolve(
    taskReference: string,
  ): Outcome<WorkflowGenerationSubject | null, WorkflowGenerationSubjectError> {
    const subject = this.subjects.readGenerationSubject(taskReference);
    return subject.ok
      ? ok(subject.value)
      : err({
          kind: 'generation_blocked',
          taskReference,
          reason: `Persisted planning subject is unavailable: ${subject.error.kind}`,
        });
  }
}

export class PersistedGenerationSubjectRunStore implements WorkflowGenerationSubjectRunStore {
  public constructor(
    private readonly subjects: Pick<
      OperatorWorkflowService,
      'readRunGenerationSubject' | 'captureRunGenerationSubject'
    >,
  ) {}

  public readRunGenerationSubject(taskReference: string, workflowRunId: string) {
    return this.subjects.readRunGenerationSubject(taskReference, workflowRunId);
  }

  public captureRunGenerationSubject(
    taskReference: string,
    workflowRunId: string,
    subject: WorkflowGenerationSubject,
  ) {
    return this.subjects.captureRunGenerationSubject(taskReference, workflowRunId, subject);
  }
}
