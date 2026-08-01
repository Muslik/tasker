import {
  OperatorActivityResponseSchema,
  OperatorTaskSummarySchema,
  type OperatorActivityResponse,
  type OperatorTaskSummary,
} from '../../control-plane/m1-contracts.js';
import type { LedgerRepository } from '../../ledger/repository.js';
import { StaticRepositoryCatalog, type RepositoryCatalog } from '../../repositories/catalog.js';
import {
  JiraRepositoryBindingSchema,
  type JiraRepositoryBinding,
  type RepositoryCatalogEntry,
} from '../../repositories/contracts.js';
import type { Clock } from '../../shared/clock.js';
import { err, ok, type Outcome } from '../../shared/outcome.js';
import type { JiraAttachmentContent, JiraIssuePort } from './client.js';
import {
  JiraIssueKeySchema,
  JiraIssueStateSchema,
  type JiraIssueKey,
  type JiraIssueSnapshot,
  type JiraIssueState,
} from './contracts.js';
import {
  JiraDescriptionRepositoryReferenceSource,
  resolveJiraRepositoryBinding,
  type JiraRepositoryReferenceSource,
} from './repository-reference.js';
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

export type JiraWorkflowPlanningSource =
  | {
      readonly status: 'ready';
      readonly issue: JiraIssueSnapshot;
      readonly binding: Extract<JiraRepositoryBinding, { readonly status: 'resolved' }>;
    }
  | {
      readonly status: 'blocked';
      readonly reason: string;
    };

const issueKeyFromState = (state: JiraIssueState): JiraIssueKey =>
  state.status === 'unavailable' ? state.issueKey : state.issue.issueKey;

const missingBinding = (state: JiraIssueState): JiraRepositoryBinding =>
  JiraRepositoryBindingSchema.parse({
    status: 'missing',
    issueKey: issueKeyFromState(state),
    recordedAt: state.recordedAt,
  });

const bindingProblem = (binding: JiraRepositoryBinding): string => {
  switch (binding.status) {
    case 'resolved':
      return 'The managed repository is ready for workflow generation';
    case 'missing':
      return 'Add repo:name to the Jira description or supply a repository during import';
    case 'not_found':
      return `Repository ${binding.reference} was not found in Bitbucket`;
    case 'ambiguous':
      return `Repository ${binding.reference} exists in more than one Bitbucket project`;
    case 'unavailable':
      return binding.problem.message;
    case 'invalid':
      return 'The Jira description contains an invalid or conflicting repo directive';
  }
};

