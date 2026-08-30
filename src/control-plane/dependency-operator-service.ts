import { z } from 'zod';

import { dependencyWaitInputSchema } from '../harness/step-contracts.js';
import type {
  NexusPackageObservationProblem,
  NexusPackageObserverPort,
} from '../integrations/nexus/index.js';
import { checksumString } from '../ledger/checksum.js';
import type { LedgerRepository } from '../ledger/repository.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import type { ExecutionWorkflowPublicState, TaskRunLifecycle } from '../temporal/index.js';
import { TaskStepOutputArtifactSchema } from '../temporal/task-step-output.js';
import type { CompiledWorkflowNode } from '../workflow/index.js';
import {
  WorkflowChangeRequestSchema,
  type WorkflowChangeRequest,
} from '../workflow/execution-result.js';
import {
  type DependencyAvailableCommand,
  type DependencyDiscoveryCommand,
} from './operator-contracts.js';
import { dependencyDeclarationIdFor } from './dependency-declaration.js';
import type {
  DependencyDeclarationStore,
  DependencyDeclaration,
  DependencyDeclarationStoreError,
  RecordDependencyDeclarationInput,
} from './dependency-declaration.js';
import type {
  VerifiedPackagePublicationStore,
  VerifiedPackagePublication,
  VerifiedPackagePublicationStoreError,
} from './verified-package-publication.js';

type DependencyAvailableWaitInput = z.infer<typeof dependencyWaitInputSchema>;
type CrossRepositoryDependencyChange = Extract<
  WorkflowChangeRequest['changes'][number],
  { readonly kind: 'cross_repository_dependency' }
>;

export type DependencyOperatorServiceError =
  | { readonly kind: 'wait_input_unavailable'; readonly waitKind: string; readonly nodeId: string }
  | {
      readonly kind: 'wait_input_mismatch';
      readonly waitKind: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'dependency_declaration_not_found';
      readonly declarationId: string;
      readonly declarationRevision: number;
    }
  | {
      readonly kind: 'dependency_declaration_mismatch';
      readonly reason: string;
    }
  | {
      readonly kind: 'dependency_request_mismatch';
      readonly declarationId: string;
    }
  | {
      readonly kind: 'dependency_declaration_store_failed';
      readonly error: DependencyDeclarationStoreError;
    }
  | {
      readonly kind: 'verified_package_publication_store_failed';
      readonly error: VerifiedPackagePublicationStoreError;
    }
  | {
      readonly kind: 'nexus_observation_failed';
      readonly problem: NexusPackageObservationProblem;
    };

export interface DependencyAvailableResolution {
  readonly observation: VerifiedPackagePublication;
  readonly resolution: {
    readonly decision: 'recheck';
    readonly declarationId: string;
    readonly declarationRevision: number;
    readonly observationId: string;
  };
}

export interface DependencyDiscoveryResolution {
  readonly declaration: DependencyDeclaration;
  readonly resolution: {
    readonly decision: 'configured';
    readonly requestArtifactId: string;
    readonly declarationId: string;
  };
}

type WaitingExecutionWorkflowRun = Extract<
  ExecutionWorkflowPublicState,
  { readonly status: 'waiting' }
>;
type ArtifactReader = Pick<LedgerRepository, 'readArtifact'>;
type ArtifactPayload = { readonly payload: unknown };
const ContinuationRequestArtifactSchema = TaskStepOutputArtifactSchema.extend({
  details: z.object({ request: WorkflowChangeRequestSchema }).loose(),
});

const childrenFor = (node: CompiledWorkflowNode): readonly CompiledWorkflowNode[] => {
  switch (node.kind) {
    case 'sequence':
      return node.children;
    case 'bounded_loop':
      return [node.body];
    case 'finalize':
    case 'step':
      return [];
  }
};

const findNode = (node: CompiledWorkflowNode, nodeId: string): CompiledWorkflowNode | null => {
  if (node.id === nodeId) return node;
  for (const child of childrenFor(node)) {
    const found = findNode(child, nodeId);
    if (found !== null) return found;
  }
  return null;
};

const readExecutionNode = (
  lifecycle: TaskRunLifecycle,
  nodeId: string,
): CompiledWorkflowNode | null => {
  const graph = lifecycle.bootstrap.draft?.graph;
  return graph === undefined ? null : findNode(graph.root, nodeId);
};

