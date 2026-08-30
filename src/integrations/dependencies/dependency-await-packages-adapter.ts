import { z } from 'zod';

import {
  type DependencyDeclaration,
  type DependencyDeclarationStore,
  type DependencyDeclarationStoreError,
} from '../../server/dependency-declaration.js';
import {
  type VerifiedPackagePublication,
  type VerifiedPackagePublicationStore,
  type VerifiedPackagePublicationStoreError,
} from '../../server/verified-package-publication.js';
import { dependencyWaitInputSchema } from '../../harness/step-contracts.js';
import { JsonValueSchema } from '../../graph/schema.js';
import type {
  IntegrationStepAdapter,
  IntegrationStepExecutionRequest,
  IntegrationStepExecutionResult,
} from '../execution.js';

const DependencyAvailableResolutionSchema = z
  .object({
    decision: z.literal('recheck'),
    declarationId: z.string().min(1),
    declarationRevision: z.number().int().positive(),
    observationId: z.string().min(1),
  })
  .strict();

type DependencyWaitInput = z.infer<typeof dependencyWaitInputSchema>;

const asJson = (value: unknown) => JsonValueSchema.parse(value);

const sortPackageNames = (packages: readonly string[]): readonly string[] => [...packages].sort();

const samePackageNames = (left: readonly string[], right: readonly string[]): boolean => {
  const leftNames = sortPackageNames(left);
  const rightNames = sortPackageNames(right);
  return (
    leftNames.length === rightNames.length &&
    leftNames.every((packageName, index) => packageName === rightNames[index])
  );
};

const packageNamesFromPublication = (publication: VerifiedPackagePublication): readonly string[] =>
  publication.packages.map(({ name }) => name);

const isChannelAllowed = (
  declaration: DependencyDeclaration,
  channel: DependencyWaitInput['channel'],
): boolean => channel === 'final' || declaration.mode === 'validate_dev_then_final';

const blocked = (summary: string, details: unknown): IntegrationStepExecutionResult => ({
  status: 'blocked',
  kind: 'invalid_request',
  summary,
  details: asJson(details),
  artifactIds: [],
});

const storeFailure = (
  scope: 'declaration' | 'publication',
  error: DependencyDeclarationStoreError | VerifiedPackagePublicationStoreError,
): IntegrationStepExecutionResult => ({
  status: 'blocked',
  kind: 'infrastructure',
  summary: `Dependency ${scope} state cannot be read`,
  details: asJson({ scope, error }),
  artifactIds: [],
});

const waiting = (
  declaration: DependencyDeclaration,
  input: DependencyWaitInput,
): IntegrationStepExecutionResult => ({
  status: 'waiting',
  waitKind: 'dependency.available@1',
  summary: `Dependency publication for ${input.channel} channel is waiting for verification`,
  category: 'dependency',
  retryable: false,
  details: asJson({
    declarationId: declaration.declarationId,
    declarationRevision: declaration.revision,
    producerTaskReference: declaration.producerTaskReference,
    channel: input.channel,
    packages: [...sortPackageNames(input.packages)],
    ...(input.afterObservationId === undefined
      ? {}
      : { afterObservationId: input.afterObservationId }),
  }),
  artifactIds: [],
});

const completed = (publication: VerifiedPackagePublication): IntegrationStepExecutionResult => ({
  status: 'completed',
  summary: `Dependency publication ${publication.observationId} is verified`,
  output: {
    outcome: 'verified',
    observationId: publication.observationId,
    declarationId: publication.declarationId,
    declarationRevision: publication.declarationRevision,
    channel: publication.channel,
    packages: publication.packages,
  },
  artifactIds: [publication.observationId],
});

const publicationMatches = (
  publication: VerifiedPackagePublication,
  declaration: DependencyDeclaration,
  input: DependencyWaitInput,
): boolean =>
  publication.declarationId === declaration.declarationId &&
  publication.declarationRevision === declaration.revision &&
  publication.producerTaskReference === declaration.producerTaskReference &&
  publication.channel === input.channel &&
  samePackageNames(packageNamesFromPublication(publication), input.packages);

export class DependencyAwaitPackagesAdapter implements IntegrationStepAdapter {
  public readonly id = 'dependency.await_packages@1';

  public constructor(
    private readonly declarations: Pick<DependencyDeclarationStore, 'readRevision'>,
    private readonly publications: Pick<
      VerifiedPackagePublicationStore,
      'listByDeclaration' | 'read'
    >,
  ) {}

  public execute(
    request: IntegrationStepExecutionRequest,
  ): Promise<IntegrationStepExecutionResult> {
    return Promise.resolve(this.executeRequest(request));
  }

