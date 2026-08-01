import type { LedgerRepository } from '../../ledger/repository.js';
import type { JsonValue, LedgerConflict } from '../../ledger/types.js';
import type { Clock } from '../../shared/clock.js';
import { err, ok, type Outcome } from '../../shared/outcome.js';
import { JiraIssueStateSchema, type JiraIssueKey, type JiraIssueState } from './contracts.js';

export const JIRA_ISSUE_PROJECTION = 'jira_issue';

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

  public save(stateInput: JiraIssueState): Outcome<JiraIssueState, JiraIssueStoreError> {
    const state = JiraIssueStateSchema.parse(stateInput);
    const issueKey = state.status === 'unavailable' ? state.issueKey : state.issue.issueKey;
    const aggregateId = `intake:jira:${issueKey}`;
    const head = this.ledger.readAggregateHead(aggregateId);
    const firstImport = head === null;
    const expectedVersion = head?.version ?? 0;
    const syncEventType = state.status === 'current' ? 'JiraIssueSynced' : 'JiraIssueSyncBlocked';
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
      {
        eventId: `event:jira-sync:${issueKey}:${String(expectedVersion + 1)}`,
        eventType: syncEventType,
        eventSchemaVersion: 1 as const,
        payload:
          state.status === 'current'
            ? { issueKey, remoteUpdatedAt: state.issue.updatedAt }
            : { issueKey, problem: asJson(state.problem) },
        actor: 'jira_adapter',
      },
      ...(state.status === 'current'
        ? [
            {
              eventId: `event:jira-planning-blocked:${issueKey}:${String(expectedVersion + 2)}`,
              eventType: 'JiraWorkflowPlanningBlocked',
              eventSchemaVersion: 1 as const,
              payload: {
                issueKey,
                reason: 'repository_mapping_required',
              },
              actor: 'planner',
            },
          ]
        : []),
    ];
    const aggregateVersion = expectedVersion + events.length;
    const result = this.ledger.transact({
      aggregate: { aggregateId, expectedVersion, events },
      projections: [
        {
          kind: 'upsert',
          projectionType: JIRA_ISSUE_PROJECTION,
          projectionId: issueKey,
          payload: asJson(state),
        },
      ],
      snapshots: [
        {
          snapshotId: `snapshot:jira:${issueKey}:${String(aggregateVersion)}`,
          aggregateId,
          aggregateVersion,
          snapshotSchemaVersion: 1,
          payload: asJson(state),
        },
      ],
      ...(state.status === 'current'
        ? {
            artifacts: [
              {
                artifactId: `jira-snapshot:${issueKey}:${String(aggregateVersion)}`,
                artifactKind: 'jira_issue_snapshot',
                storageUri: `ledger://artifacts/jira-snapshot:${issueKey}:${String(aggregateVersion)}`,
                payload: asJson(state.issue),
                metadata: {
                  issueKey,
                  remoteUpdatedAt: state.issue.updatedAt,
                },
              },
            ],
          }
        : {}),
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
