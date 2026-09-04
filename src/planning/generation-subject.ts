import { z } from 'zod';

import { err, ok, type Outcome } from '../shared/outcome.js';
import { JsonValueSchema } from '../graph/schema.js';
import { PlanningTaskSnapshotSchema } from './task-snapshot.js';

export const WorkflowGenerationSubjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    repositoryPath: z.string().min(1),
    task: PlanningTaskSnapshotSchema,
    taskSnapshot: JsonValueSchema,
  })
  .strict();

export type WorkflowGenerationSubject = z.infer<typeof WorkflowGenerationSubjectSchema>;

export type WorkflowGenerationSubjectError =
  | { readonly kind: 'task_not_found'; readonly taskReference: string }
  | {
      readonly kind: 'generation_blocked';
      readonly taskReference: string;
      readonly reason: string;
    };

export interface WorkflowGenerationSubjectResolver {
  resolve(
    taskReference: string,
  ): Outcome<WorkflowGenerationSubject | null, WorkflowGenerationSubjectError>;
}

export interface WorkflowGenerationSubjectRunStore {
  readRunGenerationSubject(
    taskReference: string,
    workflowRunId: string,
  ): Outcome<WorkflowGenerationSubject | null, { readonly kind: string }>;
  captureRunGenerationSubject(
    taskReference: string,
    workflowRunId: string,
    subject: WorkflowGenerationSubject,
  ): Outcome<WorkflowGenerationSubject, { readonly kind: string }>;
}

export class WorkflowGenerationSubjectSource {
  public constructor(
    private readonly resolvers: readonly WorkflowGenerationSubjectResolver[],
    private readonly runStore: WorkflowGenerationSubjectRunStore,
  ) {}

  public resolve(
    taskReference: string,
    workflowRunId: string,
  ): Outcome<WorkflowGenerationSubject, WorkflowGenerationSubjectError> {
    const persisted = this.runStore.readRunGenerationSubject(taskReference, workflowRunId);
    if (!persisted.ok) {
      return err({
        kind: 'generation_blocked',
        taskReference,
        reason: `Run-scoped planning subject is unavailable: ${persisted.error.kind}`,
      });
    }
    if (persisted.value !== null) return ok(persisted.value);

    for (const resolver of this.resolvers) {
      const resolved = resolver.resolve(taskReference);
      if (!resolved.ok) return resolved;
      if (resolved.value !== null) {
        const subject = WorkflowGenerationSubjectSchema.parse(resolved.value);
        const captured = this.runStore.captureRunGenerationSubject(
          taskReference,
          workflowRunId,
          subject,
        );
        return captured.ok
          ? ok(captured.value)
          : err({
              kind: 'generation_blocked',
              taskReference,
              reason: `Run-scoped planning subject could not be captured: ${captured.error.kind}`,
            });
      }
    }
    return err({ kind: 'task_not_found', taskReference });
  }
}