  private executeRequest(request: IntegrationStepExecutionRequest): IntegrationStepExecutionResult {
    const parsedInput = dependencyWaitInputSchema.safeParse(request.stepInput);
    if (!parsedInput.success) {
      return blocked('Dependency wait input is invalid', {
        issues: parsedInput.error.issues.map(
          (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
        ),
      });
    }
    const input = parsedInput.data;

    const declaration = this.declarations.readRevision(
      input.declarationId,
      input.declarationRevision,
    );
    if (!declaration.ok) return storeFailure('declaration', declaration.error);
    if (declaration.value === null) {
      return blocked('Dependency declaration revision was not found', {
        declarationId: input.declarationId,
        declarationRevision: input.declarationRevision,
      });
    }
    const declarationRecord = declaration.value;

    if (declarationRecord.consumerTaskReference !== request.task.reference) {
      return blocked('Dependency wait is bound to a different consumer task', {
        expectedTaskReference: declarationRecord.consumerTaskReference,
        actualTaskReference: request.task.reference,
        declarationId: declarationRecord.declarationId,
        declarationRevision: declarationRecord.revision,
      });
    }
    if (!samePackageNames(declarationRecord.packages, input.packages)) {
      return blocked('Dependency wait packages do not match the declared dependency', {
        declarationId: declarationRecord.declarationId,
        declarationRevision: declarationRecord.revision,
        declaredPackages: declarationRecord.packages,
        requestedPackages: input.packages,
      });
    }
    if (!isChannelAllowed(declarationRecord, input.channel)) {
      return blocked('Dependency wait channel is not allowed by the declaration mode', {
        declarationId: declarationRecord.declarationId,
        declarationRevision: declarationRecord.revision,
        mode: declarationRecord.mode,
        channel: input.channel,
      });
    }

    const publications = this.publications.listByDeclaration(
      declarationRecord.declarationId,
      declarationRecord.revision,
    );
    if (!publications.ok) return storeFailure('publication', publications.error);

    const matching = publications.value.filter((publication) =>
      publicationMatches(publication, declarationRecord, input),
    );

    let nextIndex = 0;
    if (input.afterObservationId !== undefined) {
      const seenIndex = matching.findIndex(
        (publication) => publication.observationId === input.afterObservationId,
      );
      if (seenIndex < 0) {
        const seen = this.publications.read(input.afterObservationId);
        if (!seen.ok) return storeFailure('publication', seen.error);
        return blocked('Dependency wait cursor does not reference this declared publication', {
          declarationId: declarationRecord.declarationId,
          declarationRevision: declarationRecord.revision,
          afterObservationId: input.afterObservationId,
          observed: seen.value,
        });
      }
      nextIndex = seenIndex + 1;
    }

    const nextPublication = matching[nextIndex] ?? null;
    if (request.waitResolution !== null) {
      const resolution = DependencyAvailableResolutionSchema.safeParse(request.waitResolution);
      if (!resolution.success) {
        return blocked('Dependency wait resolution is invalid', {
          issues: resolution.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
      }
      if (
        resolution.data.declarationId !== declarationRecord.declarationId ||
        resolution.data.declarationRevision !== declarationRecord.revision
      ) {
        return blocked('Dependency wait resolution targets a different declaration revision', {
          expectedDeclarationId: declarationRecord.declarationId,
          expectedDeclarationRevision: declarationRecord.revision,
          resolution: resolution.data,
        });
      }

      const resolved = this.publications.read(resolution.data.observationId);
      if (!resolved.ok) return storeFailure('publication', resolved.error);
      if (resolved.value === null) return waiting(declarationRecord, input);
      if (!publicationMatches(resolved.value, declarationRecord, input)) {
        return blocked('Dependency wait resolution references a different verified publication', {
          declarationId: declarationRecord.declarationId,
          declarationRevision: declarationRecord.revision,
          expectedProducerTaskReference: declarationRecord.producerTaskReference,
          expectedChannel: input.channel,
          expectedPackages: [...sortPackageNames(input.packages)],
          observed: resolved.value,
        });
      }
      if (
        nextPublication === null ||
        nextPublication.observationId !== resolved.value.observationId
      ) {
        return blocked('Dependency wait resolution skipped the next unseen verified publication', {
          declarationId: declarationRecord.declarationId,
          declarationRevision: declarationRecord.revision,
          afterObservationId: input.afterObservationId ?? null,
          expectedObservationId: nextPublication?.observationId ?? null,
          resolvedObservationId: resolved.value.observationId,
        });
      }
      return completed(resolved.value);
    }

    return nextPublication === null
      ? waiting(declarationRecord, input)
      : completed(nextPublication);
  }
}
