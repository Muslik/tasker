import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Circle,
  Download,
  ExternalLink,
  FileText,
  GitBranch,
  Image as ImageIcon,
  LoaderCircle,
  MessageSquare,
  Plus,
  Play,
  Radio,
  RefreshCw,
  Sparkles,
  Video,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type {
  OperatorActivityResponse,
  OperatorTaskSummary,
  WorkflowResponse,
  WorkflowView,
} from '../control-plane/m1-contracts.js';
import type { ImplementationPlanningRecord } from '../control-plane/implementation-planning.js';
import type { WorkflowContinuationRecord } from '../control-plane/workflow-continuation-contracts.js';
import type { JiraIssueState, JiraIssueSnapshot } from '../integrations/jira/contracts.js';
import type { PlanningStrategyRequest } from '../planning/implementation-plan.js';
import type { RepositoryCatalogEntry } from '../repositories/contracts.js';
import {
  answerPlanningClarification,
  connectOperatorStream,
  generateWorkflow,
  graphDownloadUrl,
  jiraAttachmentUrl,
  listOperatorTasks,
  listRepositories,
  loadImplementationPlan,
  loadWorkflowContinuation,
  loadJiraIssue,
  loadOperatorActivity,
  loadWorkflow,
  reviewPlan,
  reviewWorkflowContinuation,
  retryWorkflowContinuation,
  startWorkflow,
  syncJiraIssue,
} from './api-client.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './components/ui/collapsible.js';
import { ScrollArea } from './components/ui/scroll-area.js';
import { Separator } from './components/ui/separator.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './components/ui/tooltip.js';
import { cn } from './lib/utils.js';
import { WorkflowTree } from './WorkflowTree.js';

type WorkflowLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'missing' }
  | { readonly status: 'ready'; readonly response: WorkflowResponse }
  | { readonly status: 'failed'; readonly message: string };

type ActivityLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly response: OperatorActivityResponse }
  | { readonly status: 'failed'; readonly message: string };

type ImplementationPlanLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'missing' }
  | { readonly status: 'ready'; readonly record: ImplementationPlanningRecord }
  | { readonly status: 'failed'; readonly message: string };

type WorkflowContinuationLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'missing' }
  | { readonly status: 'ready'; readonly record: WorkflowContinuationRecord }
  | { readonly status: 'failed'; readonly message: string };

type JiraIssueLoadState =
  | { readonly status: 'not_applicable' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly state: JiraIssueState }
  | { readonly status: 'failed'; readonly message: string };

type JiraSyncState =
  | { readonly status: 'idle' }
  | { readonly status: 'syncing'; readonly issueKey: string }
  | { readonly status: 'failed'; readonly message: string };

type ConsoleStreamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

type TaskOperation =
  | 'generating'
  | 'starting'
  | 'approving_plan'
  | 'requesting_plan_changes'
  | 'answering_questions'
  | 'accepting_continuation'
  | 'rejecting_continuation'
  | 'retrying_continuation';

const STORAGE_KEY = 'tasker.operator.selectedTaskId';

const formatValue = (value: unknown): string =>
  value === undefined ? '—' : JSON.stringify(value, null, 2);

const formatShortDateTime = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));

const formatProviderSession = (activity: ActivityLoadState): string => {
  if (activity.status === 'loading') return 'provider session loading';
  if (activity.status === 'failed') return 'provider session unavailable';

  const session = activity.response.providerSession;
  if (session.status === 'not_started') return 'no provider session · deterministic fixture';

  const seconds = Math.max(0.1, session.durationMs / 1000).toFixed(1);
  const measuredTokens = session.usage.inputTokens + session.usage.outputTokens;
  return `${session.model} · read-only · ${seconds}s · ${measuredTokens.toLocaleString()} tok · API cost unrated`;
};

const readStoredSelection = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored !== null && stored.length > 0 ? stored : null;
};

const writeStoredSelection = (taskId: string): void => {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, taskId);
  }
};

const chooseInitialTask = (
  tasks: readonly OperatorTaskSummary[],
  storedSelection: string | null,
): string => {
  if (storedSelection !== null && tasks.some((task) => task.id === storedSelection)) {
    return storedSelection;
  }

  return tasks.find((task) => task.status === 'backlog')?.id ?? tasks[0]?.id ?? '';
};

const statusLabel = (status: OperatorTaskSummary['status']): string =>
  status.replaceAll('_', ' ').replace(/^\w/, (character) => character.toUpperCase());

const statusTone = (status: OperatorTaskSummary['status']): string => {
  switch (status) {
    case 'done':
      return 'bg-emerald-500/12 text-emerald-300';
    case 'failed':
    case 'workflow_rejected':
      return 'bg-destructive/15 text-destructive';
    case 'needs_attention':
    case 'plan_review':
    case 'waiting':
      return 'bg-amber-500/12 text-amber-300';
    case 'running':
      return 'bg-blue-500/12 text-blue-300';
    case 'code_review':
      return 'bg-violet-500/12 text-violet-300';
    case 'backlog':
    case 'planned':
    case 'queued':
      return 'bg-muted text-muted-foreground';
  }
};

const streamLabel = (status: ConsoleStreamStatus): string => {
  switch (status) {
    case 'live':
      return 'Live';
    case 'reconnecting':
      return 'Reconnecting';
    case 'connecting':
      return 'Connecting';
    case 'offline':
      return 'Offline';
  }
};

const sourceLabel = (source: OperatorActivityResponse['entries'][number]['source']): string =>
  source === 'kernel'
    ? 'Kernel'
    : source === 'planner'
      ? 'Planner'
      : source === 'operator'
        ? 'Operator'
        : source === 'agent'
          ? 'Agent'
          : 'Tool';

const StateBadge = ({
  children,
  className,
}: {
  readonly children: string;
  readonly className?: string;
}) => (
  <Badge variant="ghost" className={cn('h-5 px-1.5 text-[11px] font-medium', className)}>
    {children}
  </Badge>
);

const InlineError = ({ children }: { readonly children: string }) => (
  <div
    className="flex items-center gap-2 border-y border-destructive/25 bg-destructive/8 px-4 py-2 text-sm text-destructive"
    role="alert"
  >
    <AlertTriangle className="size-4 shrink-0" />
    <span className="truncate">{children}</span>
  </div>
);

const EmptyState = ({ children }: { readonly children: string }) => (
  <div className="flex min-h-24 items-center justify-center px-6 text-center text-sm text-muted-foreground">
    {children}
  </div>
);

const TaskQueue = ({
  tasks,
  repositories,
  selectedId,
  onSelect,
  onImportJira,
  jiraSync,
  liveStatus,
}: {
  readonly tasks: readonly OperatorTaskSummary[];
  readonly repositories: readonly RepositoryCatalogEntry[];
  readonly selectedId: string;
  readonly onSelect: (taskId: string) => void;
  readonly onImportJira: (issueKey: string, repository?: string) => void;
  readonly jiraSync: JiraSyncState;
  readonly liveStatus: ConsoleStreamStatus;
}) => {
  const [importOpen, setImportOpen] = useState(false);
  const [issueKey, setIssueKey] = useState('');
  const [repository, setRepository] = useState('');
  const counts = useMemo(() => {
    const result = new Map<OperatorTaskSummary['status'], number>();
    for (const task of tasks) {
      result.set(task.status, (result.get(task.status) ?? 0) + 1);
    }
    return result;
  }, [tasks]);

  const visibleCounts = (
    [
      'backlog',
      'queued',
      'running',
      'plan_review',
      'waiting',
      'planned',
      'needs_attention',
      'code_review',
      'done',
    ] as const
  ).filter((status) => (counts.get(status) ?? 0) > 0);

  return (
    <aside className="flex min-h-0 flex-col border-r border-border" aria-label="Task queue">
      <div className="px-3 pb-2 pt-3">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-semibold">Tasks</h2>
            <span className="text-xs tabular-nums text-muted-foreground">{tasks.length}</span>
          </div>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    liveStatus === 'live' ? 'bg-emerald-400' : 'bg-amber-400',
                  )}
                />
                {streamLabel(liveStatus)}
              </TooltipTrigger>
              <TooltipContent>Task updates from the persisted ledger</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Import Jira issue"
                onClick={() => {
                  setImportOpen((open) => !open);
                }}
              >
                <Plus className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Import Jira issue</TooltipContent>
            </Tooltip>
          </div>
        </div>
        {importOpen ? (
          <form
            className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (issueKey.trim().length === 0) return;
              onImportJira(issueKey, repository.trim() || undefined);
              setIssueKey('');
              setRepository('');
              setImportOpen(false);
            }}
          >
            <input
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs uppercase outline-none placeholder:normal-case placeholder:text-muted-foreground focus:border-ring"
              aria-label="Jira issue key"
              placeholder="AVIA-13235"
              value={issueKey}
              onChange={(event) => {
                setIssueKey(event.target.value);
              }}
            />
            <Button size="sm" type="submit" disabled={jiraSync.status === 'syncing'}>
              {jiraSync.status === 'syncing' ? <LoaderCircle className="animate-spin" /> : 'Open'}
            </Button>
            <input
              className="col-span-2 h-7 min-w-0 rounded-md border border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
              aria-label="Repository (optional)"
              placeholder="Repository (optional)"
              list="tasker-repositories"
              value={repository}
              onChange={(event) => {
                setRepository(event.target.value);
              }}
            />
            <datalist id="tasker-repositories">
              {repositories.map((entry) => (
                <option key={`${entry.repositoryId}:${entry.remoteUrl ?? entry.checkout.path}`}>
                  {entry.repositoryId}
                </option>
              ))}
            </datalist>
          </form>
        ) : null}
        {jiraSync.status === 'failed' ? (
          <p className="mt-1.5 text-[11px] text-destructive">{jiraSync.message}</p>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
          {visibleCounts.map((status) => (
            <span key={status}>
              <strong className="font-medium tabular-nums text-foreground">
                {counts.get(status)}
              </strong>{' '}
              {statusLabel(status).toLowerCase()}
            </span>
          ))}
        </div>
      </div>
      <Separator />

      <ScrollArea className="min-h-0 flex-1">
        <ol className="py-1" data-testid="task-list">
          {tasks.map((task) => {
            const selected = task.id === selectedId;

            return (
              <li key={task.id}>
                <button
                  className={cn(
                    'group relative w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/45',
                    selected && 'bg-muted/70',
                  )}
                  data-testid={`task-item-${task.id}`}
                  type="button"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => {
                    onSelect(task.id);
                  }}
                >
                  {selected ? (
                    <span className="absolute inset-y-2 left-0 w-0.5 rounded-r bg-primary" />
                  ) : null}
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
                      {task.taskId}
                    </span>
                    <div className="flex items-center gap-1">
                      {task.attention === 'operator' ? (
                        <AlertTriangle className="size-3 text-amber-400" aria-label="needs input" />
                      ) : null}
                      <StateBadge className={statusTone(task.status)}>
                        {statusLabel(task.status)}
                      </StateBadge>
                    </div>
                  </div>
                  <strong className="line-clamp-2 block text-[13px] font-medium leading-5 text-foreground">
                    {task.title}
                  </strong>
                </button>
              </li>
            );
          })}
        </ol>
      </ScrollArea>
    </aside>
  );
};

