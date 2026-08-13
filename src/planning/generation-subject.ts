import { z } from 'zod';

import { err, ok, type Outcome } from '../shared/outcome.js';
import { JsonValueSchema } from '../workflow/schema.js';
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

export class WorkflowGenerationSubjectSource {
  public constructor(private readonly resolvers: readonly WorkflowGenerationSubjectResolver[]) {}

  public resolve(
    taskReference: string,
  ): Outcome<WorkflowGenerationSubject, WorkflowGenerationSubjectError> {
    for (const resolver of this.resolvers) {
      const resolved = resolver.resolve(taskReference);
      if (!resolved.ok) return resolved;
      if (resolved.value !== null) {
        return ok(WorkflowGenerationSubjectSchema.parse(resolved.value));
      }
    }
    return err({ kind: 'task_not_found', taskReference });
  }
}
