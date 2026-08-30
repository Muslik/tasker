import type { LedgerRepository } from '../../store/repository.js';
import type { DocumentConflict, JsonValue, LedgerConflict } from '../../store/types.js';
import type { Clock } from '../../shared/clock.js';
import { err, ok, type Outcome } from '../../shared/outcome.js';
import {
  JiraRepositoryBindingSchema,
  type JiraRepositoryBinding,
} from '../../workspace/contracts.js';
import { JiraIssueStateSchema, type JiraIssueKey, type JiraIssueState } from './contracts.js';

export const JIRA_ISSUE_PROJECTION = 'jira_issue';
export const JIRA_REPOSITORY_BINDING_PROJECTION = 'jira_binding';

type CurrentJiraIssueState = Extract<JiraIssueState, { readonly status: 'current' }>;
type UnavailableJiraIssueState = Exclude<JiraIssueState, CurrentJiraIssueState>;

export type JiraIssueStoreUpdate =
  | {
      readonly state: CurrentJiraIssueState;
      readonly repositoryBinding: JiraRepositoryBinding;
    }
  | {
      readonly state: UnavailableJiraIssueState;
      readonly repositoryBinding?: JiraRepositoryBinding | undefined;
    };

export type JiraIssueStoreError =
  | {
      readonly kind: 'ledger_conflict';
      readonly conflict: LedgerConflict;
    }
  | {
      readonly kind: 'projection_corrupt';
      readonly issueKey: string;
      readonly issues: readonly string[];
    };

const ledgerConflictFromDocumentConflict = (conflict: DocumentConflict): LedgerConflict => ({
  kind: 'version_conflict',
  aggregateId: `document:${conflict.documentKind}:${conflict.documentId}`,
  expectedVersion: conflict.expectedRevision,
  actualVersion: conflict.actualRevision,
});

const samePayload = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const asJson = (value: unknown): JsonValue => value as JsonValue;

const sameBindingState = (
  left: JiraRepositoryBinding | null,
  right: JiraRepositoryBinding,
): boolean => {
  if (left === null) return false;
  return JSON.stringify(left) === JSON.stringify({ ...right, recordedAt: left.recordedAt });
};

export class JiraIssueStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public read(issueKey: JiraIssueKey): Outcome<JiraIssueState | null, JiraIssueStoreError> {
    const document = this.ledger.readDocument(JIRA_ISSUE_PROJECTION, issueKey);
    if (document === null) return ok(null);

    const parsed = JiraIssueStateSchema.safeParse(document.payload);
    if (!parsed.success) {
      return err({
        kind: 'projection_corrupt',
        issueKey,
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
        ),
      });
    }

    return ok(parsed.data);
  }

  public list(): Outcome<readonly JiraIssueState[], JiraIssueStoreError> {
    const states: JiraIssueState[] = [];
    for (const document of this.ledger.listDocuments(JIRA_ISSUE_PROJECTION)) {
      const parsed = JiraIssueStateSchema.safeParse(document.payload);
      if (!parsed.success) {
        return err({
          kind: 'projection_corrupt',
          issueKey: document.id,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
      }
      states.push(parsed.data);
    }
    return ok(states);
  }

  public readRepositoryBinding(
    issueKey: JiraIssueKey,
  ): Outcome<JiraRepositoryBinding | null, JiraIssueStoreError> {
    const document = this.ledger.readDocument(JIRA_REPOSITORY_BINDING_PROJECTION, issueKey);
    if (document === null) return ok(null);
    const parsed = JiraRepositoryBindingSchema.safeParse(document.payload);
    return parsed.success
      ? ok(parsed.data)
      : err({
          kind: 'projection_corrupt',
          issueKey,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
  }

  public save(update: JiraIssueStoreUpdate): Outcome<JiraIssueState, JiraIssueStoreError> {
    const state = JiraIssueStateSchema.parse(update.state);
    const issueKey = state.status === 'unavailable' ? state.issueKey : state.issue.issueKey;
    const repositoryBinding =
      update.repositoryBinding === undefined
        ? null
        : JiraRepositoryBindingSchema.parse(update.repositoryBinding);
    const previousBinding = this.readRepositoryBinding(issueKey);
    if (!previousBinding.ok) return previousBinding;

    const timestamp = this.clock.now();
    const stateSaved = this.writeLatestDocument(
      JIRA_ISSUE_PROJECTION,
      issueKey,
      asJson(state),
      timestamp,
    );
    if (!stateSaved.ok) return stateSaved;

    if (repositoryBinding === null || sameBindingState(previousBinding.value, repositoryBinding)) {
      return ok(state);
    }

    const bindingSaved = this.writeLatestDocument(
      JIRA_REPOSITORY_BINDING_PROJECTION,
      issueKey,
      asJson(repositoryBinding),
      timestamp,
    );
    return bindingSaved.ok ? ok(state) : bindingSaved;
  }

  private writeLatestDocument(
    kind: string,
    id: string,
    payload: JsonValue,
    timestamp: string,
  ): Outcome<void, JiraIssueStoreError> {
    const existing = this.ledger.readDocument(kind, id);
    if (existing !== null && samePayload(existing.payload, payload)) return ok(undefined);

    const committed = this.ledger.appendDocument(
      kind,
      id,
      existing?.revision ?? 0,
      payload,
      timestamp,
    );
    if (committed.ok) return ok(undefined);

    const concurrent = this.ledger.readDocument(kind, id);
    if (concurrent !== null && samePayload(concurrent.payload, payload)) return ok(undefined);

    return err({
      kind: 'ledger_conflict',
      conflict: ledgerConflictFromDocumentConflict(committed.error),
    });
  }
}
