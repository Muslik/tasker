import type { RepositoryCatalog } from '../../repositories/catalog.js';
import {
  JiraRepositoryBindingSchema,
  RepositoryReferenceSchema,
  type JiraRepositoryBinding,
  type RepositoryBindingSource,
} from '../../repositories/contracts.js';
import type { JiraIssueSnapshot } from './contracts.js';

type RepositoryReferenceResult =
  | { readonly status: 'missing' }
  | { readonly status: 'found'; readonly reference: string }
  | { readonly status: 'invalid'; readonly references: readonly string[] };

export interface JiraRepositoryReferenceSource {
  read(issue: JiraIssueSnapshot): RepositoryReferenceResult;
}

const REPOSITORY_DIRECTIVE = /^\s*(?:[-*]\s*)?repo\s*:\s*(?<reference>.*?)\s*$/gimu;

export class JiraDescriptionRepositoryReferenceSource implements JiraRepositoryReferenceSource {
  public read(issue: JiraIssueSnapshot): RepositoryReferenceResult {
    const references = [...issue.description.matchAll(REPOSITORY_DIRECTIVE)]
      .map((match) => match.groups?.reference?.trim() ?? '')
      .filter(
        (reference, index, values) =>
          values.findIndex(
            (candidate) =>
              candidate.toLocaleLowerCase('en-US') === reference.toLocaleLowerCase('en-US'),
          ) === index,
      );
    if (references.length === 0) return { status: 'missing' };
    if (references.length > 1 || !RepositoryReferenceSchema.safeParse(references[0]).success) {
      return { status: 'invalid', references };
    }
    return { status: 'found', reference: references[0] as string };
  }
}

const previousIntakeReference = (binding: JiraRepositoryBinding | null): string | null => {
  if (binding === null || binding.status === 'missing') return null;
  if (binding.source !== 'intake_fallback') return null;
  return binding.status === 'invalid' ? (binding.references[0] ?? null) : binding.reference;
};

const resolveReference = ({
  catalog,
  issueKey,
  recordedAt,
  source,
  reference,
}: {
  readonly catalog: RepositoryCatalog;
  readonly issueKey: string;
  readonly recordedAt: string;
  readonly source: RepositoryBindingSource;
  readonly reference: string;
}): JiraRepositoryBinding => {
  const parsedReference = RepositoryReferenceSchema.safeParse(reference);
  if (!parsedReference.success) {
    return JiraRepositoryBindingSchema.parse({
      status: 'invalid',
      issueKey,
      recordedAt,
      source,
      references: [reference],
    });
  }
  const lookup = catalog.find(parsedReference.data);
  if (lookup.status === 'not_found') {
    return JiraRepositoryBindingSchema.parse({
      status: 'not_found',
      issueKey,
      recordedAt,
      source,
      reference: parsedReference.data,
    });
  }
  if (lookup.status === 'ambiguous') {
    return JiraRepositoryBindingSchema.parse({
      status: 'ambiguous',
      issueKey,
      recordedAt,
      source,
      reference: parsedReference.data,
      candidates: lookup.candidates,
    });
  }
  return JiraRepositoryBindingSchema.parse({
    status: 'resolved',
    issueKey,
    recordedAt,
    source,
    reference: parsedReference.data,
    repository: lookup.repository,
  });
};

export const resolveJiraRepositoryBinding = ({
  issue,
  intakeFallback,
  previousBinding,
  recordedAt,
  catalog,
  referenceSource,
}: {
  readonly issue: JiraIssueSnapshot;
  readonly intakeFallback?: string | undefined;
  readonly previousBinding: JiraRepositoryBinding | null;
  readonly recordedAt: string;
  readonly catalog: RepositoryCatalog;
  readonly referenceSource: JiraRepositoryReferenceSource;
}): JiraRepositoryBinding => {
  const fromJira = referenceSource.read(issue);
  if (fromJira.status === 'invalid') {
    return JiraRepositoryBindingSchema.parse({
      status: 'invalid',
      issueKey: issue.issueKey,
      recordedAt,
      source: 'jira_description',
      references: fromJira.references,
    });
  }
  if (fromJira.status === 'found') {
    return resolveReference({
      catalog,
      issueKey: issue.issueKey,
      recordedAt,
      source: 'jira_description',
      reference: fromJira.reference,
    });
  }

  const fallback = intakeFallback?.trim() || previousIntakeReference(previousBinding);
  if (fallback === null) {
    return JiraRepositoryBindingSchema.parse({
      status: 'missing',
      issueKey: issue.issueKey,
      recordedAt,
    });
  }
  return resolveReference({
    catalog,
    issueKey: issue.issueKey,
    recordedAt,
    source: 'intake_fallback',
    reference: fallback,
  });
};