const readAvailableWaitInput = (
  lifecycle: TaskRunLifecycle,
  nodeId: string,
): DependencyAvailableWaitInput | null => {
  const executionNode = readExecutionNode(lifecycle, nodeId);
  if (executionNode?.kind !== 'step') return null;
  const parsed = dependencyWaitInputSchema.safeParse(executionNode.with);
  return parsed.success ? parsed.data : null;
};

const normalizedPackageNames = (packages: readonly string[]): readonly string[] =>
  [...packages].sort((left, right) => left.localeCompare(right));

const packageNamesEqual = (left: readonly string[], right: readonly string[]): boolean => {
  const normalizedLeft = normalizedPackageNames(left);
  const normalizedRight = normalizedPackageNames(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((packageName, index) => packageName === normalizedRight[index])
  );
};

const packageVersionFingerprint = (
  packages: readonly { readonly name: string; readonly version: string }[],
): string =>
  checksumString(
    [...packages]
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
      )
      .map(({ name, version }) => `${name}@${version}`)
      .join('\n'),
  );

const normalizePublicationIntegrity = (integrity: string | null, shasum: string | null): string => {
  if (integrity !== null) return integrity;
  if (shasum !== null) return `sha1-${shasum}`;
  throw new Error('Nexus observation omitted integrity and shasum');
};

const sameTaskLevelDeclaration = (
  declaration: DependencyDeclaration,
  input: RecordDependencyDeclarationInput,
): boolean => {
  if (
    declaration.consumerTaskReference !== input.consumerTaskReference ||
    declaration.producerTaskReference !== input.producerTaskReference ||
    declaration.producerRepository !== input.producerRepository ||
    declaration.mode !== input.mode ||
    declaration.source.kind !== input.source.kind ||
    !packageNamesEqual(declaration.packages, input.packages)
  ) {
    return false;
  }
  switch (declaration.source.kind) {
    case 'jira_link':
      return (
        input.source.kind === 'jira_link' &&
        declaration.source.linkId === input.source.linkId &&
        declaration.source.linkTypeId === input.source.linkTypeId &&
        declaration.source.direction === input.source.direction
      );
    case 'runtime_discovery':
      return (
        input.source.kind === 'runtime_discovery' &&
        declaration.source.requestArtifactId === input.source.requestArtifactId
      );
  }
};

const sourceOperationIdFor = (
  run: ExecutionWorkflowPublicState,
  command: DependencyAvailableCommand,
): string =>
  [
    'operator',
    'dependency.available',
    run.runId,
    command.nodeId,
    command.declarationId,
    `revision-${String(command.declarationRevision)}`,
    command.channel,
    packageVersionFingerprint(command.packages),
  ].join(':');

const packageNameForComponentPath = (componentPath: string): string | null => {
  const segments = componentPath.split('/').filter((segment) => segment.length > 0);
  if (segments[0] !== 'packages') return null;
  const packageRoot = segments[1];
  if (packageRoot === undefined) return null;
  if (packageRoot.startsWith('@')) {
    const packageName = segments[2];
    return packageName === undefined ? null : `${packageRoot}/${packageName}`;
  }
  return packageRoot;
};

const readCrossRepositoryDependencyRequest = (
  run: WaitingExecutionWorkflowRun,
  readArtifact: (artifactId: string) => ArtifactPayload | null,
): {
  readonly requestArtifactId: string;
  readonly requestedRepository: string;
  readonly requestedOutcome: string;
  readonly componentPath: string | null;
  readonly expectedPackage: string | null;
} | null => {
  const continuation = run.continuations.findLast(({ status }) => status === 'needs_input');
  if (continuation === undefined) return null;
  const artifact = readArtifact(continuation.requestReference);
  if (artifact === null) return null;
  const parsed = ContinuationRequestArtifactSchema.safeParse(artifact.payload);
  if (!parsed.success) return null;
  const change = parsed.data.details.request.changes.find(
    (item): item is CrossRepositoryDependencyChange => item.kind === 'cross_repository_dependency',
  );
  if (change === undefined) return null;
  return {
    requestArtifactId: continuation.requestReference,
    requestedRepository: change.repository,
    requestedOutcome: change.requestedOutcome,
    componentPath: change.componentPath ?? null,
    expectedPackage:
      change.componentPath === undefined ? null : packageNameForComponentPath(change.componentPath),
  };
};

