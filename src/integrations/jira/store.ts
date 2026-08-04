import type { LedgerRepository } from '../../ledger/repository.js';
import type { JsonValue, LedgerConflict } from '../../ledger/types.js';
import type { Clock } from '../../shared/clock.js';
import { err, ok, type Outcome } from '../../shared/outcome.js';
import {
  JiraRepositoryBindingSchema,
  type JiraRepositoryBinding,
} from '../../repositories/contracts.js';
import { JiraIssueStateSchema, type JiraIssueKey, type JiraIssueState } from './contracts.js';

export const JIRA_ISSUE_PROJECTION = 'jira_issue';
export const JIRA_REPOSITORY_BINDING_PROJECTION = 'jira_repository_binding';

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
    const projection = this.ledger.readProjection(JIRA_ISSUE_PROJECTION, issueKey);
    if (projection === null) return ok(null);

    const parsed = JiraIssueStateSchema.safeParse(projection.payload);
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
    for (const projection of this.ledger.listProjections(JIRA_ISSUE_PROJECTION)) {
      const parsed = JiraIssueStateSchema.safeParse(projection.payload);
      if (!parsed.success) {
        return err({
          kind: 'projection_corrupt',
          issueKey: projection.projectionId,
          issues: parsed.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
      }
      states.push(parsed.data);
    }
    return ok(states);
  }

  public listEvents(issueKey: JiraIssueKey) {
    return this.ledger.listEvents(`intake:jira:${issueKey}`);
  }

  public readRepositoryBinding(
    issueKey: JiraIssueKey,
  ): Outcome<JiraRepositoryBinding | null, JiraIssueStoreError> {
    const projection = this.ledger.readProjection(JIRA_REPOSITORY_BINDING_PROJECTION, issueKey);
    if (projection === null) return ok(null);
    const parsed = JiraRepositoryBindingSchema.safeParse(projection.payload);
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
    const aggregateId = `intake:jira:${issueKey}`;
    const head = this.ledger.readAggregateHead(aggregateId);
    const firstImport = head === null;
    const expectedVersion = head?.version ?? 0;
    const repositoryBinding =
      update.repositoryBinding === undefined
        ? null
        : JiraRepositoryBindingSchema.parse(update.repositoryBinding);
    const previousBinding = this.readRepositoryBinding(issueKey);
    if (!previousBinding.ok) return previousBinding;
    const events = [
      ...(firstImport
        ? [
            {
              eventId: `event:jira-intake-requested:${issueKey}`,
              eventType: 'JiraIntakeRequested',
              eventSchemaVersion: 1 as const,
              payload: { issueKey },
              actor: 'operator',
            },
          ]
        : []),
      ...(repositoryBinding === null || sameBindingState(previousBinding.value, repositoryBinding)
        ? []
        : [
            {
              eventId: `event:jira-repository:${issueKey}:${String(
                expectedVersion + (firstImport ? 2 : 1),
              )}`,
              eventType:
                repositoryBinding.status === 'resolved'
                  ? 'JiraRepositoryBound'
                  : 'JiraRepositoryBindingBlocked',
              eventSchemaVersion: 1 as const,
              payload:
                repositoryBinding.status === 'resolved'
                  ? {
                      issueKey,
                      repositoryId: repositoryBinding.repository.repositoryId,
                      source: repositoryBinding.source,
                    }
                  : {
                      issueKey,
                      status: repositoryBinding.status,
                    },
              actor: 'repository_resolver',
            },
          ]),
    ];
    const result = this.ledger.transact({
      ...(events.length === 0 ? {} : { aggregate: { aggregateId, expectedVersion, events } }),
      projections: [
        {
          kind: 'upsert',
          projectionType: JIRA_ISSUE_PROJECTION,
          projectionId: issueKey,
          payload: asJson(state),
        },
        ...(repositoryBinding === null
          ? []
          : [
              {
                kind: 'upsert' as const,
                projectionType: JIRA_REPOSITORY_BINDING_PROJECTION,
                projectionId: issueKey,
                payload: asJson(repositoryBinding),
              },
            ]),
      ],
      timestamp: this.clock.now(),
    });

    return result.ok
      ? ok(state)
      : err({
          kind: 'ledger_conflict',
          conflict: result.error,
        });
  }
}
