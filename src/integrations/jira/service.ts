import {
  OperatorActivityResponseSchema,
  OperatorTaskSummarySchema,
  type OperatorActivityResponse,
  type OperatorTaskSummary,
} from '../../control-plane/m1-contracts.js';
import type { LedgerRepository } from '../../ledger/repository.js';
import type { Clock } from '../../shared/clock.js';
import { err, ok, type Outcome } from '../../shared/outcome.js';
import type { JiraAttachmentContent, JiraIssuePort } from './client.js';
import {
  JiraIssueKeySchema,
  JiraIssueStateSchema,
  type JiraIssueKey,
  type JiraIssueState,
} from './contracts.js';
import { JiraIssueStore, type JiraIssueStoreError } from './store.js';

export type JiraIssueServiceError =
  | {
      readonly kind: 'invalid_issue_key';
      readonly input: string;
    }
  | {
      readonly kind: 'issue_not_imported';
      readonly issueKey: string;
    }
  | {
      readonly kind: 'attachment_not_found';
      readonly issueKey: string;
      readonly attachmentId: string;
    }
  | {
      readonly kind: 'attachment_unavailable';
      readonly message: string;
      readonly retryable: boolean;
    }
  | {
      readonly kind: 'store_failure';
      readonly error: JiraIssueStoreError;
    };

const issueKeyFromState = (state: JiraIssueState): JiraIssueKey =>
  state.status === 'unavailable' ? state.issueKey : state.issue.issueKey;

const taskFromState = (state: JiraIssueState): OperatorTaskSummary => {
  const issueKey = issueKeyFromState(state);
  const issue = state.status === 'unavailable' ? null : state.issue;
  const blocked = state.status !== 'current';
  return OperatorTaskSummarySchema.parse({
    id: `jira:${issueKey}`,
    taskId: issueKey,
    title: issue?.summary ?? issueKey,
    origin: {
      kind: 'jira',
      issueKey,
      issueType: issue?.issueType ?? null,
      browseUrl: issue?.browseUrl ?? null,
      syncStatus: state.status,
    },
    planning: {
      status: 'blocked',
      reason: 'Repository mapping is required before workflow generation',
    },
    status: blocked ? 'needs_attention' : 'backlog',
    attention: blocked ? 'operator' : 'none',
    currentStage:
      state.status === 'current'
        ? 'Jira snapshot ready · repository mapping required'
        : state.status === 'stale'
          ? 'Jira sync blocked · showing cached snapshot'
          : 'Jira sync blocked · no cached snapshot',
    updatedAt: state.recordedAt,
  });
};

export class JiraIssueService {
  private readonly inFlight = new Map<
    string,
    Promise<Outcome<JiraIssueState, JiraIssueServiceError>>
  >();

  public constructor(
    private readonly store: JiraIssueStore,
    private readonly clock: Clock,
    private readonly port: JiraIssuePort,
  ) {}

  public listOperatorTasks(): Outcome<readonly OperatorTaskSummary[], JiraIssueServiceError> {
    const states = this.store.list();
    return states.ok
      ? ok(states.value.map(taskFromState))
      : err({ kind: 'store_failure', error: states.error });
  }

  public read(issueKeyInput: string): Outcome<JiraIssueState | null, JiraIssueServiceError> {
    const parsed = JiraIssueKeySchema.safeParse(issueKeyInput.toUpperCase());
    if (!parsed.success) return err({ kind: 'invalid_issue_key', input: issueKeyInput });
    const state = this.store.read(parsed.data);
    return state.ok ? state : err({ kind: 'store_failure', error: state.error });
  }

  public sync(issueKeyInput: string): Promise<Outcome<JiraIssueState, JiraIssueServiceError>> {
    const normalized = issueKeyInput.trim().toUpperCase();
    const parsed = JiraIssueKeySchema.safeParse(normalized);
    if (!parsed.success) {
      return Promise.resolve(err({ kind: 'invalid_issue_key', input: issueKeyInput }));
    }

    const current = this.inFlight.get(parsed.data);
    if (current !== undefined) return current;
    const pending = this.syncOnce(parsed.data).finally(() => {
      this.inFlight.delete(parsed.data);
    });
    this.inFlight.set(parsed.data, pending);
    return pending;
  }

