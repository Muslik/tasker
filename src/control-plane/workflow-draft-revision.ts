import { createWorkflowAnalyzerContext } from '../planning/index.js';
import type { WorkflowChangeRequest } from '../planning/implementation-plan.js';
import type { RepositoryCatalog, RepositoryResolution } from '../repositories/index.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  CompiledWorkflowSchema,
  JsonValueSchema,
  type CompiledWorkflow,
} from '../workflow/index.js';
import type { WorkflowResponse } from './m1-contracts.js';
import type { M1WorkflowService } from './m1-service.js';
import type {
  WorkflowAnalyzer,
  WorkflowContextDiscovery,
  WorkflowGenerationSubjectSource,
} from './workflow-generator.js';

export type WorkflowDraftRevisionError =
  | { readonly kind: 'subject_unavailable'; readonly message: string; readonly retryable: boolean }
  | { readonly kind: 'draft_mismatch'; readonly message: string; readonly retryable: false }
  | {
      readonly kind: 'repository_unavailable';
      readonly message: string;
      readonly retryable: boolean;
    }
  | {
      readonly kind: 'context_discovery_failed';
      readonly message: string;
      readonly retryable: true;
    }
  | { readonly kind: 'analyzer_unavailable'; readonly message: string; readonly retryable: true }
  | { readonly kind: 'revision_rejected'; readonly message: string; readonly retryable: false }
  | {
      readonly kind: 'revision_not_represented';
      readonly message: string;
      readonly retryable: false;
    };

export interface WorkflowDraftRevision {
  readonly workflowHash: string;
  readonly graph: CompiledWorkflow;
}

const qualifiedAlias = (resolution: Extract<RepositoryResolution, { readonly status: 'found' }>) =>
  resolution.repository.aliases.find((alias) => alias.includes('/')) ?? null;

const revisionFrom = (
  candidate: WorkflowResponse,
  repositories: readonly string[],
  requiredCapabilities: readonly string[],
): Outcome<WorkflowDraftRevision, WorkflowDraftRevisionError> => {
  if (candidate.status !== 'ready') {
    return err({
      kind: 'revision_rejected',
      message: candidate.view.workflow.validatorReport.issues
        .map((issue) => issue.message)
        .join('; '),
      retryable: false,
    });
  }
  const workflowHash = candidate.view.workflow.graphHash;
  if (workflowHash === null) {
    return err({
      kind: 'revision_rejected',
      message: 'Workflow revision has no compiled graph hash.',
      retryable: false,
    });
  }
  const represented = JSON.stringify(candidate.view.workflow.graph);
  const missingRepository = repositories.find((repository) => !represented.includes(repository));
  const capabilities = new Set(candidate.view.workflow.capabilities.required);
  const missingCapability = requiredCapabilities.find(
    (capability) => !capabilities.has(capability),
  );
  if (missingRepository !== undefined || missingCapability !== undefined) {
    return err({
      kind: 'revision_not_represented',
      message:
        missingRepository !== undefined
          ? `Recompiled draft does not represent repository ${missingRepository}.`
          : `Recompiled draft does not require capability ${missingCapability ?? 'unknown'}.`,
      retryable: false,
    });
  }
  return ok({
    workflowHash,
    graph: CompiledWorkflowSchema.parse(candidate.view.workflow.graph),
  });
};

export class WorkflowDraftRevisionCoordinator {
  public constructor(
    private readonly workflows: M1WorkflowService,
    private readonly subjects: WorkflowGenerationSubjectSource,
    private readonly analyzer: WorkflowAnalyzer | undefined,
    private readonly contextDiscovery: WorkflowContextDiscovery,
    private readonly repositories: RepositoryCatalog | undefined,
  ) {}