const taskFromState = (
  state: JiraIssueState,
  repositoryBinding: JiraRepositoryBinding,
): OperatorTaskSummary => {
  const issueKey = issueKeyFromState(state);
  const issue = state.status === 'unavailable' ? null : state.issue;
  const syncBlocked = state.status !== 'current';
  const repositoryResolved = repositoryBinding.status === 'resolved';
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
      repositoryBinding,
    },
    planning: {
      ...(syncBlocked || !repositoryResolved
        ? {
            status: 'blocked' as const,
            reason: syncBlocked
              ? 'Jira synchronization must recover before planning'
              : bindingProblem(repositoryBinding),
          }
        : { status: 'available' as const }),
    },
    status: syncBlocked || !repositoryResolved ? 'needs_attention' : 'backlog',
    attention: syncBlocked || !repositoryResolved ? 'operator' : 'none',
    currentStage:
      state.status === 'current'
        ? repositoryBinding.status === 'resolved'
          ? `${repositoryBinding.repository.repositoryId} mapped · ready to generate workflow`
          : 'Jira snapshot ready · repository mapping required'
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
    private readonly repositoryCatalog: RepositoryCatalog,
    private readonly repositoryReferenceSource: JiraRepositoryReferenceSource,
  ) {}

  public listOperatorTasks(): Outcome<readonly OperatorTaskSummary[], JiraIssueServiceError> {
    const states = this.store.list();
    if (!states.ok) return err({ kind: 'store_failure', error: states.error });
    const tasks: OperatorTaskSummary[] = [];
    for (const state of states.value) {
      const binding = this.store.readRepositoryBinding(issueKeyFromState(state));
      if (!binding.ok) return err({ kind: 'store_failure', error: binding.error });
      tasks.push(taskFromState(state, this.currentBinding(state, binding.value)));
    }
    return ok(tasks);
  }

  public listRepositories(): readonly RepositoryCatalogEntry[] {
    return this.repositoryCatalog.list();
  }

  private currentBinding(
    state: JiraIssueState,
    persisted: JiraRepositoryBinding | null,
  ): JiraRepositoryBinding {
    if (persisted === null) return missingBinding(state);
    if (persisted.status !== 'resolved') return persisted;
    const managed = this.repositoryCatalog.find(persisted.reference);
    if (managed.status === 'found') {
      return JiraRepositoryBindingSchema.parse({ ...persisted, repository: managed.repository });
    }
    if (managed.status === 'not_found') {
      return JiraRepositoryBindingSchema.parse({
        status: 'unavailable',
        issueKey: persisted.issueKey,
        recordedAt: persisted.recordedAt,
        source: persisted.source,
        reference: persisted.reference,
        problem: {
          kind: 'unavailable',
          message: 'Managed checkout is absent on this runner. Sync to provision it from Bitbucket',
          retryable: true,
        },
      });
    }
    return JiraRepositoryBindingSchema.parse({
      status: 'ambiguous',
      issueKey: persisted.issueKey,
      recordedAt: persisted.recordedAt,
      source: persisted.source,
      reference: persisted.reference,
      candidates: managed.candidates.map((candidate) => ({
        repositoryId: candidate.repositoryId,
        projectKey:
          candidate.aliases.find((alias) => alias.includes('/'))?.split('/')[0] ?? 'local',
        reference: candidate.aliases.find((alias) => alias.includes('/')) ?? candidate.repositoryId,
        remoteUrl: candidate.remoteUrl ?? `local:${candidate.checkout.path}`,
      })),
    });
  }

  public readRepositoryBinding(
    issueKeyInput: string,
  ): Outcome<JiraRepositoryBinding | null, JiraIssueServiceError> {
    const parsed = JiraIssueKeySchema.safeParse(issueKeyInput.toUpperCase());
    if (!parsed.success) return err({ kind: 'invalid_issue_key', input: issueKeyInput });
    const binding = this.store.readRepositoryBinding(parsed.data);
    return binding.ok ? binding : err({ kind: 'store_failure', error: binding.error });
  }

  public readWorkflowPlanningSource(
    issueKeyInput: string,
  ): Outcome<JiraWorkflowPlanningSource, JiraIssueServiceError> {
    const state = this.read(issueKeyInput);
    if (!state.ok) return state;
    if (state.value === null) {
      return err({ kind: 'issue_not_imported', issueKey: issueKeyInput });
    }
    if (state.value.status !== 'current') {
      return ok({
        status: 'blocked',
        reason: 'Jira synchronization must recover before workflow generation',
      });
    }
    const persisted = this.store.readRepositoryBinding(state.value.issue.issueKey);
    if (!persisted.ok) return err({ kind: 'store_failure', error: persisted.error });
    const binding = this.currentBinding(state.value, persisted.value);
    return binding.status === 'resolved'
      ? ok({ status: 'ready', issue: state.value.issue, binding })
      : ok({ status: 'blocked', reason: bindingProblem(binding) });
  }

  public read(issueKeyInput: string): Outcome<JiraIssueState | null, JiraIssueServiceError> {
    const parsed = JiraIssueKeySchema.safeParse(issueKeyInput.toUpperCase());
    if (!parsed.success) return err({ kind: 'invalid_issue_key', input: issueKeyInput });
    const state = this.store.read(parsed.data);
    return state.ok ? state : err({ kind: 'store_failure', error: state.error });
  }

  public sync(
    issueKeyInput: string,
    intakeRepository?: string,
  ): Promise<Outcome<JiraIssueState, JiraIssueServiceError>> {
    const normalized = issueKeyInput.trim().toUpperCase();
    const parsed = JiraIssueKeySchema.safeParse(normalized);
    if (!parsed.success) {
      return Promise.resolve(err({ kind: 'invalid_issue_key', input: issueKeyInput }));
    }

    const current = this.inFlight.get(parsed.data);
    if (current !== undefined) return current;
    const pending = this.syncOnce(parsed.data, intakeRepository).finally(() => {
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

    const visibleEventTypes = new Set([
      'JiraIntakeRequested',
      'JiraRepositoryBound',
      'JiraRepositoryBindingBlocked',
    ]);
    const stateEventTypes = new Set(['JiraRepositoryBound', 'JiraRepositoryBindingBlocked']);
    const auditEvents = this.store
      .listEvents(parsed.data)
      .filter((event) => visibleEventTypes.has(event.eventType));
    const lastSequenceByState = new Map<string, number>();
    for (const event of auditEvents) {
      if (!stateEventTypes.has(event.eventType)) continue;
      lastSequenceByState.set(
        `${event.eventType}:${JSON.stringify(event.payload)}`,
        event.sequence,
      );
    }

    const entries = auditEvents
      .filter((event) => {
        if (!stateEventTypes.has(event.eventType)) return true;
        const stateKey = `${event.eventType}:${JSON.stringify(event.payload)}`;
        return lastSequenceByState.get(stateKey) === event.sequence;
      })
      .map((event) => {
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
        if (event.eventType === 'JiraRepositoryBound') {
          return {
            sequence: event.sequence,
            occurredAt: event.occurredAt,
            source: 'planner' as const,
            level: 'info' as const,
            title: 'Repository mapped',
            detail:
              'The repository reference resolved to one logical repository and local checkout.',
          };
        }
        if (event.eventType === 'JiraRepositoryBindingBlocked') {
          return {
            sequence: event.sequence,
            occurredAt: event.occurredAt,
            source: 'planner' as const,
            level: 'warning' as const,
            title: 'Repository mapping blocked',
            detail: 'Add a valid repo:name directive or provide a known repository during import.',
          };
        }
        throw new Error(`Unmapped visible Jira activity event: ${event.eventType}`);
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
    intakeRepository?: string,
  ): Promise<Outcome<JiraIssueState, JiraIssueServiceError>> {
    const recordedAt = this.clock.now();
    const previous = this.store.read(issueKey);
    if (!previous.ok) return err({ kind: 'store_failure', error: previous.error });
    const previousBinding = this.store.readRepositoryBinding(issueKey);
    if (!previousBinding.ok) return err({ kind: 'store_failure', error: previousBinding.error });
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
    const saved =
      next.status === 'current'
        ? this.store.save({
            state: next,
            repositoryBinding: await resolveJiraRepositoryBinding({
              issue: next.issue,
              intakeFallback: intakeRepository,
              previousBinding: previousBinding.value,
              recordedAt,
              catalog: this.repositoryCatalog,
              referenceSource: this.repositoryReferenceSource,
            }),
          })
        : this.store.save({ state: next });
    return saved.ok ? saved : err({ kind: 'store_failure', error: saved.error });
  }
}

export interface CreateJiraIssueServiceOptions {
  readonly repositoryCatalog?: RepositoryCatalog | undefined;
  readonly repositoryReferenceSource?: JiraRepositoryReferenceSource | undefined;
}

export const createJiraIssueService = (
  ledger: LedgerRepository,
  clock: Clock,
  port: JiraIssuePort,
  options: CreateJiraIssueServiceOptions = {},
): JiraIssueService =>
  new JiraIssueService(
    new JiraIssueStore(ledger, clock),
    clock,
    port,
    options.repositoryCatalog ?? new StaticRepositoryCatalog([]),
    options.repositoryReferenceSource ?? new JiraDescriptionRepositoryReferenceSource(),
  );
