import {
  type WorkflowGenerationSubject,
  type WorkflowGenerationSubjectError,
  type WorkflowGenerationSubjectResolver,
} from '../planning/index.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { JsonValueSchema } from '../workflow/index.js';
import type {
  DependencyDeclarationStore,
  DependencyDeclarationStoreError,
} from './dependency-declaration.js';

const isJsonRecord = (
  value: WorkflowGenerationSubject['taskSnapshot'],
): value is Readonly<Record<string, WorkflowGenerationSubject['taskSnapshot']>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const generationBlocked = (
  taskReference: string,
  reason: string,
): Outcome<never, WorkflowGenerationSubjectError> =>
  err({
    kind: 'generation_blocked',
    taskReference,
    reason,
  });

const failureReason = (error: DependencyDeclarationStoreError): string => {
  switch (error.kind) {
    case 'record_corrupt':
      return `Dependency declarations are unavailable: ${error.kind}`;
    case 'ledger_conflict':
      return `Dependency declarations are unavailable: ${error.kind}`;
    case 'declaration_conflict':
      return `Dependency declarations are unavailable: ${error.kind}`;
  }
};

export class DependencyDeclarationGenerationSubjectResolver implements WorkflowGenerationSubjectResolver {
  public constructor(
    private readonly delegate: WorkflowGenerationSubjectResolver,
    private readonly declarations: Pick<DependencyDeclarationStore, 'listLatestByConsumerTask'>,
  ) {}

  public resolve(
    taskReference: string,
  ): Outcome<WorkflowGenerationSubject | null, WorkflowGenerationSubjectError> {
    const resolved = this.delegate.resolve(taskReference);
    if (!resolved.ok || resolved.value === null) return resolved;

    const declarations = this.declarations.listLatestByConsumerTask(taskReference);
    if (!declarations.ok)
      return generationBlocked(taskReference, failureReason(declarations.error));
    if (declarations.value.length === 0) return resolved;
    if (!isJsonRecord(resolved.value.taskSnapshot)) {
      return generationBlocked(
        taskReference,
        'Task snapshot is not an object and cannot include dependency declarations',
      );
    }

    return ok({
      ...resolved.value,
      taskSnapshot: JsonValueSchema.parse({
        ...resolved.value.taskSnapshot,
        dependencyDeclarations: declarations.value.map((declaration) => ({
          declarationId: declaration.declarationId,
          revision: declaration.revision,
          hash: declaration.hash,
          producerTaskReference: declaration.producerTaskReference,
          producerRepository: declaration.producerRepository,
          packages: declaration.packages,
          mode: declaration.mode,
          source: declaration.source,
        })),
      }),
    });
  }
}