  public async revise(input: {
    readonly taskReference: string;
    readonly expectedWorkflowHash: string;
    readonly request: WorkflowChangeRequest;
    readonly operationId: string;
  }): Promise<Outcome<WorkflowDraftRevision, WorkflowDraftRevisionError>> {
    const completed = this.workflows.readPlanningOperation(input.taskReference, input.operationId);
    if (!completed.ok) {
      return err({
        kind: 'subject_unavailable',
        message: `Workflow operation store failed: ${completed.error.kind}`,
        retryable: completed.error.kind === 'store_failure',
      });
    }
    if (completed.value !== null) {
      return revisionFrom(
        completed.value,
        input.request.discoveredRepositories,
        input.request.requiredCapabilities,
      );
    }
    const current = this.workflows.read(input.taskReference);
    if (!current.ok) {
      return err({
        kind: 'subject_unavailable',
        message: `Workflow store failed: ${current.error.kind}`,
        retryable: current.error.kind === 'store_failure',
      });
    }
    if (
      current.value?.status !== 'ready' ||
      current.value.view.workflow.graphHash !== input.expectedWorkflowHash
    ) {
      return err({
        kind: 'draft_mismatch',
        message: 'The proposed revision does not target the current workflow draft.',
        retryable: false,
      });
    }
    const subject = this.subjects.resolve(input.taskReference);
    if (!subject.ok) {
      return err({
        kind: 'subject_unavailable',
        message: `Task subject failed: ${subject.error.kind}`,
        retryable: subject.error.kind === 'store_failure',
      });
    }
    if (this.analyzer === undefined) {
      return err({
        kind: 'analyzer_unavailable',
        message: 'Workflow draft revision requires an analyzer provider.',
        retryable: true,
      });
    }

    const taskSnapshot = JsonValueSchema.parse({
      origin: 'workflow_draft_revision',
      parentTaskSnapshot: subject.value.taskSnapshot,
      currentDraft: {
        graphHash: input.expectedWorkflowHash,
        workflow: current.value.view.workflow,
      },
      workflowChange: input.request,
      operationId: input.operationId,
    });
    const analyzerContext = createWorkflowAnalyzerContext(subject.value.task, taskSnapshot);
    const targets = await this.resolveTargets(
      subject.value.task.repository,
      subject.value.repositoryPath,
      input.request.discoveredRepositories,
    );
    if (!targets.ok) return targets;

    let bundle = null;
    for (const target of targets.value) {
      const discovered = await this.contextDiscovery.discover({
        taskReference: input.taskReference,
        operationId: input.operationId,
        taskSnapshot,
        plannerContext: analyzerContext.plannerContext,
        repositoryReference: target.reference,
        repositoryPath: target.path,
      });
      if (!discovered.ok) {
        return err({
          kind: 'context_discovery_failed',
          message: `Context discovery failed: ${discovered.error.kind}`,
          retryable: true,
        });
      }
      bundle = discovered.value.bundle;
    }
    if (bundle === null) {
      return err({
        kind: 'context_discovery_failed',
        message: 'Draft revision collected no repository context.',
        retryable: true,
      });
    }

    const analyzed = await this.analyzer.analyze({
      ...analyzerContext,
      repositoryPath: subject.value.repositoryPath,
      repositoryReference: subject.value.task.repository,
      evidenceBundle: bundle,
    });
    if (!analyzed.ok) {
      return err({
        kind: 'analyzer_unavailable',
        message: `Workflow analyzer failed: ${analyzed.error.kind}`,
        retryable: true,
      });
    }
    const revised = this.workflows.reviseFromAnalyzerOutputForTask(
      subject.value.task,
      analyzed.value.output,
      analyzed.value.receipt,
      input.operationId,
    );
    if (!revised.ok) {
      return err({
        kind: 'revision_rejected',
        message: `Workflow revision failed: ${revised.error.kind}`,
        retryable: false,
      });
    }
    return revisionFrom(
      revised.value,
      targets.value.map((target) => target.reference),
      input.request.requiredCapabilities,
    );
  }

  private async resolveTargets(
    primaryReference: string,
    primaryPath: string,
    discoveredReferences: readonly string[],
  ): Promise<
    Outcome<
      readonly { readonly reference: string; readonly path: string }[],
      WorkflowDraftRevisionError
    >
  > {
    const targets = [{ reference: primaryReference, path: primaryPath }];
    for (const requested of [...new Set(discoveredReferences)]) {
      if (requested === primaryReference) continue;
      if (this.repositories === undefined) {
        return err({
          kind: 'repository_unavailable',
          message: `No repository catalog can resolve ${requested}.`,
          retryable: true,
        });
      }
      const resolution = await this.repositories.resolve(requested);
      if (resolution.status !== 'found') {
        const retryable = resolution.status === 'unavailable' && resolution.problem.retryable;
        return err({
          kind: 'repository_unavailable',
          message: `Repository ${requested} resolution stopped: ${resolution.status}.`,
          retryable,
        });
      }
      const reference = qualifiedAlias(resolution);
      if (reference === null) {
        return err({
          kind: 'repository_unavailable',
          message: `Repository ${requested} has no qualified identity.`,
          retryable: false,
        });
      }
      targets.push({ reference, path: resolution.repository.checkout.path });
    }
    return ok(targets);
  }
}
