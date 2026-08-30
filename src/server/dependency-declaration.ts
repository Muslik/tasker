import type { ZodError } from 'zod';

import { checksumString } from '../store/checksum.js';
import type { LedgerRepository } from '../store/repository.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { canonicalJson } from '../shared/json.js';
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

const DEPENDENCY_DECLARATION_DOCUMENT_KIND = 'dependency_declaration';

const issues = (error: ZodError): readonly string[] =>
  error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`);

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

const parseDeclaration = (
  recordId: string,
  payload: unknown,
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
    const document = this.ledger.readDocument(DEPENDENCY_DECLARATION_DOCUMENT_KIND, declarationId);
    return document === null ? ok(null) : parseDeclaration(declarationId, document.payload);
  }

  public readRevision(
    declarationId: string,
    revision: number,
  ): Outcome<DependencyDeclaration | null, DependencyDeclarationStoreError> {
    const document = this.ledger.readDocument(
      DEPENDENCY_DECLARATION_DOCUMENT_KIND,
      declarationId,
      revision,
    );
    return document === null ? ok(null) : parseDeclaration(declarationId, document.payload);
  }

  public listLatestByConsumerTask(
    consumerTaskReference: string,
  ): Outcome<readonly DependencyDeclaration[], DependencyDeclarationStoreError> {
    const matches: DependencyDeclaration[] = [];
    for (const document of this.ledger.listDocuments(DEPENDENCY_DECLARATION_DOCUMENT_KIND)) {
      const parsed = parseDeclaration(document.id, document.payload);
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

    const declaredAt = this.clock.now();
    const declaration = DependencyDeclarationSchema.parse({
      schemaVersion: 1,
      declarationId,
      revision: (existing.value?.revision ?? 0) + 1,
      hash: declarationHash(input),
      ...input,
      createdAt: declaredAt,
    });
    const committed = this.ledger.appendDocument(
      DEPENDENCY_DECLARATION_DOCUMENT_KIND,
      declarationId,
      existing.value?.revision ?? 0,
      declaration,
      declaredAt,
    );
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