const SelectedTaskHeader = ({
  task,
  workflow,
  activity,
  onGenerate,
  onStart,
  requirePlanApproval,
  onRequirePlanApprovalChange,
  planningStrategy,
  onPlanningStrategyChange,
  onSyncJira,
  pendingOperation,
  jiraSync,
}: {
  readonly task: OperatorTaskSummary;
  readonly workflow: WorkflowLoadState;
  readonly activity: ActivityLoadState;
  readonly onGenerate: () => void;
  readonly onStart: () => void;
  readonly requirePlanApproval: boolean;
  readonly onRequirePlanApprovalChange: (required: boolean) => void;
  readonly planningStrategy: PlanningStrategyRequest;
  readonly onPlanningStrategyChange: (strategy: PlanningStrategyRequest) => void;
  readonly onSyncJira: (issueKey: string) => void;
  readonly pendingOperation: TaskOperation | null;
  readonly jiraSync: JiraSyncState;
}) => {
  const generating = pendingOperation === 'generating';
  const starting = pendingOperation === 'starting';
  const canGenerate =
    (task.status === 'backlog' || task.status === 'workflow_rejected') &&
    task.planning.status === 'available';
  const canStart =
    task.status === 'planned' &&
    workflow.status === 'ready' &&
    workflow.response.status === 'ready';

  return (
    <section className="border-b border-border px-5 py-3.5" data-testid="selected-task">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{task.taskId}</span>
            <span className="text-muted-foreground/50">·</span>
            <StateBadge className={statusTone(task.status)}>{statusLabel(task.status)}</StateBadge>
            <StateBadge>{task.currentStage}</StateBadge>
          </div>
          <h1 className="truncate text-lg font-semibold tracking-tight">{task.title}</h1>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span data-testid="provider-session-banner">{formatProviderSession(activity)}</span>
            {task.updatedAt === null ? null : (
              <>
                <span>·</span>
                <time dateTime={task.updatedAt}>{formatShortDateTime(task.updatedAt)}</time>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {canGenerate ? (
            <Button size="sm" type="button" onClick={onGenerate} disabled={generating}>
              {generating ? (
                <LoaderCircle data-icon="inline-start" className="animate-spin" />
              ) : (
                <Sparkles data-icon="inline-start" />
              )}
              {generating
                ? 'Generating…'
                : task.status === 'workflow_rejected'
                  ? 'Regenerate workflow'
                  : 'Generate workflow'}
            </Button>
          ) : null}
          {canStart ? (
            <>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="sr-only">Planning strategy</span>
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:border-ring"
                  aria-label="Planning strategy"
                  value={planningStrategy}
                  disabled={starting}
                  onChange={(event) => {
                    onPlanningStrategyChange(event.target.value as PlanningStrategyRequest);
                  }}
                >
                  <option value="auto">Auto plan</option>
                  <option value="fast">Fast plan</option>
                  <option value="ralplan">Ralplan</option>
                </select>
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  className="size-3.5 accent-primary"
                  type="checkbox"
                  aria-label="Review plan before execution"
                  checked={requirePlanApproval}
                  disabled={starting}
                  onChange={(event) => {
                    onRequirePlanApprovalChange(event.target.checked);
                  }}
                />
                Review plan
              </label>
              <Button size="sm" type="button" onClick={onStart} disabled={starting}>
                {starting ? (
                  <LoaderCircle data-icon="inline-start" className="animate-spin" />
                ) : (
                  <Play data-icon="inline-start" />
                )}
                {starting ? 'Testing…' : 'Test workflow'}
              </Button>
            </>
          ) : null}
          {task.origin.kind === 'jira' ? (
            <>
              {task.origin.browseUrl === null ? null : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <a
                        className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        href={task.origin.browseUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="Open in Jira"
                      />
                    }
                  >
                    <ExternalLink className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent>Open in Jira</TooltipContent>
                </Tooltip>
              )}
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled={jiraSync.status === 'syncing'}
                onClick={() => {
                  onSyncJira(task.taskId);
                }}
              >
                <RefreshCw
                  data-icon="inline-start"
                  className={jiraSync.status === 'syncing' ? 'animate-spin' : undefined}
                />
                Sync
              </Button>
            </>
          ) : workflow.status === 'ready' && !canStart ? (
            <StateBadge className="bg-emerald-500/12 text-emerald-300">Workflow ready</StateBadge>
          ) : null}
        </div>
      </div>
      {workflow.status === 'failed' ? <InlineError>{workflow.message}</InlineError> : null}
    </section>
  );
};

const PlanReviewControls = ({
  guidance,
  pendingOperation,
  onGuidanceChange,
  onApprove,
  onRequestChanges,
}: {
  readonly guidance: string;
  readonly pendingOperation: TaskOperation | null;
  readonly onGuidanceChange: (guidance: string) => void;
  readonly onApprove: () => void;
  readonly onRequestChanges: () => void;
}) => {
  const approving = pendingOperation === 'approving_plan';
  const requestingChanges = pendingOperation === 'requesting_plan_changes';
  const busy = approving || requestingChanges;

  return (
    <section
      className="border-b border-amber-500/20 bg-amber-500/4 px-5 py-3"
      data-testid="plan-review-controls"
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <strong className="text-sm">Review the implementation plan</strong>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Approve it, or send guidance for a new immutable planning attempt.
          </p>
        </div>
        <Button size="sm" type="button" disabled={busy} onClick={onApprove}>
          {approving ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
          {approving ? 'Approving…' : 'Approve plan'}
        </Button>
      </div>
      <div className="mt-2 flex items-end gap-2">
        <textarea
          className="min-h-16 flex-1 resize-y rounded-md border border-input bg-background/60 px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
          aria-label="Plan review guidance"
          placeholder="What should the agent change in the plan?"
          value={guidance}
          disabled={busy}
          onChange={(event) => {
            onGuidanceChange(event.target.value);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={busy || guidance.trim().length === 0}
          onClick={onRequestChanges}
        >
          {requestingChanges ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <MessageSquare data-icon="inline-start" />
          )}
          {requestingChanges ? 'Sending…' : 'Request changes'}
        </Button>
      </div>
    </section>
  );
};

const ValidationSurface = ({
  task,
  view,
}: {
  readonly task: OperatorTaskSummary;
  readonly view: WorkflowView;
}) => {
  const issues = view.workflow.validatorReport.issues;
  const blocked = view.workflow.status === 'rejected' || issues.length > 0;

  return (
    <section
      className={cn(
        'border-b border-border px-5 py-2.5',
        blocked ? 'bg-destructive/5' : 'bg-emerald-500/4',
      )}
      aria-label="Validation surface"
      data-testid="validation-panel"
    >
      <div className="flex items-center gap-2 text-sm">
        {blocked ? (
          <AlertTriangle className="size-4 text-destructive" />
        ) : (
          <CheckCircle2 className="size-4 text-emerald-400" />
        )}
        <strong>{blocked ? 'Human review required' : 'Validator passed'}</strong>
        <span className="text-xs text-muted-foreground">
          {task.currentStage} · {view.workflow.verificationPlan.profile.replaceAll('_', ' ')}
        </span>
      </div>
      {issues.length === 0 ? null : (
        <ol className="mt-2 space-y-1 pl-6" data-testid="validation-errors">
          {issues.map((issue) => (
            <li className="text-xs text-destructive" key={`${issue.code}:${issue.path.join('.')}`}>
              <code>{issue.code}</code> · {issue.message}
              {issue.details === undefined ? null : (
                <pre className="mt-1 overflow-auto text-[11px] text-muted-foreground">
                  {formatValue(issue.details)}
                </pre>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};

const JiraPlanningSurface = ({ task }: { readonly task: OperatorTaskSummary }) => {
  if (task.origin.kind !== 'jira' || task.planning.status !== 'blocked') return null;
  const binding = task.origin.repositoryBinding;
  const repositoryResolved = binding.status === 'resolved';

  return (
    <section
      className="border-b border-border bg-amber-500/4 px-5 py-2.5"
      aria-label="Jira planning status"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <AlertTriangle className="size-4 shrink-0 text-amber-400" />
        <strong>{repositoryResolved ? 'Repository mapped' : 'Workflow planning paused'}</strong>
        <span className="truncate text-xs text-muted-foreground">{task.planning.reason}</span>
      </div>
    </section>
  );
};

const ImplementationPlanSurface = ({
  planning,
  answers,
  pending,
  onAnswerChange,
  onSubmitAnswers,
}: {
  readonly planning: ImplementationPlanLoadState;
  readonly answers: ReadonlyMap<string, string>;
  readonly pending: boolean;
  readonly onAnswerChange: (questionId: string, answer: string) => void;
  readonly onSubmitAnswers: () => void;
}) => {
  if (planning.status === 'missing') return null;
  if (planning.status === 'loading') {
    return <EmptyState>Loading implementation plan…</EmptyState>;
  }
  if (planning.status === 'failed') return <InlineError>{planning.message}</InlineError>;

  const record = planning.record;
  if (record.status === 'planning') {
    return (
      <section className="border-b border-border px-5 py-4" aria-label="Implementation plan">
        <div className="flex items-center gap-2 text-sm">
          <LoaderCircle className="size-4 animate-spin text-primary" />
          <strong>Implementation plan</strong>
          <span className="text-xs text-muted-foreground">{record.selectedStrategy}</span>
        </div>
      </section>
    );
  }
  if (record.status === 'failed') {
    return (
      <section className="border-b border-border px-5 py-4" aria-label="Implementation plan">
        <div className="flex items-center gap-2 text-sm text-amber-300">
          <AlertTriangle className="size-4" />
          <strong>Planning paused</strong>
          <span className="text-xs text-muted-foreground">{record.failure.message}</span>
        </div>
      </section>
    );
  }
  if (record.status === 'needs_clarification') {
    const complete = record.decision.questions.every(
      (question) => (answers.get(question.id) ?? '').trim().length > 0,
    );
    return (
      <section
        className="border-b border-amber-500/20 bg-amber-500/4 px-5 py-4"
        aria-label="Implementation plan"
        data-testid="planning-clarification"
      >
        <div className="mb-2 flex items-center gap-2 text-sm">
          <MessageSquare className="size-4 text-amber-300" />
          <strong>Planner needs clarification</strong>
        </div>
        <ol className="space-y-3">
          {record.decision.questions.map((question) => (
            <li className="space-y-1" key={question.id}>
              <label className="block text-sm font-medium" htmlFor={`answer-${question.id}`}>
                {question.question}
              </label>
              <p className="text-xs text-muted-foreground">{question.reason}</p>
              <textarea
                id={`answer-${question.id}`}
                className="min-h-16 w-full resize-y rounded-md border border-input bg-background/60 px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
                placeholder="Your answer"
                value={answers.get(question.id) ?? ''}
                disabled={pending}
                onChange={(event) => {
                  onAnswerChange(question.id, event.target.value);
                }}
              />
            </li>
          ))}
        </ol>
        <div className="mt-3 flex justify-end">
          <Button size="sm" type="button" disabled={pending || !complete} onClick={onSubmitAnswers}>
            {pending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
            {pending ? 'Planning…' : 'Continue planning'}
          </Button>
        </div>
      </section>
    );
  }
  if (record.status === 'workflow_change_required') {
    return (
      <section
        className="border-b border-border px-5 py-4"
        aria-label="Implementation plan"
        data-testid="implementation-plan"
      >
        <div className="mb-1 flex items-center gap-2 text-sm">
          <GitBranch className="size-4 text-amber-300" />
          <strong>Workflow change required</strong>
          <StateBadge>{record.selectedStrategy}</StateBadge>
          <span className="text-[11px] text-muted-foreground">attempt {record.attempt}</span>
        </div>
        <p className="text-sm text-muted-foreground">{record.decision.request.reason}</p>
        {record.operatorGuidance === null ? null : (
          <p className="mt-1 text-xs text-muted-foreground">Operator: {record.operatorGuidance}</p>
        )}
      </section>
    );
  }

  const plan = record.decision.plan;
  const measuredTokens = record.receipt.usage.inputTokens + record.receipt.usage.outputTokens;
  const apiCost =
    record.receipt.hypotheticalApiCostUsd === null
      ? 'API cost unrated'
      : `~$${record.receipt.hypotheticalApiCostUsd.toFixed(2)} API`;
  return (
    <Collapsible defaultOpen>
      <section
        className="border-b border-border"
        aria-label="Implementation plan"
        data-testid="implementation-plan"
      >
        <CollapsibleTrigger className="group flex w-full items-center justify-between px-5 py-3 text-left hover:bg-muted/30">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <GitBranch className="size-4 text-muted-foreground" />
              <strong className="text-sm">Implementation plan</strong>
              <StateBadge>{record.selectedStrategy}</StateBadge>
              <span className="text-[11px] text-muted-foreground">
                attempt {record.attempt} · {record.receipt.provider} ·{' '}
                {(record.receipt.durationMs / 1000).toFixed(1)}s · {measuredTokens.toLocaleString()}{' '}
                tok · {apiCost}
              </span>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">{plan.title}</p>
          </div>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-5 pb-4">
            <p className="mb-3 max-w-4xl text-[13px] leading-5 text-muted-foreground">
              {plan.summary}
            </p>
            <ol className="space-y-3">
              {plan.steps.map((step, index) => (
                <li className="grid grid-cols-[20px_minmax(0,1fr)] gap-2" key={step.id}>
                  <span className="text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                  <div className="min-w-0">
                    <strong className="text-[13px] font-medium">{step.title}</strong>
                    <p className="text-xs leading-5 text-muted-foreground">{step.objective}</p>
                    {step.files.length === 0 ? null : (
                      <p className="truncate font-mono text-[10px] text-muted-foreground/80">
                        {step.files.join(' · ')}
                      </p>
                    )}
                    <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                      {step.verification.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-[11px] text-muted-foreground">
              Why {record.selectedStrategy}: {record.selectionReason}
            </p>
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
};

const continuationCandidateReference = (record: WorkflowContinuationRecord): string | null => {
  if ('candidate' in record) return record.candidate.taskReference;
  return record.status === 'invalid' ? record.candidateTaskReference : null;
};

const WorkflowContinuationSurface = ({
  continuation,
  planning,
  candidateActivity,
  guidance,
  pendingOperation,
  onGuidanceChange,
  onAccept,
  onReject,
  onRevise,
  onRetry,
}: {
  readonly continuation: WorkflowContinuationLoadState;
  readonly planning: ImplementationPlanLoadState;
  readonly candidateActivity: ActivityLoadState | null;
  readonly guidance: string;
  readonly pendingOperation: TaskOperation | null;
  readonly onGuidanceChange: (guidance: string) => void;
  readonly onAccept: () => void;
  readonly onReject: () => void;
  readonly onRevise: () => void;
  readonly onRetry: () => void;
}) => {
  if (continuation.status === 'loading' || continuation.status === 'missing') return null;
  if (continuation.status === 'failed') return <InlineError>{continuation.message}</InlineError>;

  const record = continuation.record;
  const busy =
    pendingOperation === 'accepting_continuation' ||
    pendingOperation === 'rejecting_continuation' ||
    pendingOperation === 'retrying_continuation';
  const retryable =
    (record.status === 'blocked' || record.status === 'failed') &&
    record.issues.some((issue) => issue.retryable);
  const revisionRetryable =
    record.status === 'rejected_by_operator' &&
    !(planning.status === 'ready' && planning.record.status === 'needs_clarification');

  return (
    <section
      className="border-b border-amber-500/20 bg-amber-500/4 px-5 py-3"
      aria-label="Workflow continuation"
      data-testid="workflow-continuation-review"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GitBranch className="size-4 text-amber-300" />
            <strong className="text-sm">Workflow continuation</strong>
            <StateBadge>{record.status.replaceAll('_', ' ')}</StateBadge>
            <span className="text-[11px] text-muted-foreground">attempt {record.attempt}</span>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {record.source.request.reason}
          </p>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {record.source.request.discoveredRepositories.map((repository) => (
              <span key={repository}>{repository}</span>
            ))}
            {record.source.request.requiredCapabilities.map((capability) => (
              <code key={capability}>{capability}</code>
            ))}
            {candidateActivity === null ? null : (
              <span>{formatProviderSession(candidateActivity)}</span>
            )}
          </div>
        </div>
        {retryable ? (
          <Button size="sm" type="button" disabled={busy} onClick={onRetry}>
            {pendingOperation === 'retrying_continuation' ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            Retry
          </Button>
        ) : null}
        {revisionRetryable ? (
          <Button size="sm" type="button" disabled={busy} onClick={onRevise}>
            {pendingOperation === 'rejecting_continuation' ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            Retry planning
          </Button>
        ) : null}
        {record.status === 'awaiting_review' || record.status === 'accepted' ? (
          <Button size="sm" type="button" disabled={busy} onClick={onAccept}>
            {pendingOperation === 'accepting_continuation' ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : (
              <CheckCircle2 data-icon="inline-start" />
            )}
            {record.status === 'accepted' ? 'Start continuation' : 'Accept workflow'}
          </Button>
        ) : null}
      </div>

      {'issues' in record ? (
        <ul className="mt-2 space-y-1 text-xs text-destructive">
          {record.issues.map((issue) => (
            <li key={`${issue.code}:${issue.message}`}>
              <code>{issue.code}</code> · {issue.message}
            </li>
          ))}
        </ul>
      ) : null}

      {record.status === 'linked' ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Linked run <code>{record.child.runId}</code>
        </p>
      ) : null}

      {record.status === 'awaiting_review' ? (
        <div className="mt-2 flex items-end gap-2">
          <textarea
            className="min-h-14 flex-1 resize-y rounded-md border border-input bg-background/60 px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
            aria-label="Workflow continuation guidance"
            placeholder="Why should this workflow be rejected?"
            value={guidance}
            disabled={busy}
            onChange={(event) => {
              onGuidanceChange(event.target.value);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={busy || guidance.trim().length === 0}
            onClick={onReject}
          >
            {pendingOperation === 'rejecting_continuation' ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : (
              <MessageSquare data-icon="inline-start" />
            )}
            Reject
          </Button>
        </div>
      ) : null}

      {record.status === 'rejected_by_operator' ? (
        <p className="mt-2 text-xs text-muted-foreground">Operator: {record.guidance}</p>
      ) : null}
      {record.status === 'superseded_by_plan' ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Revised parent plan {record.implementationPlanArtifactId} replaces this candidate.
        </p>
      ) : null}
    </section>
  );
};

type JiraDescriptionBlock =
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'ordered_list'; readonly items: readonly string[] }
  | { readonly kind: 'unordered_list'; readonly items: readonly string[] };

const parseJiraDescription = (source: string): readonly JiraDescriptionBlock[] => {
  const blocks: JiraDescriptionBlock[] = [];
  let paragraph: string[] = [];
  let list: { kind: 'ordered_list' | 'unordered_list'; items: string[] } | null = null;

  const flushParagraph = (): void => {
    const text = paragraph.join(' ').trim();
    if (text.length > 0) blocks.push({ kind: 'paragraph', text });
    paragraph = [];
  };
  const flushList = (): void => {
    if (list !== null && list.items.length > 0) blocks.push(list);
    list = null;
  };

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const heading = /^h[1-6]\.\s+(?<text>.+)$/u.exec(line)?.groups?.text;
    const orderedItem = /^#\s+(?<text>.+)$/u.exec(line)?.groups?.text;
    const unorderedItem = /^\*\s+(?<text>.+)$/u.exec(line)?.groups?.text;

    if (heading !== undefined) {
      flushParagraph();
      flushList();
      blocks.push({ kind: 'heading', text: heading });
    } else if (orderedItem !== undefined) {
      flushParagraph();
      if (list?.kind !== 'ordered_list') {
        flushList();
        list = { kind: 'ordered_list', items: [] };
      }
      list.items.push(orderedItem);
    } else if (unorderedItem !== undefined) {
      flushParagraph();
      if (list?.kind !== 'unordered_list') {
        flushList();
        list = { kind: 'unordered_list', items: [] };
      }
      list.items.push(unorderedItem);
    } else if (line.length === 0) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
};

const INLINE_JIRA_TOKEN =
  /(\{\{.*?\}\}|\[\^[^\]]+\]|\[[^\]|]+\|https?:\/\/[^\]]+\]|https?:\/\/[^\s]+)/gu;

const renderJiraInline = (text: string, issue: JiraIssueSnapshot): readonly ReactNode[] => {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_JIRA_TOKEN)) {
    const index = match.index;
    const token = match[0];
    if (index > cursor) nodes.push(text.slice(cursor, index));

    if (token.startsWith('{{') && token.endsWith('}}')) {
      nodes.push(
        <code className="rounded bg-muted/60 px-1 py-0.5 text-[0.9em]" key={index}>
          {token.slice(2, -2).replaceAll('\\-', '-')}
        </code>,
      );
    } else if (token.startsWith('[^')) {
      const filename = token.slice(2, -1);
      const attachment = issue.attachments.find((item) => item.filename === filename);
      nodes.push(
        attachment === undefined ? (
          token
        ) : (
          <a
            className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
            href={jiraAttachmentUrl(issue.issueKey, attachment.id)}
            key={index}
          >
            {filename}
          </a>
        ),
      );
    } else if (token.startsWith('[')) {
      const separator = token.indexOf('|');
      nodes.push(
        <a
          className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
          href={token.slice(separator + 1, -1)}
          key={index}
          target="_blank"
          rel="noreferrer"
        >
          {token.slice(1, separator)}
        </a>,
      );
    } else {
      nodes.push(
        <a
          className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
          href={token}
          key={index}
          target="_blank"
          rel="noreferrer"
        >
          {token}
        </a>,
      );
    }
    cursor = index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
};

const JiraDescription = ({
  issue,
  source,
}: {
  readonly issue: JiraIssueSnapshot;
  readonly source: string;
}) => (
  <div className="max-w-4xl space-y-2 text-[13px] leading-6 text-muted-foreground">
    {parseJiraDescription(source).map((block, index) => {
      if (block.kind === 'heading') {
        return (
          <h3 className="pt-2 text-sm font-semibold text-foreground first:pt-0" key={index}>
            {renderJiraInline(block.text, issue)}
          </h3>
        );
      }
      if (block.kind === 'paragraph') {
        return <p key={index}>{renderJiraInline(block.text, issue)}</p>;
      }
      const List = block.kind === 'ordered_list' ? 'ol' : 'ul';
      return (
        <List
          className={cn(
            'space-y-1 pl-5',
            block.kind === 'ordered_list' ? 'list-decimal' : 'list-disc',
          )}
          key={index}
        >
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderJiraInline(item, issue)}</li>
          ))}
        </List>
      );
    })}
  </div>
);

const JiraAttachments = ({ issue }: { readonly issue: JiraIssueSnapshot }) => {
  const images = issue.attachments.filter((attachment) => attachment.mimeType.startsWith('image/'));
  const videos = issue.attachments.filter((attachment) => attachment.mimeType.startsWith('video/'));
  const files = issue.attachments.filter(
    (attachment) =>
      !attachment.mimeType.startsWith('image/') && !attachment.mimeType.startsWith('video/'),
  );
  if (issue.attachments.length === 0) return null;

  return (
    <Collapsible>
      <section className="mt-4 border-t border-border/70" aria-label="Jira attachments">
        <CollapsibleTrigger className="group flex w-full items-center justify-between py-3 text-left hover:text-foreground">
          <div className="flex items-center gap-2">
            <ImageIcon className="size-3.5 text-muted-foreground" />
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Evidence · {issue.attachments.length}
            </h3>
          </div>
          <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pb-2">
            {images.length === 0 ? null : (
              <div className="flex flex-wrap gap-2">
                {images.map((attachment) => (
                  <a
                    className="group w-40 min-w-0 overflow-hidden rounded-md bg-muted/20"
                    href={jiraAttachmentUrl(issue.issueKey, attachment.id)}
                    key={attachment.id}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <img
                      className="h-24 w-full object-contain transition-opacity group-hover:opacity-85"
                      src={jiraAttachmentUrl(issue.issueKey, attachment.id)}
                      alt={attachment.filename}
                      loading="lazy"
                    />
                    <span className="block truncate px-2 py-1.5 text-[11px] text-muted-foreground">
                      {attachment.filename}
                    </span>
                  </a>
                ))}
              </div>
            )}
            {videos.length === 0 ? null : (
              <div className="mt-2 flex flex-wrap gap-2">
                {videos.map((attachment) => (
                  <a
                    className="flex h-12 w-64 min-w-0 items-center gap-2 rounded-md bg-muted/20 px-3 text-xs hover:bg-muted/40"
                    href={jiraAttachmentUrl(issue.issueKey, attachment.id)}
                    key={attachment.id}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Video className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
                    <span className="text-[11px] text-muted-foreground">View</span>
                  </a>
                ))}
              </div>
            )}
            {files.map((attachment) => (
              <a
                className="mt-2 flex items-center gap-2 text-xs text-primary"
                href={jiraAttachmentUrl(issue.issueKey, attachment.id)}
                key={attachment.id}
              >
                <FileText className="size-3.5" />
                {attachment.filename}
              </a>
            ))}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
};

const TaskDetails = ({
  details,
  onRetry,
  syncing,
}: {
  readonly details: JiraIssueLoadState;
  readonly onRetry: (issueKey: string) => void;
  readonly syncing: boolean;
}) => {
  if (details.status === 'not_applicable') return null;
  if (details.status === 'loading') {
    return <EmptyState>Loading Jira snapshot…</EmptyState>;
  }
  if (details.status === 'failed') {
    return <InlineError>{details.message}</InlineError>;
  }

  const state = details.state;
  const issue = state.status === 'unavailable' ? null : state.issue;
  const issueKey = state.status === 'unavailable' ? state.issueKey : state.issue.issueKey;
  return (
    <Collapsible defaultOpen>
      <div className="border-b border-border" data-testid="jira-task-details">
        <CollapsibleTrigger className="group flex w-full items-center justify-between px-5 py-3 text-left hover:bg-muted/30">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium">Task details</span>
            <StateBadge
              className={
                state.status === 'current'
                  ? 'bg-emerald-500/12 text-emerald-300'
                  : 'bg-amber-500/12 text-amber-300'
              }
            >
              {state.status === 'current'
                ? 'Jira synced'
                : state.status === 'stale'
                  ? 'Cached'
                  : 'Unavailable'}
            </StateBadge>
            <span className="text-[11px] text-muted-foreground">
              {state.status === 'current' ? 'Synced' : 'Checked'}{' '}
              {formatShortDateTime(state.recordedAt)}
            </span>
          </div>
          <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-5 pb-5">
            {state.status === 'current' ? null : (
              <div
                className="mb-4 flex items-center justify-between gap-3 bg-amber-500/7 px-3 py-2 text-xs text-amber-200"
                role="status"
              >
                <span>
                  {state.problem.message}
                  {state.status === 'stale'
                    ? ` · cached ${formatShortDateTime(state.lastSuccessfulSyncAt)}`
                    : ''}
                </span>
                {state.problem.retryable ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    disabled={syncing}
                    onClick={() => {
                      onRetry(issueKey);
                    }}
                  >
                    <RefreshCw
                      data-icon="inline-start"
                      className={syncing ? 'animate-spin' : undefined}
                    />
                    Retry
                  </Button>
                ) : null}
              </div>
            )}
            <div className="max-h-[430px] overflow-y-auto pr-2">
              {issue === null ? (
                <p className="text-sm text-muted-foreground">
                  No Jira snapshot is available yet. The persisted intake will remain here while
                  access is restored.
                </p>
              ) : (
                <>
                  <dl className="mb-4 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                    <div className="flex gap-1.5">
                      <dt className="text-muted-foreground">Type</dt>
                      <dd>{issue.issueType}</dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="text-muted-foreground">Status</dt>
                      <dd>{issue.status}</dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="text-muted-foreground">Assignee</dt>
                      <dd>{issue.assignee?.displayName ?? 'Unassigned'}</dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="text-muted-foreground">Priority</dt>
                      <dd>{issue.priority}</dd>
                    </div>
                    {issue.repositoryHint === null ? null : (
                      <div className="flex gap-1.5">
                        <dt className="text-muted-foreground">Code</dt>
                        <dd>
                          <code>{issue.repositoryHint}</code>
                        </dd>
                      </div>
                    )}
                  </dl>
                  {issue.labels.length === 0 ? null : (
                    <div className="mb-4 flex flex-wrap gap-1">
                      {issue.labels.map((label) => (
                        <StateBadge key={label}>{label}</StateBadge>
                      ))}
                    </div>
                  )}
                  <JiraDescription issue={issue} source={issue.description} />
                  <JiraAttachments issue={issue} />
                  {issue.comments.length === 0 ? null : (
                    <section
                      className="mt-4 border-t border-border/70 pt-4"
                      aria-label="Jira comments"
                    >
                      <div className="mb-2 flex items-center gap-2">
                        <MessageSquare className="size-3.5 text-muted-foreground" />
                        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Comments · {issue.comments.length}
                        </h3>
                      </div>
                      <ol className="space-y-3">
                        {issue.comments.map((comment) => (
                          <li key={comment.id}>
                            <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                              <strong className="font-medium">{comment.author.displayName}</strong>
                              <time
                                className="text-[11px] text-muted-foreground"
                                dateTime={comment.createdAt}
                              >
                                {formatShortDateTime(comment.createdAt)}
                              </time>
                            </div>
                            <JiraDescription issue={issue} source={comment.body} />
                          </li>
                        ))}
                      </ol>
                    </section>
                  )}
                  {issue.links.length === 0 ? null : (
                    <section className="mt-4 border-t border-border/70 pt-4 text-xs">
                      {issue.links.map((link) => (
                        <div
                          className="flex gap-2 py-1"
                          key={`${link.relationship}:${link.issueKey}`}
                        >
                          <span className="text-muted-foreground">{link.relationship}</span>
                          <span>
                            {link.issueKey} · {link.summary}
                          </span>
                          <StateBadge>{link.status}</StateBadge>
                        </div>
                      ))}
                    </section>
                  )}
                </>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};

const ActivityTimeline = ({
  activity,
  streamStatus,
}: {
  readonly activity: ActivityLoadState;
  readonly streamStatus: ConsoleStreamStatus;
}) => (
  <section className="px-5 py-4" aria-label="Activity timeline">
    <div className="mb-3 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Activity className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Activity</h2>
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Radio className={cn('size-3', streamStatus === 'live' && 'text-emerald-400')} />
        {streamLabel(streamStatus)}
      </div>
    </div>

    {activity.status === 'loading' ? <EmptyState>Loading activity…</EmptyState> : null}
    {activity.status === 'failed' ? <InlineError>{activity.message}</InlineError> : null}
    {activity.status === 'ready' ? (
      <ol className="relative" data-testid="task-activity-timeline">
        {activity.response.entries.length === 0 ? (
          <EmptyState>No persisted activity yet</EmptyState>
        ) : (
          activity.response.entries.map((entry, index) => (
            <li className="relative flex gap-3 pb-4 last:pb-0" key={entry.sequence}>
              {index === activity.response.entries.length - 1 ? null : (
                <span className="absolute bottom-0 left-[7px] top-4 w-px bg-border" />
              )}
              <span
                className={cn(
                  'relative mt-1.5 size-3.5 shrink-0 rounded-full border-[3px] border-background',
                  entry.level === 'error'
                    ? 'bg-destructive'
                    : entry.level === 'warning'
                      ? 'bg-amber-400'
                      : 'bg-muted-foreground',
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <span className="mr-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {sourceLabel(entry.source)}
                    </span>
                    <strong className="text-sm font-medium">{entry.title}</strong>
                  </div>
                  <time
                    className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
                    dateTime={entry.occurredAt}
                  >
                    {formatShortDateTime(entry.occurredAt)}
                  </time>
                </div>
                <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{entry.detail}</p>
              </div>
            </li>
          ))
        )}
      </ol>
    ) : null}
  </section>
);

const WhyThisWorkflow = ({ view }: { readonly view: WorkflowView }) => (
  <Collapsible>
    <div className="border-t border-border" data-testid="workflow-decisions">
      <CollapsibleTrigger className="group flex w-full items-center justify-between px-5 py-3 text-left hover:bg-muted/30">
        <div className="flex items-center gap-2">
          <GitBranch className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Why this workflow</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {view.workflow.assemblyDecisions.length} decisions
          </span>
        </div>
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="pb-3" data-testid="workflow-decision-list">
          {view.workflow.assemblyDecisions.map((decision) => (
            <li
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-5 py-2 hover:bg-muted/20"
              key={decision.id}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <strong className="truncate text-[13px] font-medium">{decision.title}</strong>
                  <code className="shrink-0 text-[10px] text-muted-foreground">
                    {decision.source}
                  </code>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{decision.effect}</p>
              </div>
              <Tooltip>
                <TooltipTrigger className="self-start text-[11px] text-muted-foreground underline decoration-dotted underline-offset-4">
                  reason
                </TooltipTrigger>
                <TooltipContent className="max-w-sm">{decision.reason}</TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </div>
  </Collapsible>
);

const WorkflowDiagnostics = ({ view }: { readonly view: WorkflowView }) => (
  <details className="group border-t border-border" data-testid="workflow-debug-details">
    <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-3 text-sm font-medium hover:bg-muted/30">
      <span>Diagnostics</span>
      <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
    </summary>
    <div className="space-y-3 px-5 pb-4 text-xs">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
        <dt>Assembly</dt>
        <dd className="truncate text-foreground">Task-specific graph</dd>
        <dt>Proposal</dt>
        <dd className="truncate font-mono text-foreground">{view.workflow.proposalId}</dd>
        <dt>Graph</dt>
        <dd className="truncate font-mono text-foreground" data-testid="graph-hash">
          {view.workflow.graphHash ?? 'not compiled'}
        </dd>
      </dl>
      <p className="text-muted-foreground">
        Built from an empty graph using the registered node, step, policy, and obligation catalog.
      </p>
    </div>
  </details>
);

const WorkflowSidebar = ({
  workflow,
  task,
}: {
  readonly workflow: WorkflowLoadState;
  readonly task: OperatorTaskSummary | null;
}) => {
  if (workflow.status === 'loading') {
    return (
      <aside className="flex min-h-0 flex-col" aria-label="Current workflow">
        <EmptyState>Loading workflow…</EmptyState>
      </aside>
    );
  }

  if (workflow.status === 'missing') {
    if (task?.origin.kind === 'jira') {
      const binding = task.origin.repositoryBinding;
      const repositoryResolved = binding.status === 'resolved';
      const repositoryLabel = repositoryResolved
        ? binding.repository.repositoryId
        : binding.status === 'missing'
          ? null
          : 'reference' in binding
            ? binding.reference
            : null;
      const prerequisites = [
        ['Jira snapshot', 'complete'],
        ['Repository mapping', repositoryResolved ? 'complete' : 'blocked'],
        ['Read-only analysis', repositoryResolved ? 'ready' : 'waiting'],
        ['Compile & validate', 'waiting'],
      ] as const;
      return (
        <aside className="flex min-h-0 flex-col" aria-label="Current workflow">
          <div className="border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Workflow</h2>
              <StateBadge
                className={
                  repositoryResolved
                    ? 'bg-emerald-500/12 text-emerald-300'
                    : 'bg-amber-500/12 text-amber-300'
                }
              >
                {repositoryResolved ? 'ready' : 'blocked'}
              </StateBadge>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              No workflow has been compiled for this Jira snapshot.
            </p>
          </div>
          <div className="px-4 py-4 text-xs">
            <p className="mb-4 text-[11px] uppercase tracking-wide text-muted-foreground">
              {task.origin.issueKey} · Jira · {task.origin.syncStatus} snapshot
              {repositoryLabel === null ? '' : ` · ${repositoryLabel}`}
            </p>
            <ol className="space-y-1" aria-label="Workflow planning prerequisites">
              {prerequisites.map(([label, status], index) => (
                <li className="relative flex min-h-9 items-start gap-2.5" key={label}>
                  {index === 3 ? null : (
                    <span className="absolute bottom-0 left-[5px] top-3 w-px bg-border" />
                  )}
                  <span
                    className={cn(
                      'relative mt-1 size-3 rounded-full border-2 border-background',
                      status === 'complete'
                        ? 'bg-emerald-400'
                        : status === 'ready'
                          ? 'bg-cyan-400'
                          : status === 'blocked'
                            ? 'bg-amber-400'
                            : 'bg-muted',
                    )}
                  />
                  <div>
                    <div className="font-medium">{label}</div>
                    <div className="mt-0.5 capitalize text-muted-foreground">{status}</div>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-4 border-t border-border pt-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Next</div>
              <p className="mt-1 leading-5 text-muted-foreground">
                {repositoryResolved
                  ? `Run the read-only workflow analyzer against ${binding.repository.repositoryId}.`
                  : 'Add repo:name to the Jira description or re-import with a repository.'}
              </p>
            </div>
          </div>
        </aside>
      );
    }
    return (
      <aside className="flex min-h-0 flex-col" aria-label="Current workflow">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Workflow</h2>
        </div>
        <EmptyState>Generate the task to inspect its workflow</EmptyState>
      </aside>
    );
  }

  if (workflow.status === 'failed') {
    return (
      <aside className="flex min-h-0 flex-col" aria-label="Current workflow">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Workflow</h2>
        </div>
        <InlineError>{workflow.message}</InlineError>
      </aside>
    );
  }

  const view = workflow.response.view;
  const retryCount = Object.keys(view.workflow.retryBudgets).length;

  return (
    <aside
      className="flex min-h-0 flex-col"
      aria-label="Current workflow"
      data-testid="workflow-sidebar"
    >
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Workflow</h2>
              <StateBadge
                className={
                  view.workflow.status === 'valid'
                    ? 'bg-emerald-500/12 text-emerald-300'
                    : 'bg-destructive/15 text-destructive'
                }
              >
                {view.workflow.status}
              </StateBadge>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">{view.fixture.title}</p>
          </div>
          {view.workflow.graphHash === null ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <a
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    href={graphDownloadUrl(view.fixture.id)}
                    download
                    aria-label="Download graph JSON"
                  />
                }
              >
                <Download className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Download graph JSON</TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span>{view.workflow.verificationPlan.profile.replaceAll('_', ' ')}</span>
          <span>{view.workflow.waits.length} waits</span>
          <span>{retryCount} retries</span>
          <span>{view.workflow.capabilities.required.length} capabilities</span>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2 py-2">
        {view.workflow.tree === null ? (
          <EmptyState>Workflow rejected before graph materialization</EmptyState>
        ) : (
          <WorkflowTree root={view.workflow.tree} />
        )}
      </ScrollArea>
    </aside>
  );
};

export const App = () => {
  const [tasks, setTasks] = useState<readonly OperatorTaskSummary[]>([]);
  const [repositories, setRepositories] = useState<readonly RepositoryCatalogEntry[]>([]);
  const [tasksStatus, setTasksStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [tasksMessage, setTasksMessage] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>(() => readStoredSelection() ?? '');
  const [workflowState, setWorkflowState] = useState<WorkflowLoadState>({ status: 'loading' });
  const [activityState, setActivityState] = useState<ActivityLoadState>({ status: 'loading' });
  const [implementationPlanState, setImplementationPlanState] =
    useState<ImplementationPlanLoadState>({ status: 'missing' });
  const [workflowContinuationState, setWorkflowContinuationState] =
    useState<WorkflowContinuationLoadState>({ status: 'missing' });
  const [continuationWorkflowState, setContinuationWorkflowState] = useState<WorkflowLoadState>({
    status: 'missing',
  });
  const [continuationActivityState, setContinuationActivityState] =
    useState<ActivityLoadState | null>(null);
  const [jiraIssueState, setJiraIssueState] = useState<JiraIssueLoadState>({
    status: 'not_applicable',
  });
  const [jiraSyncState, setJiraSyncState] = useState<JiraSyncState>({ status: 'idle' });
  const [streamStatus, setStreamStatus] = useState<ConsoleStreamStatus>('connecting');
  const [pendingOperations, setPendingOperations] = useState<ReadonlyMap<string, TaskOperation>>(
    new Map(),
  );
  const [planGuidanceDrafts, setPlanGuidanceDrafts] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [continuationGuidanceDrafts, setContinuationGuidanceDrafts] = useState<
    ReadonlyMap<string, string>
  >(new Map());
  const [planningAnswerDrafts, setPlanningAnswerDrafts] = useState<
    ReadonlyMap<string, ReadonlyMap<string, string>>
  >(new Map());
  const [planApprovalDrafts, setPlanApprovalDrafts] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [planningStrategyDrafts, setPlanningStrategyDrafts] = useState<
    ReadonlyMap<string, PlanningStrategyRequest>
  >(new Map());
  const streamCursorRef = useRef(0);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? null,
    [tasks, selectedId],
  );

  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
    if (selectedId.length > 0) {
      writeStoredSelection(selectedId);
    }
  }, [selectedId]);

  const refreshTasks = async (): Promise<string | null> => {
    try {
      const response = await listOperatorTasks();
      const nextTasks = response.tasks;
      streamCursorRef.current = response.streamCursor;
      setTasks(nextTasks);
      setTasksStatus('ready');
      setTasksMessage(null);

      const currentSelectedId = selectedIdRef.current;
      const nextSelectedId =
        currentSelectedId.length > 0 && nextTasks.some((task) => task.id === currentSelectedId)
          ? currentSelectedId
          : chooseInitialTask(nextTasks, readStoredSelection());

      if (nextSelectedId !== selectedIdRef.current) {
        setSelectedId(nextSelectedId);
      }

      return nextSelectedId;
    } catch (error) {
      setTasksStatus('failed');
      setTasksMessage(error instanceof Error ? error.message : 'Unexpected task queue failure');
      return null;
    }
  };

  const refreshSelectedWorkflow = async (fixtureId: string): Promise<void> => {
    setWorkflowState({ status: 'loading' });
    try {
      const response = await loadWorkflow(fixtureId);
      setWorkflowState(
        response.status === 'found'
          ? { status: 'ready', response: response.response }
          : { status: 'missing' },
      );
    } catch (error) {
      setWorkflowState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unexpected workflow failure',
      });
    }
  };

  const refreshSelectedActivity = async (fixtureId: string): Promise<void> => {
    setActivityState({ status: 'loading' });
    try {
      const response = await loadOperatorActivity(fixtureId);
      setActivityState({ status: 'ready', response });
    } catch (error) {
      setActivityState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unexpected activity failure',
      });
    }
  };

  const refreshSelectedImplementationPlan = async (fixtureId: string): Promise<void> => {
    setImplementationPlanState({ status: 'loading' });
    try {
      const response = await loadImplementationPlan(fixtureId);
      setImplementationPlanState(
        response.status === 'found'
          ? { status: 'ready', record: response.record }
          : { status: 'missing' },
      );
    } catch (error) {
      setImplementationPlanState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unexpected planning failure',
      });
    }
  };

  const refreshSelectedWorkflowContinuation = async (fixtureId: string): Promise<void> => {
    setWorkflowContinuationState({ status: 'loading' });
    setContinuationWorkflowState({ status: 'missing' });
    setContinuationActivityState(null);
    try {
      const response = await loadWorkflowContinuation(fixtureId);
      if (response.status === 'missing') {
        setWorkflowContinuationState({ status: 'missing' });
        return;
      }
      setWorkflowContinuationState({ status: 'ready', record: response.record });
      const candidateReference = continuationCandidateReference(response.record);
      if (candidateReference === null) return;
      const [candidate, activity] = await Promise.all([
        loadWorkflow(candidateReference),
        loadOperatorActivity(candidateReference)
          .then((loaded): ActivityLoadState => ({ status: 'ready', response: loaded }))
          .catch((error: unknown): ActivityLoadState => ({
            status: 'failed',
            message: error instanceof Error ? error.message : 'Candidate activity is unavailable',
          })),
      ]);
      setContinuationWorkflowState(
        candidate.status === 'found'
          ? { status: 'ready', response: candidate.response }
          : { status: 'missing' },
      );
      setContinuationActivityState(activity);
    } catch (error) {
      setWorkflowContinuationState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unexpected continuation failure',
      });
    }
  };

  const refreshSelectedJiraIssue = async (taskReference: string): Promise<void> => {
    if (!taskReference.startsWith('jira:')) {
      setJiraIssueState({ status: 'not_applicable' });
      return;
    }
    setJiraIssueState({ status: 'loading' });
    try {
      const state = await loadJiraIssue(taskReference.slice('jira:'.length));
      setJiraIssueState({ status: 'ready', state });
    } catch (error) {
      setJiraIssueState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unexpected Jira snapshot failure',
      });
    }
  };

  const refreshSelection = async (fixtureId: string): Promise<void> => {
    await Promise.all([
      refreshSelectedWorkflow(fixtureId),
      refreshSelectedActivity(fixtureId),
      refreshSelectedImplementationPlan(fixtureId),
      refreshSelectedWorkflowContinuation(fixtureId),
      refreshSelectedJiraIssue(fixtureId),
    ]);
  };

  useEffect(() => {
    let active = true;

    const initialize = async (): Promise<void> => {
      const [nextSelectedId, catalog] = await Promise.all([
        refreshTasks(),
        listRepositories().catch(() => [] as const),
      ]);
      if (active) setRepositories(catalog);
      if (!active || nextSelectedId === null) {
        return;
      }

      await refreshSelection(nextSelectedId);
    };

    void initialize();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (selectedId.length === 0) {
      return;
    }

    const source = connectOperatorStream(streamCursorRef.current, {
      onEvent: (event) => {
        void (async () => {
          const nextSelectedId = await refreshTasks();
          if (nextSelectedId === null) {
            return;
          }

          if (event.fixtureId === selectedIdRef.current) {
            await refreshSelection(event.fixtureId);
          }
        })();
      },
      onOpen: () => {
        setStreamStatus('live');
      },
      onError: (message) => {
        setStreamStatus((current) => (current === 'live' ? 'reconnecting' : current));
        setTasksMessage((currentMessage) => currentMessage ?? message);
      },
    });

    return () => {
      source.close();
      setStreamStatus('offline');
    };
  }, [selectedId.length]);

  const handleSelectTask = (taskId: string): void => {
    setSelectedId(taskId);
    void refreshSelection(taskId);
  };

  const handleJiraSync = (issueKeyInput: string, repository?: string): void => {
    const issueKey = issueKeyInput.trim().toUpperCase();
    if (issueKey.length === 0) return;
    setJiraSyncState({ status: 'syncing', issueKey });
    void syncJiraIssue(issueKey, repository)
      .then(async (state) => {
        const normalizedKey =
          state.status === 'unavailable' ? state.issueKey : state.issue.issueKey;
        const taskReference = `jira:${normalizedKey}`;
        await refreshTasks();
        setSelectedId(taskReference);
        await refreshSelection(taskReference);
        setJiraSyncState({ status: 'idle' });
      })
      .catch((error: unknown) => {
        setJiraSyncState({
          status: 'failed',
          message:
            error instanceof Error ? error.message : 'Unexpected Jira synchronization failure',
        });
      });
  };

  const handleGenerate = (): void => {
    if (
      selectedTask === null ||
      (selectedTask.status !== 'backlog' && selectedTask.status !== 'workflow_rejected') ||
      selectedTask.planning.status !== 'available'
    ) {
      return;
    }

    const taskReference = selectedTask.id;
    setPendingOperations((current) => new Map(current).set(taskReference, 'generating'));
    void generateWorkflow(taskReference)
      .then(async () => {
        const nextSelectedId = await refreshTasks();
        if (nextSelectedId !== null) {
          await refreshSelection(nextSelectedId);
        }
      })
      .catch((error: unknown) => {
        if (selectedIdRef.current === taskReference) {
          setWorkflowState({
            status: 'failed',
            message: error instanceof Error ? error.message : 'Unexpected generation failure',
          });
        }
      })
      .finally(() => {
        setPendingOperations((current) => {
          if (current.get(taskReference) !== 'generating') return current;
          const next = new Map(current);
          next.delete(taskReference);
          return next;
        });
      });
  };

  const handleStart = (): void => {
    if (selectedTask === null || selectedTask.status !== 'planned') return;
    const taskReference = selectedTask.id;
    const requirePlanApproval = planApprovalDrafts.get(taskReference) ?? true;
    const planningStrategy = planningStrategyDrafts.get(taskReference) ?? 'auto';
    setPendingOperations((current) => new Map(current).set(taskReference, 'starting'));
    void startWorkflow(taskReference, {
      settings: {
        planApproval: requirePlanApproval ? 'required' : 'automatic',
        planningStrategy,
      },
    })
      .then(async () => {
        await refreshTasks();
        if (selectedIdRef.current === taskReference) {
          await refreshSelection(taskReference);
        }
      })
      .catch((error: unknown) => {
        if (selectedIdRef.current === taskReference) {
          setActivityState({
            status: 'failed',
            message: error instanceof Error ? error.message : 'Unexpected run failure',
          });
        }
      })
      .finally(() => {
        setPendingOperations((current) => {
          if (current.get(taskReference) !== 'starting') return current;
          const next = new Map(current);
          next.delete(taskReference);
          return next;
        });
      });
  };

  const handlePlanReview = (decision: 'approve' | 'request_changes'): void => {
    if (selectedTask === null || selectedTask.status !== 'plan_review') return;
    const taskReference = selectedTask.id;
    const guidance = planGuidanceDrafts.get(taskReference)?.trim() ?? '';
    if (decision === 'request_changes' && guidance.length === 0) return;
    const operation =
      decision === 'approve' ? ('approving_plan' as const) : ('requesting_plan_changes' as const);
    setPendingOperations((current) => new Map(current).set(taskReference, operation));
    void reviewPlan(taskReference, decision === 'approve' ? { decision } : { decision, guidance })
      .then(async () => {
        if (decision === 'request_changes') {
          setPlanGuidanceDrafts((current) => {
            const next = new Map(current);
            next.delete(taskReference);
            return next;
          });
        }
        await refreshTasks();
        if (selectedIdRef.current === taskReference) {
          await refreshSelection(taskReference);
        }
      })
      .catch((error: unknown) => {
        if (selectedIdRef.current === taskReference) {
          setActivityState({
            status: 'failed',
            message: error instanceof Error ? error.message : 'Unexpected plan review failure',
          });
        }
      })
      .finally(() => {
        setPendingOperations((current) => {
          if (current.get(taskReference) !== operation) return current;
          const next = new Map(current);
          next.delete(taskReference);
          return next;
        });
      });
  };

  const handlePlanningClarification = (): void => {
    if (
      selectedTask === null ||
      implementationPlanState.status !== 'ready' ||
      implementationPlanState.record.status !== 'needs_clarification'
    ) {
      return;
    }
    const taskReference = selectedTask.id;
    const drafts = planningAnswerDrafts.get(taskReference) ?? new Map<string, string>();
    const answers = implementationPlanState.record.decision.questions.map((question) => ({
      questionId: question.id,
      answer: (drafts.get(question.id) ?? '').trim(),
    }));
    if (answers.some((answer) => answer.answer.length === 0)) return;

    setPendingOperations((current) => new Map(current).set(taskReference, 'answering_questions'));
    void answerPlanningClarification(taskReference, { answers })
      .then(async () => {
        setPlanningAnswerDrafts((current) => {
          const next = new Map(current);
          next.delete(taskReference);
          return next;
        });
        await refreshTasks();
        if (selectedIdRef.current === taskReference) {
          await refreshSelection(taskReference);
        }
      })
      .catch((error: unknown) => {
        if (selectedIdRef.current === taskReference) {
          setActivityState({
            status: 'failed',
            message: error instanceof Error ? error.message : 'Unexpected clarification failure',
          });
        }
      })
      .finally(() => {
        setPendingOperations((current) => {
          if (current.get(taskReference) !== 'answering_questions') return current;
          const next = new Map(current);
          next.delete(taskReference);
          return next;
        });
      });
  };

  const handleWorkflowContinuationReview = (decision: 'accept' | 'reject'): void => {
    if (selectedTask === null || workflowContinuationState.status !== 'ready') {
      return;
    }
    const record = workflowContinuationState.record;
    if (
      (decision === 'accept' &&
        record.status !== 'awaiting_review' &&
        record.status !== 'accepted') ||
      (decision === 'reject' &&
        record.status !== 'awaiting_review' &&
        record.status !== 'rejected_by_operator')
    ) {
      return;
    }
    const taskReference = selectedTask.id;
    const guidance =
      record.status === 'rejected_by_operator'
        ? record.guidance
        : (continuationGuidanceDrafts.get(taskReference)?.trim() ?? '');
    if (decision === 'reject' && guidance.length === 0) return;
    const operation =
      decision === 'accept'
        ? ('accepting_continuation' as const)
        : ('rejecting_continuation' as const);
    setPendingOperations((current) => new Map(current).set(taskReference, operation));
    void reviewWorkflowContinuation(
      taskReference,
      decision === 'accept'
        ? { decision, continuationId: record.continuationId }
        : { decision, continuationId: record.continuationId, guidance },
    )
      .then(async () => {
        if (decision === 'reject') {
          setContinuationGuidanceDrafts((current) => {
            const next = new Map(current);
            next.delete(taskReference);
            return next;
          });
        }
        await refreshTasks();
        if (selectedIdRef.current === taskReference) await refreshSelection(taskReference);
      })
      .catch((error: unknown) => {
        if (selectedIdRef.current === taskReference) {
          setActivityState({
            status: 'failed',
            message:
              error instanceof Error ? error.message : 'Unexpected continuation review failure',
          });
        }
      })
      .finally(() => {
        setPendingOperations((current) => {
          if (current.get(taskReference) !== operation) return current;
          const next = new Map(current);
          next.delete(taskReference);
          return next;
        });
      });
  };

  const handleWorkflowContinuationRetry = (): void => {
    if (selectedTask === null || workflowContinuationState.status !== 'ready') return;
    const taskReference = selectedTask.id;
    setPendingOperations((current) => new Map(current).set(taskReference, 'retrying_continuation'));
    void retryWorkflowContinuation(taskReference)
      .then(async () => {
        await refreshTasks();
        if (selectedIdRef.current === taskReference) await refreshSelection(taskReference);
      })
      .catch((error: unknown) => {
        if (selectedIdRef.current === taskReference) {
          setActivityState({
            status: 'failed',
            message:
              error instanceof Error ? error.message : 'Unexpected continuation retry failure',
          });
        }
      })
      .finally(() => {
        setPendingOperations((current) => {
          if (current.get(taskReference) !== 'retrying_continuation') return current;
          const next = new Map(current);
          next.delete(taskReference);
          return next;
        });
      });
  };

  const displayedWorkflowState =
    continuationWorkflowState.status === 'ready' ? continuationWorkflowState : workflowState;
  const view =
    displayedWorkflowState.status === 'ready' ? displayedWorkflowState.response.view : null;

  return (
    <TooltipProvider>
      <div className="flex h-dvh min-w-[1080px] flex-col bg-background text-foreground">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2.5">
            <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Circle className="size-3.5 fill-current" />
            </div>
            <strong className="text-sm tracking-tight">Tasker</strong>
            <span className="text-xs text-muted-foreground">Operator</span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  tasksStatus === 'ready' ? 'bg-emerald-400' : 'bg-amber-400',
                )}
              />
              Ledger
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  streamStatus === 'live' ? 'bg-emerald-400' : 'bg-amber-400',
                )}
              />
              SSE
            </span>
            <StateBadge>Execution</StateBadge>
          </div>
        </header>

        {tasksStatus === 'failed' ? (
          <InlineError>{tasksMessage ?? 'The task queue could not be loaded'}</InlineError>
        ) : null}

        <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_340px]">
          <TaskQueue
            tasks={tasks}
            repositories={repositories}
            selectedId={selectedId}
            onSelect={handleSelectTask}
            onImportJira={handleJiraSync}
            jiraSync={jiraSyncState}
            liveStatus={streamStatus}
          />

          <main className="flex min-h-0 flex-col border-r border-border">
            {selectedTask === null ? (
              <EmptyState>
                {tasksStatus === 'loading' ? 'Loading tasks…' : 'Select a task'}
              </EmptyState>
            ) : (
              <>
                <SelectedTaskHeader
                  task={selectedTask}
                  workflow={workflowState}
                  activity={activityState}
                  onGenerate={handleGenerate}
                  onStart={handleStart}
                  requirePlanApproval={planApprovalDrafts.get(selectedTask.id) ?? true}
                  onRequirePlanApprovalChange={(required) => {
                    setPlanApprovalDrafts((current) =>
                      new Map(current).set(selectedTask.id, required),
                    );
                  }}
                  planningStrategy={planningStrategyDrafts.get(selectedTask.id) ?? 'auto'}
                  onPlanningStrategyChange={(strategy) => {
                    setPlanningStrategyDrafts((current) =>
                      new Map(current).set(selectedTask.id, strategy),
                    );
                  }}
                  onSyncJira={handleJiraSync}
                  pendingOperation={pendingOperations.get(selectedTask.id) ?? null}
                  jiraSync={jiraSyncState}
                />
                {selectedTask.status === 'plan_review' ? (
                  <PlanReviewControls
                    guidance={planGuidanceDrafts.get(selectedTask.id) ?? ''}
                    pendingOperation={pendingOperations.get(selectedTask.id) ?? null}
                    onGuidanceChange={(guidance) => {
                      setPlanGuidanceDrafts((current) =>
                        new Map(current).set(selectedTask.id, guidance),
                      );
                    }}
                    onApprove={() => {
                      handlePlanReview('approve');
                    }}
                    onRequestChanges={() => {
                      handlePlanReview('request_changes');
                    }}
                  />
                ) : null}
                {view === null ? null : <ValidationSurface task={selectedTask} view={view} />}
                <JiraPlanningSurface task={selectedTask} />
                <WorkflowContinuationSurface
                  continuation={workflowContinuationState}
                  planning={implementationPlanState}
                  candidateActivity={continuationActivityState}
                  guidance={continuationGuidanceDrafts.get(selectedTask.id) ?? ''}
                  pendingOperation={pendingOperations.get(selectedTask.id) ?? null}
                  onGuidanceChange={(guidance) => {
                    setContinuationGuidanceDrafts((current) =>
                      new Map(current).set(selectedTask.id, guidance),
                    );
                  }}
                  onAccept={() => {
                    handleWorkflowContinuationReview('accept');
                  }}
                  onReject={() => {
                    handleWorkflowContinuationReview('reject');
                  }}
                  onRevise={() => {
                    handleWorkflowContinuationReview('reject');
                  }}
                  onRetry={handleWorkflowContinuationRetry}
                />
                <ScrollArea className="min-h-0 flex-1">
                  <ActivityTimeline activity={activityState} streamStatus={streamStatus} />
                  <ImplementationPlanSurface
                    planning={implementationPlanState}
                    answers={planningAnswerDrafts.get(selectedTask.id) ?? new Map()}
                    pending={pendingOperations.get(selectedTask.id) === 'answering_questions'}
                    onAnswerChange={(questionId, answer) => {
                      setPlanningAnswerDrafts((current) => {
                        const taskAnswers = new Map(current.get(selectedTask.id) ?? []);
                        taskAnswers.set(questionId, answer);
                        return new Map(current).set(selectedTask.id, taskAnswers);
                      });
                    }}
                    onSubmitAnswers={handlePlanningClarification}
                  />
                  <TaskDetails
                    details={jiraIssueState}
                    onRetry={handleJiraSync}
                    syncing={jiraSyncState.status === 'syncing'}
                  />
                  {view === null ? null : (
                    <>
                      <WhyThisWorkflow view={view} />
                      <WorkflowDiagnostics view={view} />
                    </>
                  )}
                </ScrollArea>
              </>
            )}
          </main>

          <WorkflowSidebar workflow={displayedWorkflowState} task={selectedTask} />
        </div>
      </div>
    </TooltipProvider>
  );
};
