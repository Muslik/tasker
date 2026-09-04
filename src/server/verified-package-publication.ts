import { z } from 'zod';

import type { LedgerRepository } from '../store/repository.js';
import type { JsonValue } from '../store/types.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { canonicalJson } from '../shared/json.js';
import { JsonValueSchema } from '../graph/schema.js';
import { DependencyPackageNameSchema } from './dependency-declaration.js';

const PublicationChannelSchema = z.enum(['dev', 'final']);

const PublicationPackagesSchema = z
  .array(
    z
      .object({
        name: DependencyPackageNameSchema,
        version: z.string().min(1),
        registry: z.url(),
        tarballUrl: z.url(),
        integrity: z.string().min(1),
      })
      .strict()
      .readonly(),
  )
  .min(1)
  .superRefine((packages, context) => {
    const seen = new Set<string>();
    for (const [index, packageObservation] of packages.entries()) {
      if (seen.has(packageObservation.name)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate package name "${packageObservation.name}"`,
          path: [index, 'name'],
        });
      }
      seen.add(packageObservation.name);
    }
  });

const PublicationProvenanceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('loop'),
      postId: z.string().min(1),
      url: z.url().optional(),
    })
    .strict()
    .readonly(),
]);

const VerifiedPackagePublicationInputObjectSchema = z
  .object({
    declarationId: z.string().min(1),
    declarationRevision: z.number().int().positive(),
    producerTaskReference: z.string().min(1),
    channel: PublicationChannelSchema,
    packages: PublicationPackagesSchema,
    sourceOperationId: z.string().min(1),
    provenance: PublicationProvenanceSchema.optional(),
  })
  .strict();

export const RecordVerifiedPackagePublicationInputSchema =
  VerifiedPackagePublicationInputObjectSchema.readonly();

export const VerifiedPackagePublicationSchema = VerifiedPackagePublicationInputObjectSchema.extend({
  schemaVersion: z.literal(1),
  observationId: z.string().min(1),
  observedAt: z.iso.datetime(),
})
  .strict()
  .readonly();

export type RecordVerifiedPackagePublicationInput = z.infer<
  typeof RecordVerifiedPackagePublicationInputSchema
>;
export type VerifiedPackagePublication = z.infer<typeof VerifiedPackagePublicationSchema>;

export type VerifiedPackagePublicationStoreError =
  | { readonly kind: 'ledger_conflict' }
  | {
      readonly kind: 'publication_conflict';
      readonly externalIdentity: string;
      readonly observationId: string;
    }
  | {
      readonly kind: 'record_corrupt';
      readonly recordId: string;
      readonly issues: readonly string[];
    };

const VERIFIED_PUBLICATION_DOCUMENT_KIND = 'verified_package_publication_by_identity';

const asJson = (value: unknown): JsonValue => JsonValueSchema.parse(value);

const issues = (error: z.ZodError): readonly string[] =>
  error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`);

const normalizePackages = (
  packages: ReadonlyArray<RecordVerifiedPackagePublicationInput['packages'][number]>,
): Array<RecordVerifiedPackagePublicationInput['packages'][number]> =>
  [...packages].sort((left, right) => left.name.localeCompare(right.name));

const comparablePublication = (publication: RecordVerifiedPackagePublicationInput) => ({
  declarationId: publication.declarationId,
  declarationRevision: publication.declarationRevision,
  producerTaskReference: publication.producerTaskReference,
  channel: publication.channel,
  packages: normalizePackages(publication.packages),
  ...(publication.provenance === undefined ? {} : { provenance: publication.provenance }),
});

const samePublication = (
  left: RecordVerifiedPackagePublicationInput,
  right: RecordVerifiedPackagePublicationInput,
): boolean =>
  canonicalJson(comparablePublication(left)) === canonicalJson(comparablePublication(right));

const parsePublication = (
  recordId: string,
  payload: JsonValue,
): Outcome<VerifiedPackagePublication, VerifiedPackagePublicationStoreError> => {
  const parsed = VerifiedPackagePublicationSchema.safeParse(payload);
  return parsed.success
    ? ok(parsed.data)
    : err({ kind: 'record_corrupt', recordId, issues: issues(parsed.error) });
};

export const verifiedPackagePublicationExternalIdentityFor = (
  input: Pick<RecordVerifiedPackagePublicationInput, 'sourceOperationId'>,
): string => `operation:${input.sourceOperationId}`;

export const verifiedPackagePublicationObservationIdFor = (
  input: Pick<RecordVerifiedPackagePublicationInput, 'sourceOperationId'>,
): string => `verified-package-publication:${verifiedPackagePublicationExternalIdentityFor(input)}`;

export class VerifiedPackagePublicationStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public read(
    observationId: string,
  ): Outcome<VerifiedPackagePublication | null, VerifiedPackagePublicationStoreError> {
    const artifact = this.ledger.readArtifact(observationId);
    return artifact === null ? ok(null) : parsePublication(observationId, artifact.payload);
  }

  public readByExternalIdentity(
    input: Pick<RecordVerifiedPackagePublicationInput, 'sourceOperationId'>,
  ): Outcome<VerifiedPackagePublication | null, VerifiedPackagePublicationStoreError> {
    const externalIdentity = verifiedPackagePublicationExternalIdentityFor(input);
    const document = this.ledger.readDocument(VERIFIED_PUBLICATION_DOCUMENT_KIND, externalIdentity);
    return document === null ? ok(null) : parsePublication(externalIdentity, document.payload);
  }

  public listByDeclaration(
    declarationId: string,
    declarationRevision: number,
  ): Outcome<readonly VerifiedPackagePublication[], VerifiedPackagePublicationStoreError> {
    const matches: VerifiedPackagePublication[] = [];
    for (const artifact of this.ledger.listArtifacts({
      artifactKind: 'verified_package_publication',
    })) {
      const parsed = parsePublication(artifact.artifactId, artifact.payload);
      if (!parsed.ok) return parsed;
      if (
        parsed.value.declarationId === declarationId &&
        parsed.value.declarationRevision === declarationRevision
      ) {
        matches.push(parsed.value);
      }
    }
    return ok(matches);
  }

  public record(
    inputValue: RecordVerifiedPackagePublicationInput,
  ): Outcome<VerifiedPackagePublication, VerifiedPackagePublicationStoreError> {
    const parsed = RecordVerifiedPackagePublicationInputSchema.parse(inputValue);
    const input = {
      ...parsed,
      packages: normalizePackages(parsed.packages),
    } satisfies RecordVerifiedPackagePublicationInput;
    const externalIdentity = verifiedPackagePublicationExternalIdentityFor(input);
    const existing = this.readByExternalIdentity(input);
    if (!existing.ok) return existing;
    if (existing.value !== null) {
      return samePublication(existing.value, input)
        ? ok(existing.value)
        : err({
            kind: 'publication_conflict',
            externalIdentity,
            observationId: existing.value.observationId,
          });
    }

    const observationId = verifiedPackagePublicationObservationIdFor(input);
    const observedAt = this.clock.now();
    const publication = VerifiedPackagePublicationSchema.parse({
      schemaVersion: 1,
      observationId,
      ...input,
      observedAt,
    });
    const artifactInserted = this.ledger.insertArtifact({
      artifactId: observationId,
      artifactKind: 'verified_package_publication',
      storageUri: `ledger://artifacts/${observationId}`,
      payload: asJson(publication),
      metadata: asJson({
        declarationId: publication.declarationId,
        declarationRevision: publication.declarationRevision,
        producerTaskReference: publication.producerTaskReference,
        channel: publication.channel,
        externalIdentity,
      }),
      createdAt: observedAt,
    });
    if (!artifactInserted) {
      const concurrent = this.read(observationId);
      if (!concurrent.ok) return concurrent;
      if (concurrent.value !== null && samePublication(concurrent.value, input)) {
        return ok(concurrent.value);
      }
      return concurrent.value !== null
        ? err({
            kind: 'publication_conflict',
            externalIdentity,
            observationId: concurrent.value.observationId,
          })
        : err({ kind: 'ledger_conflict' });
    }

    const documentInserted = this.ledger.insertDocument({
      kind: VERIFIED_PUBLICATION_DOCUMENT_KIND,
      id: externalIdentity,
      revision: 1,
      payload: asJson(publication),
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    if (documentInserted) return ok(publication);

    const concurrent = this.readByExternalIdentity(input);
    if (!concurrent.ok) return concurrent;
    if (concurrent.value !== null && samePublication(concurrent.value, input)) {
      return ok(concurrent.value);
    }
    return concurrent.value !== null
      ? err({
          kind: 'publication_conflict',
          externalIdentity,
          observationId: concurrent.value.observationId,
        })
      : err({ kind: 'ledger_conflict' });
  }
}