export const describeDependencyAvailableWait = (
  lifecycle: TaskRunLifecycle,
  nodeId: string,
  readObservation: (observationId: string) => VerifiedPackagePublication | null,
) => {
  const input = readAvailableWaitInput(lifecycle, nodeId);
  if (input === null) return null;
  const observation =
    input.afterObservationId === undefined ? null : readObservation(input.afterObservationId);
  return {
    kind: 'dependency_available' as const,
    declarationId: input.declarationId,
    declarationRevision: input.declarationRevision,
    channel: input.channel,
    packages: input.packages,
    observation:
      observation === null
        ? {
            status: 'missing' as const,
            observationId: null,
            observedAt: null,
            provenance: null,
            packages: [],
          }
        : {
            status: 'recorded' as const,
            observationId: observation.observationId,
            observedAt: observation.observedAt,
            provenance: observation.provenance ?? null,
            packages: observation.packages,
          },
  };
};

export const describeDependencyDiscoveryWait = (
  taskReference: string,
  run: WaitingExecutionWorkflowRun,
  readLatestDeclaration: (declarationId: string) => DependencyDeclaration | null,
  readArtifact: (artifactId: string) => ArtifactPayload | null,
) => {
  const request = readCrossRepositoryDependencyRequest(run, readArtifact);
  if (request === null) return null;
  const declarationId = dependencyDeclarationIdFor(taskReference, {
    kind: 'runtime_discovery',
    workflowRunId: run.runId,
    requestArtifactId: request.requestArtifactId,
  });
  const declaration = readLatestDeclaration(declarationId);
  return {
    kind: 'dependency_discovery' as const,
    requestArtifactId: request.requestArtifactId,
    requestedRepository: request.requestedRepository,
    requestedOutcome: request.requestedOutcome,
    componentPath: request.componentPath,
    expectedPackage: request.expectedPackage,
    declaration:
      declaration === null
        ? {
            status: 'missing' as const,
            declarationId: null,
            declarationRevision: null,
            producerTaskReference: null,
            producerRepository: null,
            packages: [],
            mode: null,
          }
        : {
            status: 'recorded' as const,
            declarationId: declaration.declarationId,
            declarationRevision: declaration.revision,
            producerTaskReference: declaration.producerTaskReference,
            producerRepository: declaration.producerRepository,
            packages: declaration.packages,
            mode: declaration.mode,
          },
  };
};

export class DependencyOperatorService {
  public constructor(
    private readonly declarations: Pick<
      DependencyDeclarationStore,
      'declare' | 'readLatest' | 'readRevision'
    >,
    private readonly artifacts: ArtifactReader,
    private readonly publications: Pick<
      VerifiedPackagePublicationStore,
      'readByExternalIdentity' | 'record'
    >,
    private readonly observer: NexusPackageObserverPort,
  ) {}

  public configureTaskDependency(
    input: RecordDependencyDeclarationInput,
  ): Outcome<DependencyDeclaration, DependencyOperatorServiceError> {
    const declared = this.declarations.declare(input);
    return declared.ok
      ? declared
      : err({
          kind: 'dependency_declaration_store_failed',
          error: declared.error,
        });
  }

  public prepareDiscoveryResolution(
    taskReference: string,
    run: WaitingExecutionWorkflowRun,
    command: DependencyDiscoveryCommand,
  ): Outcome<DependencyDiscoveryResolution, DependencyOperatorServiceError> {
    const request = readCrossRepositoryDependencyRequest(
      run,
      this.artifacts.readArtifact.bind(this.artifacts),
    );
    if (request === null) {
      return err({
        kind: 'wait_input_unavailable',
        waitKind: run.wait.waitKind,
        nodeId: run.wait.nodeId,
      });
    }
    if (
      request.requestArtifactId !== command.requestArtifactId ||
      request.requestedRepository !== command.producerRepository ||
      (request.expectedPackage !== null && !command.packages.includes(request.expectedPackage))
    ) {
      return err({
        kind: 'wait_input_mismatch',
        waitKind: run.wait.waitKind,
        reason:
          'The submitted dependency declaration does not match the active workflow-change request',
      });
    }
    const declarationInput: RecordDependencyDeclarationInput = {
      consumerTaskReference: taskReference,
      producerTaskReference: command.producerTaskReference,
      producerRepository: command.producerRepository,
      packages: command.packages,
      mode: command.mode,
      source: {
        kind: 'runtime_discovery',
        workflowRunId: run.runId,
        requestArtifactId: command.requestArtifactId,
      },
    };
    const declarationId = dependencyDeclarationIdFor(taskReference, declarationInput.source);
    const existing = this.declarations.readLatest(declarationId);
    if (!existing.ok) {
      return err({
        kind: 'dependency_declaration_store_failed',
        error: existing.error,
      });
    }
    if (existing.value !== null && !sameTaskLevelDeclaration(existing.value, declarationInput)) {
      return err({
        kind: 'dependency_request_mismatch',
        declarationId,
      });
    }
    const declaration =
      existing.value === null ? this.declarations.declare(declarationInput) : ok(existing.value);
    if (!declaration.ok) {
      return err({
        kind: 'dependency_declaration_store_failed',
        error: declaration.error,
      });
    }
    return ok({
      declaration: declaration.value,
      resolution: {
        decision: 'configured',
        requestArtifactId: command.requestArtifactId,
        declarationId: declaration.value.declarationId,
      },
    });
  }