  public readActivity(
    taskReference: string,
  ): Outcome<OperatorActivityResponse, JiraIssueServiceError> {
    const issueKeyInput = taskReference.startsWith('jira:')
      ? taskReference.slice('jira:'.length)
      : taskReference;
    const parsed = JiraIssueKeySchema.safeParse(issueKeyInput);
    if (!parsed.success) return err({ kind: 'invalid_issue_key', input: taskReference });

    const entries = this.store.listEvents(parsed.data).map((event) => {
      if (event.eventType === 'JiraIntakeRequested') {
        return {
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          source: 'operator' as const,
          level: 'info' as const,
          title: 'Jira issue imported',
          detail: 'The issue key was persisted before the external Jira request.',
        };
      }
      if (event.eventType === 'JiraIssueSynced') {
        return {
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          source: 'tool' as const,
          level: 'info' as const,
          title: 'Jira snapshot synchronized',
          detail: 'Task fields, comments, links, and attachment metadata were persisted.',
        };
      }
      if (event.eventType === 'JiraWorkflowPlanningBlocked') {
        return {
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          source: 'planner' as const,
          level: 'warning' as const,
          title: 'Workflow planning paused',
          detail: 'A target repository must be mapped before read-only repository analysis.',
        };
      }
      return {
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        source: 'tool' as const,
        level: 'warning' as const,
        title: 'Jira synchronization blocked',
        detail:
          'The last successful snapshot remains available. VPN or Jira access may be required.',
      };
    });

    return ok(
      OperatorActivityResponseSchema.parse({
        fixtureId: taskReference,
        providerSession: { status: 'not_started', reason: 'm1_planning_only' },
        entries,
      }),
    );
  }

  public async readAttachment(
    issueKeyInput: string,
    attachmentId: string,
  ): Promise<Outcome<JiraAttachmentContent, JiraIssueServiceError>> {
    const state = this.read(issueKeyInput);
    if (!state.ok) return state;
    if (state.value === null || state.value.status === 'unavailable') {
      return err({ kind: 'issue_not_imported', issueKey: issueKeyInput });
    }
    const attachment = state.value.issue.attachments.find((item) => item.id === attachmentId);
    if (attachment === undefined) {
      return err({ kind: 'attachment_not_found', issueKey: issueKeyInput, attachmentId });
    }
    const content = await this.port.fetchAttachment(attachment.contentUrl);
    return content.ok
      ? content
      : err({
          kind: 'attachment_unavailable',
          message: content.error.message,
          retryable: content.error.retryable,
        });
  }

  private async syncOnce(
    issueKey: JiraIssueKey,
  ): Promise<Outcome<JiraIssueState, JiraIssueServiceError>> {
    const recordedAt = this.clock.now();
    const previous = this.store.read(issueKey);
    if (!previous.ok) return err({ kind: 'store_failure', error: previous.error });
    const fetched = await this.port.fetchIssue(issueKey, recordedAt);
    const next = JiraIssueStateSchema.parse(
      fetched.ok
        ? {
            status: 'current',
            issue: fetched.value,
            lastSuccessfulSyncAt: fetched.value.syncedAt,
            recordedAt,
          }
        : previous.value !== null && previous.value.status !== 'unavailable'
          ? {
              status: 'stale',
              issue: previous.value.issue,
              lastSuccessfulSyncAt: previous.value.lastSuccessfulSyncAt,
              recordedAt,
              problem: fetched.error,
            }
          : {
              status: 'unavailable',
              issueKey,
              lastSuccessfulSyncAt: null,
              recordedAt,
              problem: fetched.error,
            },
    );
    const saved = this.store.save(next);
    return saved.ok ? saved : err({ kind: 'store_failure', error: saved.error });
  }
}

export const createJiraIssueService = (
  ledger: LedgerRepository,
  clock: Clock,
  port: JiraIssuePort,
): JiraIssueService => new JiraIssueService(new JiraIssueStore(ledger, clock), clock, port);
