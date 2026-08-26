import type { ZodError } from 'zod';

import { checksumString } from '../ledger/checksum.js';
import type { LedgerRepository } from '../ledger/repository.js';
import type { JsonValue } from '../ledger/types.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { JsonValueSchema } from '../workflow/schema.js';
import {
  DependencyDeclarationSchema,
  RecordDependencyDeclarationInputSchema,
  type DependencyDeclaration,
  type DependencyDeclarationSource,
  type RecordDependencyDeclarationInput,
} from './dependency-contracts.js';

export * from './dependency-contracts.js';

export type DependencyDeclarationStoreError =
  | { readonly kind: 'ledger_conflict' }
  | { readonly kind: 'declaration_conflict'; readonly declarationId: string }
  | {
      readonly kind: 'record_corrupt';
      readonly recordId: string;
      readonly issues: readonly string[];
    };

const DEPENDENCY_DECLARATION_PROJECTION = 'dependency_declaration_latest';

const asJson = (value: unknown): JsonValue => JsonValueSchema.parse(value);

const issues = (error: ZodError): readonly string[] =>
  error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`);

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
};

const normalizePackages = (packages: readonly string[]): string[] => [...packages].sort();

const comparableDeclaration = (declaration: RecordDependencyDeclarationInput) => ({
  consumerTaskReference: declaration.consumerTaskReference,
  producerTaskReference: declaration.producerTaskReference,
  producerRepository: declaration.producerRepository,
  packages: normalizePackages(declaration.packages),
  mode: declaration.mode,
  source: declaration.source,
});

const sameDeclaration = (
  left: RecordDependencyDeclarationInput,
  right: RecordDependencyDeclarationInput,
): boolean =>
  canonicalJson(comparableDeclaration(left)) === canonicalJson(comparableDeclaration(right));

const declarationHash = (input: RecordDependencyDeclarationInput): string =>
  checksumString(canonicalJson(comparableDeclaration(input)));

const artifactIdFor = (declarationId: string, revision: number): string =>
  `${declarationId}:revision-${String(revision)}`;

const eventIdFor = (declarationId: string, revision: number): string =>
  `event:${declarationId}:revision-${String(revision)}`;

const aggregateIdFor = (declarationId: string): string => declarationId;

const parseDeclaration = (
  recordId: string,
  payload: JsonValue,
): Outcome<DependencyDeclaration, DependencyDeclarationStoreError> => {
  const parsed = DependencyDeclarationSchema.safeParse(payload);
  return parsed.success
    ? ok(parsed.data)
    : err({ kind: 'record_corrupt', recordId, issues: issues(parsed.error) });
};

export const dependencyDeclarationIdentityFor = (
  consumerTaskReference: string,
  source: DependencyDeclarationSource,
): string =>
  source.kind === 'jira_link'
    ? `jira-link:${source.linkId}:${consumerTaskReference}`
    : `runtime-discovery:${source.workflowRunId}:${source.requestArtifactId}:${consumerTaskReference}`;

export const dependencyDeclarationIdFor = (
  consumerTaskReference: string,
  source: DependencyDeclarationSource,
): string =>
  `dependency-declaration:${dependencyDeclarationIdentityFor(consumerTaskReference, source)}`;

export class DependencyDeclarationStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public readLatest(
    declarationId: string,
  ): Outcome<DependencyDeclaration | null, DependencyDeclarationStoreError> {
    const projection = this.ledger.readProjection(DEPENDENCY_DECLARATION_PROJECTION, declarationId);
    return projection === null ? ok(null) : parseDeclaration(declarationId, projection.payload);
  }

  public readRevision(
    declarationId: string,
    revision: number,
  ): Outcome<DependencyDeclaration | null, DependencyDeclarationStoreError> {
    const artifactId = artifactIdFor(declarationId, revision);
    const artifact = this.ledger.readArtifact(artifactId);
    return artifact === null ? ok(null) : parseDeclaration(artifactId, artifact.payload);
  }

  public listLatestByConsumerTask(
    consumerTaskReference: string,
  ): Outcome<readonly DependencyDeclaration[], DependencyDeclarationStoreError> {
    const matches: DependencyDeclaration[] = [];
    for (const projection of this.ledger.listProjections(DEPENDENCY_DECLARATION_PROJECTION)) {
      const parsed = parseDeclaration(projection.projectionId, projection.payload);
      if (!parsed.ok) return parsed;
      if (parsed.value.consumerTaskReference === consumerTaskReference) {
        matches.push(parsed.value);
      }
    }
    return ok(
      matches.sort(
        (left, right) =>
          left.declarationId.localeCompare(right.declarationId) || left.revision - right.revision,
      ),
    );
  }

  public declare(
    inputValue: RecordDependencyDeclarationInput,
  ): Outcome<DependencyDeclaration, DependencyDeclarationStoreError> {
    const parsed = RecordDependencyDeclarationInputSchema.parse(inputValue);
    const input = {
      ...parsed,
      packages: normalizePackages(parsed.packages),
    } satisfies RecordDependencyDeclarationInput;
    const declarationId = dependencyDeclarationIdFor(input.consumerTaskReference, input.source);
    const existing = this.readLatest(declarationId);
    if (!existing.ok) return existing;
    if (existing.value !== null && sameDeclaration(existing.value, input)) {
      return ok(existing.value);
    }

    const revision = (existing.value?.revision ?? 0) + 1;
    const declaredAt = this.clock.now();
    const declaration = DependencyDeclarationSchema.parse({
      schemaVersion: 1,
      declarationId,
      revision,
      hash: declarationHash(input),
      ...input,
      createdAt: declaredAt,
    });
    const committed = this.ledger.transact({
      aggregate: {
        aggregateId: aggregateIdFor(declarationId),
        expectedVersion: existing.value?.revision ?? 0,
        events: [
          {
            eventId: eventIdFor(declarationId, revision),
            eventType: 'DependencyDeclarationRecorded',
            eventSchemaVersion: 1,
            payload: asJson({
              declarationId,
              revision,
              consumerTaskReference: declaration.consumerTaskReference,
              producerTaskReference: declaration.producerTaskReference,
              producerRepository: declaration.producerRepository,
              mode: declaration.mode,
            }),
            actor: 'operator',
          },
        ],
      },
      projections: [
        {
          kind: 'upsert',
          projectionType: DEPENDENCY_DECLARATION_PROJECTION,
          projectionId: declarationId,
          payload: asJson(declaration),
        },
      ],
      artifacts: [
        {
          artifactId: artifactIdFor(declarationId, revision),
          artifactKind: 'dependency_declaration',
          storageUri: `ledger://artifacts/${artifactIdFor(declarationId, revision)}`,
          payload: asJson(declaration),
          metadata: asJson({
            declarationId,
            revision,
            consumerTaskReference: declaration.consumerTaskReference,
            producerTaskReference: declaration.producerTaskReference,
            producerRepository: declaration.producerRepository,
            mode: declaration.mode,
            sourceKind: declaration.source.kind,
          }),
          createdAt: declaredAt,
        },
      ],
      timestamp: declaredAt,
    });
    if (committed.ok) return ok(declaration);

    const concurrent = this.readLatest(declarationId);
    if (!concurrent.ok) return concurrent;
    if (concurrent.value !== null && sameDeclaration(concurrent.value, input)) {
      return ok(concurrent.value);
    }
    return concurrent.value !== null
      ? err({ kind: 'declaration_conflict', declarationId })
      : err({ kind: 'ledger_conflict' });
  }
}