  public async prepareAvailableResolution(
    taskReference: string,
    lifecycle: TaskRunLifecycle,
    run: WaitingExecutionWorkflowRun,
    command: DependencyAvailableCommand,
  ): Promise<Outcome<DependencyAvailableResolution, DependencyOperatorServiceError>> {
    const waitInput = readAvailableWaitInput(lifecycle, run.wait.nodeId);
    if (waitInput === null) {
      return err({
        kind: 'wait_input_unavailable',
        waitKind: run.wait.waitKind,
        nodeId: run.wait.nodeId,
      });
    }
    if (
      waitInput.declarationId !== command.declarationId ||
      waitInput.declarationRevision !== command.declarationRevision ||
      waitInput.channel !== command.channel ||
      !packageNamesEqual(
        waitInput.packages,
        command.packages.map(({ name }) => name),
      )
    ) {
      return err({
        kind: 'wait_input_mismatch',
        waitKind: run.wait.waitKind,
        reason: 'The submitted published versions do not match the active dependency wait',
      });
    }
    const declaration = this.declarations.readRevision(
      command.declarationId,
      command.declarationRevision,
    );
    if (!declaration.ok) {
      return err({
        kind: 'dependency_declaration_store_failed',
        error: declaration.error,
      });
    }
    if (declaration.value === null) {
      return err({
        kind: 'dependency_declaration_not_found',
        declarationId: command.declarationId,
        declarationRevision: command.declarationRevision,
      });
    }
    if (
      declaration.value.consumerTaskReference !== taskReference ||
      !packageNamesEqual(
        declaration.value.packages,
        command.packages.map(({ name }) => name),
      )
    ) {
      return err({
        kind: 'dependency_declaration_mismatch',
        reason: 'The requested declaration revision does not belong to this task and package set',
      });
    }

    const externalIdentityInput = {
      sourceOperationId: sourceOperationIdFor(run, command),
      ...(command.provenance === undefined ? {} : { provenance: command.provenance }),
    } as const;
    const existing = this.publications.readByExternalIdentity(externalIdentityInput);
    if (!existing.ok) {
      return err({
        kind: 'verified_package_publication_store_failed',
        error: existing.error,
      });
    }
    if (existing.value !== null) {
      return ok({
        observation: existing.value,
        resolution: {
          decision: 'recheck',
          declarationId: existing.value.declarationId,
          declarationRevision: existing.value.declarationRevision,
          observationId: existing.value.observationId,
        },
      });
    }

    const observed = await this.observer.observe({
      channel: command.channel,
      packages: command.packages.map(({ name, version }) => ({
        packageName: name,
        version,
      })),
    });
    if (!observed.ok) {
      return err({
        kind: 'nexus_observation_failed',
        problem: observed.error,
      });
    }

    const recorded = this.publications.record({
      declarationId: command.declarationId,
      declarationRevision: command.declarationRevision,
      producerTaskReference: declaration.value.producerTaskReference,
      channel: command.channel,
      packages: observed.value.packages.map((item) => ({
        name: item.packageName,
        version: item.version,
        registry: item.registry,
        tarballUrl: item.tarballUrl,
        integrity: normalizePublicationIntegrity(item.integrity, item.shasum),
      })),
      sourceOperationId: externalIdentityInput.sourceOperationId,
      ...(command.provenance === undefined ? {} : { provenance: command.provenance }),
    });
    if (!recorded.ok) {
      return err({
        kind: 'verified_package_publication_store_failed',
        error: recorded.error,
      });
    }
    return ok({
      observation: recorded.value,
      resolution: {
        decision: 'recheck',
        declarationId: recorded.value.declarationId,
        declarationRevision: recorded.value.declarationRevision,
        observationId: recorded.value.observationId,
      },
    });
  }
}
