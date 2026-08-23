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
  Maximize2,
  MessageSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Sun,
  Terminal,
  Video,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type {
  OperatorInterventionAction,
  OperatorActivityResponse,
  OperatorExecutionAttempt,
  OperatorRunLogResponse,
  OperatorTaskSummary,
  OperatorWorkflowContinuation,
  OperatorWorkflowProjection,
  OperatorWorkflowStep,
  WorkflowResponse,
  WorkflowView,
} from '../control-plane/operator-contracts.js';
import type { ImplementationPlanningRecord } from '../control-plane/implementation-planning-contracts.js';
import type { PlanningTranscriptView } from '../control-plane/planning-transcript.js';
import {
  PlanReviewAnnotationSchema,
  type PlanReviewAnnotation,
  type PlanReviewRound,
} from '../control-plane/plan-review.js';
import type { JiraIssueState, JiraIssueSnapshot } from '../integrations/jira/contracts.js';
import type { PlanningStrategyRequest } from '../planning/implementation-plan.js';
import type { RepositoryCatalogEntry } from '../repositories/contracts.js';
import {
  answerPlanningClarification,
  completeCodeReview,
  connectOperatorStream,
  generateWorkflow,
  graphDownloadUrl,
  jiraAttachmentUrl,
  listOperatorTasks,
  listRepositories,
  loadImplementationPlan,
  loadPlanningTranscript,
  loadPlanReviewHistory,
  loadJiraIssue,
  loadOperatorActivity,
  loadOperatorExecutionAttempt,
  loadOperatorRunLog,
  loadOperatorWorkflowProjection,
  loadWorkflow,
  reviewPlan,
  reviewWorkflowChange,
  restartWorkflow,
  resumeWorkflow,
  syncCodeReview,
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
import { MarkdownText } from './MarkdownText.js';
import {
  planningAgentLogFrom,
  planningAgentLogFromRaw,
  type PlanningAgentEvent,
} from './planning-agent-log.js';
import { implementationPlanMarkdownFrom } from './implementation-plan-markdown.js';
import { WorkflowStages } from './WorkflowStages.js';

type WorkflowLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'missing' }
  | { readonly status: 'ready'; readonly response: WorkflowResponse }
  | { readonly status: 'failed'; readonly message: string };

type ActivityLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly response: OperatorActivityResponse }
  | { readonly status: 'failed'; readonly message: string };

type OperatorProjectionLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly projection: OperatorWorkflowProjection }
  | { readonly status: 'failed'; readonly message: string };

type ExecutionAttemptLoadState =
  | { readonly status: 'missing' }
  | { readonly status: 'loading'; readonly nodeId: string; readonly blockRun: number }
  | { readonly status: 'ready'; readonly attempt: OperatorExecutionAttempt }
  | { readonly status: 'failed'; readonly message: string };

type RunLogLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'missing' }
  | { readonly status: 'ready'; readonly response: OperatorRunLogResponse }
  | { readonly status: 'failed'; readonly message: string };

type ImplementationPlanLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'missing' }
  | { readonly status: 'ready'; readonly record: ImplementationPlanningRecord }
  | { readonly status: 'failed'; readonly message: string };

type PlanningTranscriptLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'missing' }
  | { readonly status: 'ready'; readonly transcript: PlanningTranscriptView }
  | { readonly status: 'failed'; readonly message: string };

type PlanReviewHistoryLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly rounds: readonly PlanReviewRound[] }
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
  | 'approving_plan'
  | 'requesting_plan_changes'
  | 'syncing_review'
  | 'completing_review'
  | 'answering_questions'
  | 'resuming'
  | 'restarting'
  | 'accepting_continuation'
  | 'rejecting_continuation';

const STORAGE_KEY = 'tasker.operator.selectedTaskId';
const TASK_RAIL_STORAGE_KEY = 'tasker.operator.tasksCollapsed';
const THEME_STORAGE_KEY = 'tasker.operator.theme';
const PLAN_ANNOTATION_STORAGE_KEY = 'tasker.operator.planAnnotations';
type OperatorTheme = 'light' | 'dark';

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
  if (session.status === 'not_started') return 'no provider session';

  const seconds = Math.max(0.1, session.durationMs / 1000).toFixed(1);
  const measuredTokens = session.usage.inputTokens + session.usage.outputTokens;
  const provider = session.provider === 'codex_cli' ? 'Codex' : 'Claude';
  const cost =
    session.apiCost.source === 'unrated'
      ? 'API cost unrated'
      : `$${session.apiCost.amountUsd.toFixed(2)} API equivalent`;
  return `${session.profile} · ${provider} · ${session.model}/${session.effort} · ${seconds}s · ${measuredTokens.toLocaleString()} tok · ${cost}`;
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

const readStoredTaskRailCollapsed = (): boolean =>
  typeof window !== 'undefined' && window.localStorage.getItem(TASK_RAIL_STORAGE_KEY) === 'true';

const writeStoredTaskRailCollapsed = (collapsed: boolean): void => {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(TASK_RAIL_STORAGE_KEY, String(collapsed));
  }
};

const readStoredTheme = (): OperatorTheme => {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
};

const applyTheme = (theme: OperatorTheme): void => {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  window.localStorage.setItem(THEME_STORAGE_KEY, theme);
};

const readStoredPlanAnnotations = (): ReadonlyMap<string, readonly PlanReviewAnnotation[]> => {
  if (typeof window === 'undefined') return new Map();
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(PLAN_ANNOTATION_STORAGE_KEY) ?? '{}',
    );
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Map();
    return new Map(
      Object.entries(parsed).flatMap(([artifactId, annotations]) => {
        const result = PlanReviewAnnotationSchema.array().safeParse(annotations);
        return result.success ? [[artifactId, result.data] as const] : [];
      }),
    );
  } catch {
    return new Map();
  }
};

const writeStoredPlanAnnotations = (
  annotations: ReadonlyMap<string, readonly PlanReviewAnnotation[]>,
): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(
    PLAN_ANNOTATION_STORAGE_KEY,
    JSON.stringify(Object.fromEntries(annotations)),
  );
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
      return 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300';
    case 'failed':
    case 'workflow_rejected':
      return 'bg-destructive/15 text-destructive';
    case 'needs_attention':
    case 'plan_review':
    case 'waiting':
      return 'bg-amber-500/12 text-amber-700 dark:text-amber-300';
    case 'running':
      return 'bg-blue-500/12 text-blue-700 dark:text-blue-300';
    case 'code_review':
      return 'bg-violet-500/12 text-violet-700 dark:text-violet-300';
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
                        <AlertTriangle
                          className="size-3 text-amber-600 dark:text-amber-400"
                          aria-label="needs input"
                        />
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
  readonly requirePlanApproval: boolean;
  readonly onRequirePlanApprovalChange: (required: boolean) => void;
  readonly planningStrategy: PlanningStrategyRequest;
  readonly onPlanningStrategyChange: (strategy: PlanningStrategyRequest) => void;
  readonly onSyncJira: (issueKey: string) => void;
  readonly pendingOperation: TaskOperation | null;
  readonly jiraSync: JiraSyncState;
}) => {
  const generating = pendingOperation === 'generating';
  const canGenerate =
    (task.status === 'backlog' || task.status === 'workflow_rejected') &&
    task.planning.status === 'available';

  return (
    <section className="border-b border-border px-5 py-3.5" data-testid="selected-task">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-xs font-medium text-muted-foreground">
              {task.taskId}
            </span>
            <span className="shrink-0 text-muted-foreground/50">·</span>
            <StateBadge className={statusTone(task.status)}>{statusLabel(task.status)}</StateBadge>
            <span
              className="min-w-0 truncate text-xs text-muted-foreground"
              title={task.currentStage}
            >
              {task.currentStage}
            </span>
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
        <div className="flex shrink-0 items-center gap-1.5">
          {canGenerate ? (
            <>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="sr-only">Planning strategy</span>
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:border-ring"
                  aria-label="Planning strategy"
                  value={planningStrategy}
                  disabled={generating}
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
                  disabled={generating}
                  onChange={(event) => {
                    onRequirePlanApprovalChange(event.target.checked);
                  }}
                />
                Review plan
              </label>
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
            </>
          ) : null}
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
              title={
                task.status === 'backlog' || task.status === 'workflow_rejected'
                  ? 'Reload Jira fields, comments, links, and attachments before the next plan.'
                  : 'Refresh the operator snapshot. A frozen execution keeps its original context.'
              }
            >
              <RefreshCw
                data-icon="inline-start"
                className={jiraSync.status === 'syncing' ? 'animate-spin' : undefined}
              />
              Refresh Jira
            </Button>
          </>
        </div>
      </div>
      {workflow.status === 'failed' ? <InlineError>{workflow.message}</InlineError> : null}
    </section>
  );
};

type PlanReviewActions = {
  readonly guidance: string;
  readonly annotationCount: number;
  readonly pendingOperation: TaskOperation | null;
  readonly onGuidanceChange: (guidance: string) => void;
  readonly onApprove: () => void;
  readonly onRequestChanges: () => void;
};

const PlanReviewActions = ({
  guidance,
  annotationCount,
  pendingOperation,
  onGuidanceChange,
  onApprove,
  onRequestChanges,
}: PlanReviewActions) => {
  const approving = pendingOperation === 'approving_plan';
  const requestingChanges = pendingOperation === 'requesting_plan_changes';
  const busy = approving || requestingChanges;
  const hasFeedback = guidance.trim().length > 0 || annotationCount > 0;

  return (
    <footer
      className="relative z-[60] shrink-0 border-t-2 border-amber-500/70 bg-amber-500/10 px-5 py-3 shadow-[0_-18px_48px_-32px_rgba(245,158,11,0.9)] backdrop-blur"
      aria-label="Plan decision"
      data-testid="plan-review-actions"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex gap-2.5">
          <div className="mt-0.5 shrink-0 rounded-md bg-amber-500/20 p-1.5 text-amber-700 dark:text-amber-300">
            <AlertTriangle className="size-4 shrink-0" />
          </div>
          <div>
            <strong className="text-sm text-amber-800 dark:text-amber-200">Action required</strong>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Approve this exact plan, or describe what the planner must change.
            </p>
          </div>
        </div>
      </div>
      <textarea
        className="mt-2 min-h-16 w-full resize-y rounded-md border border-input bg-background/70 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
        aria-label="Plan review guidance"
        placeholder="What should the agent change in the plan?"
        value={guidance}
        disabled={busy}
        onChange={(event) => {
          onGuidanceChange(event.target.value);
        }}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          type="button"
          className="border-amber-500/50 bg-background/70 hover:bg-amber-500/10"
          disabled={busy || !hasFeedback}
          onClick={onRequestChanges}
        >
          {requestingChanges ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <MessageSquare data-icon="inline-start" />
          )}
          {requestingChanges ? 'Sending…' : 'Request changes'}
        </Button>
        <Button
          size="sm"
          type="button"
          className="bg-amber-500 text-amber-950 hover:bg-amber-400"
          disabled={busy || hasFeedback}
          onClick={onApprove}
          title={hasFeedback ? 'Clear or submit the review comments before approving.' : undefined}
        >
          {approving ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
          {approving ? 'Approving…' : 'Approve plan'}
        </Button>
      </div>
    </footer>
  );
};

const CodeReviewControls = ({
  pendingOperation,
  notice,
  onSync,
  onComplete,
}: {
  readonly pendingOperation: TaskOperation | null;
  readonly notice: string | null;
  readonly onSync: () => void;
  readonly onComplete: () => void;
}) => {
  const syncing = pendingOperation === 'syncing_review';
  const completing = pendingOperation === 'completing_review';
  const busy = syncing || completing;
  return (
    <section className="border-b border-violet-500/20 bg-violet-500/4 px-5 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <strong className="text-sm">Code review</strong>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Import actionable PR threads, or finish when review needs no revision.
          </p>
          {notice === null ? null : (
            <p className="mt-1 text-xs text-violet-700 dark:text-violet-300">{notice}</p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" type="button" disabled={busy} onClick={onSync}>
            {syncing ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            {syncing ? 'Syncing…' : 'Sync review'}
          </Button>
          <Button size="sm" type="button" disabled={busy} onClick={onComplete}>
            {completing ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : (
              <CheckCircle2 data-icon="inline-start" />
            )}
            {completing ? 'Finishing…' : 'Mark done'}
          </Button>
        </div>
      </div>
    </section>
  );
};

type ResumableInterventionAction = Exclude<
  OperatorInterventionAction,
  { readonly kind: 'typed_resolution' }
>;

export const OperatorIntervention = ({
  action,
  stage,
  guidance,
  pending,
  restartConfirming,
  onGuidanceChange,
  onResume,
  onRestartRequest,
  onRestartCancel,
  onRestartConfirm,
}: {
  readonly action: ResumableInterventionAction;
  readonly stage: string;
  readonly guidance: string;
  readonly pending: boolean;
  readonly restartConfirming: boolean;
  readonly onGuidanceChange: (guidance: string) => void;
  readonly onResume: () => void;
  readonly onRestartRequest: () => void;
  readonly onRestartCancel: () => void;
  readonly onRestartConfirm: () => void;
}) => {
  const acceptsGuidance = action.kind === 'operator_guidance';
  return (
    <section className="border-b border-amber-500/20 bg-amber-500/4 px-5 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <strong className="text-sm">
            {acceptsGuidance ? 'Guidance required' : 'Prerequisite required'}
          </strong>
          <p className="mt-1 max-w-4xl text-sm leading-5 text-foreground/90">{stage}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {acceptsGuidance
              ? 'Tell the agent what changed or how to approach the same step. Completed work will not repeat.'
              : 'Resolve this requirement in its owning system, then resume the same step. This step does not read free-form guidance.'}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={pending}
            onClick={onRestartRequest}
          >
            <RotateCcw data-icon="inline-start" />
            Restart from scratch
          </Button>
          <Button size="sm" type="button" disabled={pending} onClick={onResume}>
            {pending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
            {pending ? 'Working…' : 'Resume'}
          </Button>
        </div>
      </div>
      {acceptsGuidance ? (
        <textarea
          className="mt-2 min-h-16 w-full resize-y rounded-md border border-input bg-background/60 px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
          aria-label="Operator guidance"
          placeholder="What changed, or what should the agent do differently?"
          value={guidance}
          disabled={pending}
          onChange={(event) => {
            onGuidanceChange(event.target.value);
          }}
        />
      ) : null}
      {restartConfirming ? (
        <div className="mt-3 flex items-center justify-between gap-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          <div>
            <strong className="text-sm text-destructive">Abandon this run?</strong>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Tasker will preserve its Temporal history, terminate unfinished work, and create a new
              workspace from the current harness.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={pending}
              onClick={onRestartCancel}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              type="button"
              disabled={pending}
              onClick={onRestartConfirm}
            >
              {pending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
              {pending ? 'Restarting…' : 'Confirm restart'}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
};

const ValidationSurface = ({ view }: { readonly view: WorkflowView }) => {
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
          <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
        )}
        <strong>{blocked ? 'Workflow graph rejected' : 'Workflow graph valid'}</strong>
        <span className="text-xs text-muted-foreground">
          {issues.length > 0
            ? `${String(issues.length)} validation ${issues.length === 1 ? 'issue' : 'issues'}`
            : `Verification profile · ${view.workflow.verificationPlan.profile.replaceAll('_', ' ')}`}
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
  if (task.planning.status !== 'blocked') return null;
  const binding = task.origin.repositoryBinding;
  const repositoryResolved = binding.status === 'resolved';

  return (
    <section
      className="border-b border-border bg-amber-500/4 px-5 py-2.5"
      aria-label="Jira planning status"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <strong>{repositoryResolved ? 'Repository mapped' : 'Workflow planning paused'}</strong>
        <span className="truncate text-xs text-muted-foreground">{task.planning.reason}</span>
      </div>
    </section>
  );
};

const PlanningSnapshotTag = ({ record }: { readonly record: ImplementationPlanningRecord }) => {
  const reference = record.planningSnapshot;
  if (reference === null) return null;
  return (
    <span
      className="font-mono text-[10px] text-muted-foreground"
      data-testid="planning-snapshot-reference"
      title={`${reference.artifactId}\n${reference.checksum}`}
    >
      snapshot {reference.checksum.slice(0, 8)}
    </span>
  );
};

type SelectedPlanRange = {
  readonly quote: string;
  readonly startOffset: number;
  readonly endOffset: number;
};

const selectionOffset = (root: HTMLElement, node: Node, offset: number): number => {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
};

const selectedPlanRangeFrom = (
  root: HTMLElement,
  selected: Selection | null,
): SelectedPlanRange | null => {
  if (selected === null || selected.rangeCount !== 1 || selected.isCollapsed) return null;
  const range = selected.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const selectedText = selected.toString();
  const quote = selectedText.trim();
  if (quote.length === 0 || quote.length > 2_000) return null;
  const leadingWhitespace = selectedText.length - selectedText.trimStart().length;
  const rawStartOffset = selectionOffset(root, range.startContainer, range.startOffset);
  return {
    quote,
    startOffset: rawStartOffset + leadingWhitespace,
    endOffset: rawStartOffset + leadingWhitespace + quote.length,
  };
};

const NativePlanReview = ({
  artifactId,
  title,
  markdown,
  metadata,
  annotations,
  history,
  decisionActions,
  onAnnotationsChange,
}: {
  readonly artifactId: string;
  readonly title: string;
  readonly markdown: string;
  readonly metadata: ReactNode;
  readonly annotations: readonly PlanReviewAnnotation[];
  readonly history: readonly PlanReviewRound[];
  readonly decisionActions: ReactNode;
  readonly onAnnotationsChange: (annotations: readonly PlanReviewAnnotation[]) => void;
}) => {
  const [fullscreen, setFullscreen] = useState(false);
  const [selection, setSelection] = useState<SelectedPlanRange | null>(null);
  const [comment, setComment] = useState('');
  const documentRef = useRef<HTMLDivElement>(null);
  const documentScrollRef = useRef<HTMLDivElement>(null);

  const captureSelection = useCallback((): void => {
    const root = documentRef.current;
    if (root === null) return;
    const selectedRange = selectedPlanRangeFrom(root, window.getSelection());
    if (selectedRange !== null) setSelection(selectedRange);
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    documentScrollRef.current?.scrollTo({ top: 0 });
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [fullscreen]);

  useEffect(() => {
    const captureCurrentSelection = (): void => {
      captureSelection();
    };
    document.addEventListener('selectionchange', captureCurrentSelection);
    return () => {
      document.removeEventListener('selectionchange', captureCurrentSelection);
    };
  }, [captureSelection]);

  const addAnnotation = (): void => {
    if (selection === null || comment.trim().length === 0) return;
    onAnnotationsChange([
      ...annotations,
      {
        id: crypto.randomUUID(),
        anchor: artifactId,
        quote: selection.quote,
        startOffset: selection.startOffset,
        endOffset: selection.endOffset,
        comment: comment.trim(),
      },
    ]);
    setSelection(null);
    setComment('');
    window.getSelection()?.removeAllRanges();
  };

  const content = (
    <section
      className={cn(
        'overflow-hidden border border-amber-500/50 bg-card shadow-[0_18px_58px_-36px_rgba(245,158,11,0.85)]',
        fullscreen
          ? 'mx-auto flex h-full min-h-0 w-full max-w-[1800px] flex-col rounded-xl shadow-2xl'
          : 'mx-4 my-4 rounded-lg',
      )}
      aria-label="Review implementation plan"
      data-testid="plan-review-surface"
    >
      <header className="flex items-start gap-3 border-b border-amber-500/30 bg-amber-500/10 px-5 py-4 lg:px-7">
        <div className="mt-0.5 shrink-0 rounded-md bg-amber-500/20 p-2 text-amber-700 dark:text-amber-300">
          <AlertTriangle className="size-4 shrink-0" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            Action required · review plan
          </p>
          <h2 className="mt-0.5 text-lg font-semibold leading-6">{title}</h2>
          <div className="mt-2">{metadata}</div>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label={fullscreen ? 'Close full screen plan' : 'Open plan full screen'}
                onClick={() => {
                  setFullscreen((open) => !open);
                }}
              />
            }
          >
            {fullscreen ? <X className="size-4" /> : <Maximize2 className="size-4" />}
          </TooltipTrigger>
          <TooltipContent>{fullscreen ? 'Close full screen' : 'Review full screen'}</TooltipContent>
        </Tooltip>
      </header>
      <div
        className={cn(
          'grid min-h-0 overflow-hidden',
          fullscreen && 'flex-1',
          fullscreen || annotations.length > 0 || selection !== null
            ? 'grid-cols-[minmax(0,1fr)_320px]'
            : 'grid-cols-1',
        )}
      >
        <div className="flex min-h-0 min-w-0 flex-col">
          <div
            className={cn(
              'min-h-0 min-w-0 flex-1 bg-muted/10',
              fullscreen ? 'overflow-y-auto' : 'overflow-visible',
            )}
            data-testid="implementation-plan"
            {...(fullscreen ? { 'data-plan-scroll-region': '' } : {})}
            ref={documentScrollRef}
          >
            <div
              className="mx-auto w-full max-w-6xl px-7 py-8 selection:bg-amber-300/40 lg:px-10 lg:py-10 dark:selection:bg-amber-500/35"
              data-plan-anchor={artifactId}
              onMouseUp={captureSelection}
              ref={documentRef}
            >
              <MarkdownText className="text-[15px] leading-7 text-foreground/80">
                {markdown}
              </MarkdownText>
            </div>
          </div>
          {decisionActions}
        </div>
        {fullscreen || annotations.length > 0 || selection !== null ? (
          <aside
            className="min-h-0 overflow-y-auto border-l border-border bg-muted/15 p-4"
            aria-label="Plan annotations"
          >
            <div className="flex items-center justify-between gap-2">
              <strong className="text-sm">Annotations</strong>
              <StateBadge>{String(annotations.length)}</StateBadge>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Select text in the plan, then explain what should change.
            </p>
            {selection === null ? null : (
              <div className="mt-4 rounded-md border border-amber-500/35 bg-amber-500/8 p-3">
                <blockquote className="line-clamp-4 border-l-2 border-amber-500/60 pl-2 text-xs text-muted-foreground">
                  {selection.quote}
                </blockquote>
                <textarea
                  className="mt-3 min-h-20 w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-xs outline-none focus:border-ring"
                  aria-label="Annotation comment"
                  placeholder="What should change here?"
                  value={comment}
                  onChange={(event) => {
                    setComment(event.target.value);
                  }}
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => {
                      setSelection(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    disabled={comment.trim().length === 0}
                    onClick={() => {
                      addAnnotation();
                    }}
                  >
                    Add annotation
                  </Button>
                </div>
              </div>
            )}
            {annotations.length === 0 ? null : (
              <ol className="mt-4 space-y-3" data-testid="plan-annotation-list">
                {annotations.map((annotation, index) => (
                  <li
                    className="rounded-md border border-border bg-background/70 p-3"
                    key={annotation.id}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Comment {index + 1}
                      </span>
                      <button
                        className="text-muted-foreground hover:text-destructive"
                        type="button"
                        aria-label={`Remove annotation ${String(index + 1)}`}
                        onClick={() => {
                          onAnnotationsChange(annotations.filter(({ id }) => id !== annotation.id));
                        }}
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                    <blockquote className="mt-2 line-clamp-3 border-l-2 border-border pl-2 text-xs text-muted-foreground">
                      {annotation.quote}
                    </blockquote>
                    <p className="mt-2 text-xs leading-5">{annotation.comment}</p>
                  </li>
                ))}
              </ol>
            )}
            {history.length === 0 ? null : (
              <details className="mt-4 border-t border-border pt-3 text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  Previous review rounds · {history.length}
                </summary>
                <ol className="mt-2 space-y-2">
                  {history.map((round) => (
                    <li className="rounded-md bg-muted/40 p-2" key={round.reviewId}>
                      <div className="flex justify-between gap-2">
                        <span>Attempt {round.planAttempt}</span>
                        <StateBadge>{round.decision.replace('_', ' ')}</StateBadge>
                      </div>
                      <p className="mt-1 text-muted-foreground">
                        {round.annotations.length} annotations ·{' '}
                        {formatShortDateTime(round.submittedAt)}
                      </p>
                      {round.guidance === null ? null : (
                        <p className="mt-2 leading-5">{round.guidance}</p>
                      )}
                      {round.annotations.length === 0 ? null : (
                        <ol className="mt-2 space-y-2">
                          {round.annotations.map((annotation, index) => (
                            <li className="border-l-2 border-border pl-2" key={annotation.id}>
                              <p className="line-clamp-2 text-muted-foreground">
                                {annotation.quote}
                              </p>
                              <p className="mt-1 leading-5">
                                {String(index + 1)}. {annotation.comment}
                              </p>
                            </li>
                          ))}
                        </ol>
                      )}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </aside>
        ) : null}
      </div>
    </section>
  );

  return fullscreen ? (
    <div
      className="fixed inset-0 z-50 bg-background/90 p-3 backdrop-blur-md lg:p-6"
      role="dialog"
      aria-modal="true"
    >
      {content}
    </div>
  ) : (
    content
  );
};

const ImplementationPlanSurface = ({
  planning,
  answers,
  pending,
  reviewMode = false,
  annotations = [],
  history = [],
  reviewActions = null,
  onAnnotationsChange,
  onAnswerChange,
  onSubmitAnswers,
}: {
  readonly planning: ImplementationPlanLoadState;
  readonly answers: ReadonlyMap<string, string>;
  readonly pending: boolean;
  readonly reviewMode?: boolean;
  readonly annotations?: readonly PlanReviewAnnotation[];
  readonly history?: readonly PlanReviewRound[];
  readonly reviewActions?: ReactNode;
  readonly onAnnotationsChange?: (annotations: readonly PlanReviewAnnotation[]) => void;
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
          <PlanningSnapshotTag record={record} />
        </div>
      </section>
    );
  }
  if (record.status === 'failed') {
    return (
      <section className="border-b border-border px-5 py-4" aria-label="Implementation plan">
        <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="size-4" />
          <strong>Planning paused</strong>
          <span className="text-xs text-muted-foreground">{record.failure.message}</span>
          <PlanningSnapshotTag record={record} />
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
          <MessageSquare className="size-4 text-amber-700 dark:text-amber-300" />
          <strong>Planner needs clarification</strong>
          <PlanningSnapshotTag record={record} />
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
  if (record.status === 'investigation_required') {
    return (
      <section className="border-b border-border px-5 py-4" aria-label="Implementation plan">
        <div className="flex items-center gap-2 text-sm">
          <LoaderCircle className="size-4 animate-spin text-primary" />
          <strong>Pre-plan investigation</strong>
          <StateBadge>{record.selectedStrategy}</StateBadge>
          <PlanningSnapshotTag record={record} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{record.decision.request.reason}</p>
      </section>
    );
  }
  const plan = record.decision.plan;
  const measuredTokens = record.receipt.usage.inputTokens + record.receipt.usage.outputTokens;
  const apiCost =
    record.receipt.apiCost.source === 'unrated'
      ? 'API cost unrated'
      : `~$${record.receipt.apiCost.amountUsd.toFixed(2)} API`;
  const metadata = (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      <StateBadge>{record.selectedStrategy}</StateBadge>
      <PlanningSnapshotTag record={record} />
      <span>
        attempt {record.attempt} · {record.receipt.provider} ·{' '}
        {(record.receipt.durationMs / 1000).toFixed(1)}s · {measuredTokens.toLocaleString()} tok ·{' '}
        {apiCost}
      </span>
    </div>
  );
  const markdown = implementationPlanMarkdownFrom({
    plan,
    strategy: record.selectedStrategy,
    selectionReason: record.selectionReason,
  });
  const document = (
    <div className="px-5 py-5" data-plan-anchor={record.artifactId}>
      <MarkdownText className="max-w-4xl text-sm text-muted-foreground">{markdown}</MarkdownText>
    </div>
  );

  if (reviewMode) {
    return (
      <NativePlanReview
        artifactId={record.artifactId}
        title={plan.title}
        markdown={markdown}
        metadata={metadata}
        annotations={annotations}
        history={history}
        decisionActions={reviewActions}
        onAnnotationsChange={onAnnotationsChange ?? (() => undefined)}
      />
    );
  }

  return (
    <Collapsible defaultOpen>
      <section
        className="border-y border-border bg-muted/5"
        aria-label="Implementation plan"
        data-testid="implementation-plan"
      >
        <CollapsibleTrigger className="group flex w-full items-center justify-between bg-muted/10 px-5 py-3 text-left hover:bg-muted/30">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <GitBranch className="size-4 text-muted-foreground" />
              <strong className="text-sm">Implementation plan</strong>
              {metadata}
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">{plan.title}</p>
          </div>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-border/60">{document}</CollapsibleContent>
      </section>
    </Collapsible>
  );
};

const WorkflowContinuationSurface = ({
  continuation,
  guidance,
  pendingOperation,
  onGuidanceChange,
  onAccept,
  onReject,
}: {
  readonly continuation: OperatorWorkflowContinuation | null;
  readonly guidance: string;
  readonly pendingOperation: TaskOperation | null;
  readonly onGuidanceChange: (guidance: string) => void;
  readonly onAccept: () => void;
  readonly onReject: () => void;
}) => {
  if (continuation === null || continuation.status !== 'awaiting_review') return null;
  const busy =
    pendingOperation === 'accepting_continuation' || pendingOperation === 'rejecting_continuation';

  return (
    <section
      className="border-b border-amber-500/20 bg-amber-500/4 px-5 py-3"
      aria-label="Workflow continuation"
      data-testid="workflow-continuation-review"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GitBranch className="size-4 text-amber-700 dark:text-amber-300" />
            <strong className="text-sm">Workflow change proposed</strong>
            <span className="text-[11px] text-muted-foreground">
              attempt {continuation.attempt}
            </span>
          </div>
          <p className="mt-1 max-w-4xl text-sm leading-5 text-foreground/90">
            {continuation.reason}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            The proposed stages are visible in the workflow rail. Accept to execute them in this
            same run and workspace, or describe what must change.
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {continuation.usage.model}/{continuation.usage.effort} ·{' '}
            {(continuation.usage.inputTokens + continuation.usage.outputTokens).toLocaleString()}{' '}
            tok ·{' '}
            {continuation.usage.apiCost.source === 'unrated'
              ? 'API cost unrated'
              : `~$${continuation.usage.apiCost.amountUsd.toFixed(2)} API`}
          </p>
        </div>
        <Button size="sm" type="button" disabled={busy} onClick={onAccept}>
          {pendingOperation === 'accepting_continuation' ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <CheckCircle2 data-icon="inline-start" />
          )}
          Accept workflow
        </Button>
      </div>
      <div className="mt-2 flex items-end gap-2">
        <textarea
          className="min-h-14 flex-1 resize-y rounded-md border border-input bg-background/60 px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
          aria-label="Workflow continuation guidance"
          placeholder="What should the planner change in this workflow?"
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
          Request changes
        </Button>
      </div>
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
      <div className="border-y border-border bg-muted/5" data-testid="jira-task-details">
        <CollapsibleTrigger className="group flex w-full items-center justify-between bg-muted/10 px-5 py-3 text-left hover:bg-muted/30">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium">Task details</span>
            <StateBadge
              className={
                state.status === 'current'
                  ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                  : 'bg-amber-500/12 text-amber-700 dark:text-amber-300'
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
          <div className="border-t border-border/60 px-5 py-5">
            {state.status === 'current' ? null : (
              <div
                className="mb-4 flex items-center justify-between gap-3 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
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
        <Radio
          className={cn(
            'size-3',
            streamStatus === 'live' && 'text-emerald-600 dark:text-emerald-400',
          )}
        />
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
                    {entry.externalUrl === undefined ? (
                      <strong className="text-sm font-medium">{entry.title}</strong>
                    ) : (
                      <a
                        className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
                        href={entry.externalUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {entry.title}
                        <ExternalLink className="size-3" />
                      </a>
                    )}
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

const PlanningTranscriptSurface = ({
  transcript,
  live,
}: {
  readonly transcript: PlanningTranscriptLoadState;
  readonly live: boolean;
}) => {
  if (transcript.status === 'missing' || transcript.status === 'loading') return null;
  if (transcript.status === 'failed') return <InlineError>{transcript.message}</InlineError>;
  if (transcript.transcript.chunks.length === 0 && !live) return null;

  const log = planningAgentLogFrom(transcript.transcript);
  const latestAttempt = log.attempts.at(-1)?.attempt ?? null;
  const measuredTokens = log.attempts.reduce(
    (total, attempt) =>
      total + (attempt.usage === null ? 0 : attempt.usage.inputTokens + attempt.usage.outputTokens),
    0,
  );

  const renderEvent = (event: PlanningAgentEvent, index: number): ReactNode => {
    if (event.kind === 'command') {
      return (
        <li className="py-2" key={`${event.id}:${String(index)}`}>
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
            <code className="min-w-0 flex-1 truncate text-foreground/90" title={event.command}>
              {event.command}
            </code>
            <span
              className={cn(
                'shrink-0 text-[10px]',
                event.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {event.status === 'running' ? 'running' : `exit ${String(event.exitCode ?? 0)}`}
            </span>
          </div>
          {event.output.trim().length === 0 ? null : (
            <details className="ml-5 mt-1 text-[11px] text-muted-foreground">
              <summary className="cursor-pointer select-none hover:text-foreground">
                Command output
              </summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 font-mono leading-5">
                {event.output}
              </pre>
            </details>
          )}
        </li>
      );
    }
    if (event.kind === 'error') {
      return (
        <li className="flex gap-2 py-2 text-xs text-destructive" key={`error:${String(index)}`}>
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words leading-5">{event.message}</span>
        </li>
      );
    }
    if (event.kind === 'warning') {
      return (
        <li className="py-2" key={`warning:${String(index)}`}>
          <details className="text-xs text-amber-700 dark:text-amber-300/90">
            <summary className="cursor-pointer select-none">Provider warning</summary>
            <p className="mt-1 break-words pl-5 leading-5 text-muted-foreground">{event.message}</p>
          </details>
        </li>
      );
    }
    return (
      <li
        className="flex min-w-0 items-baseline gap-2 py-2 text-xs"
        key={`message:${String(index)}`}
      >
        <Sparkles className="size-3.5 shrink-0 text-primary" />
        <strong className="font-medium">{event.title}</strong>
        {event.detail === null ? null : (
          <span className="truncate text-muted-foreground">{event.detail}</span>
        )}
      </li>
    );
  };

  return (
    <Collapsible defaultOpen={live}>
      <section className="border-y border-border bg-muted/5" aria-label="Planning agent log">
        <CollapsibleTrigger className="group flex w-full items-center justify-between bg-muted/10 px-5 py-3 text-left hover:bg-muted/30">
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles className="size-4 text-muted-foreground" />
            <strong className="text-sm">Agent log</strong>
            {live ? <StateBadge>Live</StateBadge> : null}
            <span className="text-[11px] text-muted-foreground">
              {log.attempts.length} {log.attempts.length === 1 ? 'attempt' : 'attempts'} ·{' '}
              {measuredTokens.toLocaleString()} tok
              {transcript.transcript.totalBytes > 0
                ? ` · ${(transcript.transcript.totalBytes / 1024).toFixed(1)} KB log`
                : ''}
              {transcript.transcript.truncated ? ' · truncated' : ''}
            </span>
          </div>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div
            className="max-h-[min(55vh,36rem)] overflow-auto border-t border-border/60 bg-muted/20"
            data-testid="planning-transcript"
          >
            {log.attempts.length === 0 ? (
              <p className="px-5 py-3 text-xs text-muted-foreground">
                Waiting for provider output…
              </p>
            ) : (
              <div>
                {log.attempts.map((attempt) => {
                  const tokens =
                    attempt.usage === null
                      ? null
                      : attempt.usage.inputTokens + attempt.usage.outputTokens;
                  return (
                    <Collapsible
                      defaultOpen={attempt.attempt === latestAttempt}
                      key={attempt.attempt}
                    >
                      <div className="border-b border-border/60 px-5 last:border-b-0">
                        <CollapsibleTrigger className="group flex w-full items-center gap-2 py-2.5 text-left">
                          <span className="text-xs font-medium">Attempt {attempt.attempt}</span>
                          <StateBadge
                            className={cn(
                              attempt.status === 'completed' &&
                                'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
                              attempt.status === 'failed' &&
                                'border-destructive/30 bg-destructive/10 text-destructive',
                            )}
                          >
                            {attempt.status}
                          </StateBadge>
                          {tokens === null ? null : (
                            <span className="text-[10px] tabular-nums text-muted-foreground">
                              {tokens.toLocaleString()} tok
                            </span>
                          )}
                          <ChevronDown className="ml-auto size-3.5 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          {attempt.events.length === 0 ? (
                            <p className="pb-3 text-xs text-muted-foreground">
                              No operator-relevant events
                            </p>
                          ) : (
                            <ul className="divide-y divide-border/40 pb-1">
                              {attempt.events.map(renderEvent)}
                            </ul>
                          )}
                        </CollapsibleContent>
                      </div>
                    </Collapsible>
                  );
                })}
                <details className="border-t border-border/60 px-5 py-3 text-[11px] text-muted-foreground">
                  <summary className="cursor-pointer select-none hover:text-foreground">
                    Raw JSONL
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-3 font-mono leading-5">
                    {log.raw}
                  </pre>
                </details>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
};

const ExecutionProgressSurface = ({
  projection,
}: {
  readonly projection: OperatorProjectionLoadState;
}) => {
  if (projection.status === 'failed') {
    return (
      <section
        className="border-b border-destructive/30 bg-destructive/5 px-5 py-3"
        data-testid="execution-progress-error"
      >
        <strong className="text-sm text-destructive">Runtime state unavailable</strong>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{projection.message}</p>
      </section>
    );
  }
  if (projection.status !== 'ready' || projection.projection.current === null) return null;
  const current = projection.projection.current;
  const transcript = current.transcript;
  const log = transcript === null ? null : planningAgentLogFrom(transcript);
  const latestAttempt = log?.attempts.at(-1) ?? null;
  const tokens =
    latestAttempt?.usage === null || latestAttempt?.usage === undefined
      ? null
      : latestAttempt.usage.inputTokens + latestAttempt.usage.outputTokens;

  return (
    <section
      className={cn(
        'border-b px-5 py-3',
        current.status === 'waiting'
          ? 'border-amber-500/30 bg-amber-500/5'
          : 'border-primary/25 bg-primary/5',
      )}
      data-testid="execution-progress"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'size-2 shrink-0 rounded-full',
                current.status === 'running' ? 'animate-pulse bg-primary' : 'bg-amber-400',
              )}
            />
            <strong className="text-sm">
              {current.status === 'running' ? 'Working now' : 'Waiting for you'}
            </strong>
            {current.blockRun === null ? null : (
              <span className="text-[11px] tabular-nums text-muted-foreground">
                attempt {current.blockRun}
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-sm" title={current.reference ?? current.nodeId}>
            {current.reference ?? current.nodeId}
          </p>
          {current.reason === null ? null : (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{current.reason}</p>
          )}
        </div>
        <div className="shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
          {transcript === null ? (
            <span>Temporal activity active</span>
          ) : (
            <>
              <span>{(transcript.totalBytes / 1024).toFixed(1)} KB persisted</span>
              {tokens === null ? null : <span> · {tokens.toLocaleString()} tok</span>}
            </>
          )}
        </div>
      </div>
      {latestAttempt === null || latestAttempt.events.length === 0 ? null : (
        <div className="mt-2 border-t border-border/60 pt-2 text-xs">
          {latestAttempt.events.slice(-3).map((event, index) => (
            <div className="flex min-w-0 gap-2 py-0.5" key={`${event.kind}:${String(index)}`}>
              <span className="shrink-0 text-muted-foreground">
                {event.kind === 'command' ? 'command' : event.kind}
              </span>
              <span className="truncate">
                {event.kind === 'command'
                  ? event.command
                  : event.kind === 'message'
                    ? `${event.title}${event.detail === null ? '' : ` · ${event.detail}`}`
                    : event.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

const RunLogSurface = ({ state }: { readonly state: RunLogLoadState }) => {
  if (state.status === 'missing') return null;
  if (state.status === 'loading') {
    return (
      <section className="border-b border-border px-5 py-3" aria-label="Run log">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          Loading run log…
        </div>
      </section>
    );
  }
  if (state.status === 'failed') {
    return (
      <section className="border-b border-border px-5 py-3" aria-label="Run log">
        <InlineError>{state.message}</InlineError>
      </section>
    );
  }

  const tokens = state.response.entries.reduce((total, entry) => {
    if (entry.usage !== null) return total + entry.usage.inputTokens + entry.usage.outputTokens;
    if (entry.runtime !== 'bootstrap') return total;
    return (
      total +
      planningAgentLogFromRaw(entry.rawLog).attempts.reduce(
        (attemptTotal, attempt) =>
          attemptTotal +
          (attempt.usage === null ? 0 : attempt.usage.inputTokens + attempt.usage.outputTokens),
        0,
      )
    );
  }, 0);
  return (
    <Collapsible defaultOpen>
      <section className="border-b border-border bg-background" aria-label="Run log">
        <CollapsibleTrigger className="group flex w-full items-center justify-between bg-muted/10 px-5 py-3 text-left hover:bg-muted/30">
          <div className="flex items-center gap-2">
            <Terminal className="size-4 text-primary" />
            <strong className="text-sm">Run log</strong>
            <span className="text-[11px] text-muted-foreground">
              {state.response.entries.length} attempts
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {tokens.toLocaleString()} measured tokens
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-border/60">
          {state.response.entries.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">
              No agent or process attempts yet.
            </p>
          ) : (
            <div
              className="max-h-[min(62vh,48rem)] divide-y divide-border overflow-y-auto overscroll-contain"
              data-testid="run-log-transcript"
            >
              {state.response.entries.map((entry) => {
                const parsed = planningAgentLogFromRaw(entry.rawLog);
                const events = parsed.attempts.flatMap((attempt) => attempt.events);
                const entryTokens =
                  entry.usage === null ? null : entry.usage.inputTokens + entry.usage.outputTokens;
                return (
                  <article className="px-5 py-4" key={entry.id}>
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <strong className="text-sm">
                            {entry.reference.replaceAll('.', ' ')}
                          </strong>
                          <span className="text-[11px] text-muted-foreground">
                            attempt {entry.blockRun}
                          </span>
                          {entry.status === 'running' ? (
                            <span className="size-2 animate-pulse rounded-full bg-primary" />
                          ) : null}
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {entry.runtime}
                          {entry.runner === null ? '' : ` · ${entry.runner}`}
                          {entryTokens === null ? '' : ` · ${entryTokens.toLocaleString()} tok`}
                          {entry.usage === null
                            ? ''
                            : ` · ${(entry.usage.durationMs / 1_000).toFixed(1)}s`}
                        </p>
                      </div>
                      <StateBadge>{entry.status.replaceAll('_', ' ')}</StateBadge>
                    </div>

                    {events.length === 0 ? null : (
                      <div className="mt-3 divide-y divide-border/50 border-t border-border/60">
                        {events.map((event, index) => {
                          if (event.kind === 'command') {
                            return (
                              <div
                                className="py-3"
                                key={`${entry.id}:${event.id}:${String(index)}`}
                              >
                                <div className="flex items-start gap-2">
                                  <Terminal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                                  <code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-xs leading-5">
                                    {event.command}
                                  </code>
                                  <span className="shrink-0 text-[10px] text-muted-foreground">
                                    {event.status === 'running'
                                      ? 'running'
                                      : `exit ${String(event.exitCode ?? 0)}`}
                                  </span>
                                </div>
                                {event.output.length === 0 ? null : (
                                  <details
                                    className="ml-5 mt-2 text-xs"
                                    open={event.status !== 'completed'}
                                  >
                                    <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
                                      Command output · {event.output.length.toLocaleString()}{' '}
                                      characters
                                    </summary>
                                    <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-3 font-mono text-[11px] leading-5">
                                      {event.output}
                                    </pre>
                                  </details>
                                )}
                              </div>
                            );
                          }
                          if (event.kind === 'message') {
                            return (
                              <div
                                className="flex items-start gap-2 py-3 text-xs"
                                key={`${entry.id}:message:${String(index)}`}
                              >
                                <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" />
                                <div>
                                  <strong className="font-medium">{event.title}</strong>
                                  {event.detail === null ? null : (
                                    <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                                      {event.detail}
                                    </p>
                                  )}
                                </div>
                              </div>
                            );
                          }
                          return (
                            <div
                              className={cn(
                                'flex items-start gap-2 py-3 text-xs',
                                event.kind === 'error'
                                  ? 'text-destructive'
                                  : 'text-amber-700 dark:text-amber-300',
                              )}
                              key={`${entry.id}:${event.kind}:${String(index)}`}
                            >
                              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                              <span className="whitespace-pre-wrap break-words">
                                {event.message}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {entry.resultSummary === null ? null : (
                      <p className="mt-3 border-t border-border/60 pt-3 text-xs leading-5">
                        {entry.resultSummary}
                      </p>
                    )}
                    {entry.workspaceChanges === null ||
                    entry.workspaceChanges.paths.length === 0 ? null : (
                      <ul className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
                        {entry.workspaceChanges.paths.map((file) => (
                          <li key={`${entry.id}:${file.status}:${file.path}`}>
                            {file.status} {file.path}
                          </li>
                        ))}
                      </ul>
                    )}
                    {entry.evidence.length === 0 ? null : (
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        Evidence:{' '}
                        {entry.evidence.map(({ relativePath }) => relativePath).join(', ')}
                      </p>
                    )}
                    {entry.truncated ? (
                      <p className="mt-2 text-xs text-destructive">
                        Live transcript storage was truncated for this attempt.
                      </p>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
};

const ExecutionAttemptSurface = ({
  state,
  onClose,
}: {
  readonly state: ExecutionAttemptLoadState;
  readonly onClose: () => void;
}) => {
  if (state.status === 'missing') return null;
  if (state.status === 'loading') {
    return (
      <section className="border-b border-border px-5 py-4" aria-label="Execution attempt log">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          Loading {state.nodeId} attempt {state.blockRun}…
        </div>
      </section>
    );
  }
  if (state.status === 'failed') {
    return (
      <section className="border-b border-border" aria-label="Execution attempt log">
        <div className="flex items-center justify-between px-5 py-3">
          <InlineError>{state.message}</InlineError>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onClose}>
            <X />
          </Button>
        </div>
      </section>
    );
  }

  const attempt = state.attempt;
  const output = attempt.output;
  const log = attempt.transcript === null ? null : planningAgentLogFrom(attempt.transcript);
  const events = log?.attempts.flatMap((providerAttempt) => providerAttempt.events) ?? [];
  return (
    <section className="border-b border-border bg-muted/5" aria-label="Execution attempt log">
      <div className="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Terminal className="size-4 text-primary" />
            <strong className="text-sm">Focused attempt</strong>
            <StateBadge>{output?.status ?? 'running'}</StateBadge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {attempt.nodeId} · attempt {attempt.blockRun}
            {output?.usage === null || output?.usage === undefined
              ? ''
              : ` · ${(output.usage.inputTokens + output.usage.outputTokens).toLocaleString()} tok · ${(output.usage.durationMs / 1_000).toFixed(1)}s`}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close run log"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <ScrollArea className="max-h-[min(58vh,42rem)]">
        <div className="divide-y divide-border/60 px-5">
          {events.map((event, index) => {
            if (event.kind === 'command') {
              return (
                <div className="py-3" key={`${event.id}:${String(index)}`}>
                  <div className="flex items-start gap-2">
                    <Terminal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-xs leading-5">
                      {event.command}
                    </code>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {event.status === 'running'
                        ? 'running'
                        : `exit ${String(event.exitCode ?? 0)}`}
                    </span>
                  </div>
                  {event.output.length === 0 ? null : (
                    <details className="ml-5 mt-2 text-xs">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                        Command output
                      </summary>
                      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-3 font-mono text-[11px] leading-5">
                        {event.output}
                      </pre>
                    </details>
                  )}
                </div>
              );
            }
            if (event.kind === 'message') {
              return (
                <div className="flex gap-2 py-3 text-xs" key={`message:${String(index)}`}>
                  <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" />
                  <div>
                    <strong className="font-medium">{event.title}</strong>
                    {event.detail === null ? null : (
                      <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                        {event.detail}
                      </p>
                    )}
                  </div>
                </div>
              );
            }
            return (
              <div
                className={cn(
                  'flex gap-2 py-3 text-xs',
                  event.kind === 'error'
                    ? 'text-destructive'
                    : 'text-amber-700 dark:text-amber-300',
                )}
                key={`${event.kind}:${String(index)}`}
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span className="whitespace-pre-wrap break-words">{event.message}</span>
              </div>
            );
          })}
          {output === null ? null : (
            <div className="py-3 text-xs">
              <div className="grid gap-1 text-muted-foreground sm:grid-cols-2">
                <span>Runner: {output.runner}</span>
                <span>Exit: {output.exitCode === null ? 'n/a' : output.exitCode}</span>
                <span className="sm:col-span-2 break-all">cwd: {output.cwd}</span>
              </div>
              {output.result?.summary === undefined ? null : (
                <p className="mt-2 text-foreground">{output.result.summary}</p>
              )}
              {output.stdout.length === 0 && output.stderr.length === 0 ? null : (
                <details className="mt-2">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    Full persisted stdout/stderr
                  </summary>
                  <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-3 font-mono text-[11px] leading-5">
                    {[output.stdout, output.stderr].filter((value) => value.length > 0).join('\n')}
                  </pre>
                </details>
              )}
            </div>
          )}
          {attempt.workspaceChanges === null ? null : (
            <div className="py-3">
              <div className="flex items-center justify-between gap-3">
                <strong className="text-xs font-medium">
                  Files changed · {attempt.workspaceChanges.paths.length}
                </strong>
                {attempt.workspaceChanges.truncated ? (
                  <span className="text-[10px] text-amber-700 dark:text-amber-300">truncated</span>
                ) : null}
              </div>
              {attempt.workspaceChanges.paths.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">No product file changes</p>
              ) : (
                <ul className="mt-2 space-y-1 font-mono text-xs">
                  {attempt.workspaceChanges.paths.map((file) => (
                    <li
                      className="flex min-w-0 items-center gap-2"
                      key={`${file.status}:${file.path}`}
                    >
                      <span className="w-6 shrink-0 text-muted-foreground">{file.status}</span>
                      <span className="min-w-0 break-all">{file.path}</span>
                    </li>
                  ))}
                </ul>
              )}
              {attempt.workspaceChanges.trackedDiffSha256 === null ? null : (
                <p className="mt-2 break-all text-[10px] text-muted-foreground">
                  diff {attempt.workspaceChanges.trackedDiffSha256}
                </p>
              )}
            </div>
          )}
          {attempt.evidence.length === 0 ? null : (
            <div className="py-3">
              <strong className="text-xs font-medium">Evidence · {attempt.evidence.length}</strong>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {attempt.evidence.map((artifact) => (
                  <li className="flex items-center justify-between gap-3" key={artifact.artifactId}>
                    <span className="min-w-0 truncate">{artifact.relativePath}</span>
                    <span className="shrink-0 tabular-nums">
                      {artifact.mimeType} · {artifact.byteLength.toLocaleString()} B
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </ScrollArea>
    </section>
  );
};

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
  projection,
  task,
  onSelectAttempt,
}: {
  readonly workflow: WorkflowLoadState;
  readonly projection: OperatorProjectionLoadState;
  readonly task: OperatorTaskSummary | null;
  readonly onSelectAttempt: (step: OperatorWorkflowStep, blockRun: number) => void;
}) => {
  if (workflow.status === 'loading' || projection.status === 'loading') {
    return (
      <aside className="flex min-h-0 flex-col" aria-label="Current workflow">
        <EmptyState>Loading workflow…</EmptyState>
      </aside>
    );
  }

  if (projection.status === 'failed') {
    return (
      <aside className="flex min-h-0 flex-col" aria-label="Current workflow">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Workflow</h2>
        </div>
        <InlineError>{projection.message}</InlineError>
      </aside>
    );
  }

  if (workflow.status === 'missing' && projection.projection.stages.length === 0) {
    if (task?.origin.kind === 'jira') {
      const binding = task.origin.repositoryBinding;
      const repositoryResolved = binding.status === 'resolved';
      const jiraSnapshotReady = task.origin.syncStatus === 'current';
      const workflowReady = jiraSnapshotReady && repositoryResolved;
      const repositoryLabel = repositoryResolved
        ? binding.repository.repositoryId
        : binding.status === 'missing'
          ? null
          : 'reference' in binding
            ? binding.reference
            : null;
      const prerequisites = [
        ['Jira snapshot', jiraSnapshotReady ? 'complete' : 'blocked'],
        ['Repository mapping', repositoryResolved ? 'complete' : 'blocked'],
        ['Read-only analysis', workflowReady ? 'ready' : 'waiting'],
        ['Compile & validate', 'waiting'],
      ] as const;
      return (
        <aside className="flex min-h-0 flex-col" aria-label="Current workflow">
          <div className="border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Workflow</h2>
              <StateBadge
                className={
                  workflowReady
                    ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                    : 'bg-amber-500/12 text-amber-700 dark:text-amber-300'
                }
              >
                {workflowReady ? 'ready' : 'blocked'}
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
                {!jiraSnapshotReady
                  ? 'Restore Jira access and sync this task. The repository mapping is already saved.'
                  : repositoryResolved
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

  if (workflow.status === 'failed' && projection.projection.stages.length === 0) {
    return (
      <aside className="flex min-h-0 flex-col" aria-label="Current workflow">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Workflow</h2>
        </div>
        <InlineError>{workflow.message}</InlineError>
      </aside>
    );
  }

  const view = workflow.status === 'ready' ? workflow.response.view : null;
  const title = view?.taskSummary.title ?? task?.title ?? 'Task workflow';
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
                  view?.workflow.status === 'valid'
                    ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                    : projection.projection.status === 'waiting'
                      ? 'bg-amber-500/12 text-amber-700 dark:text-amber-300'
                      : 'bg-cyan-500/12 text-cyan-700 dark:text-cyan-300'
                }
              >
                {view?.workflow.status ?? projection.projection.status.replaceAll('_', ' ')}
              </StateBadge>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">{title}</p>
          </div>
          {view?.workflow.graphHash === null || view === null ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <a
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    href={graphDownloadUrl(view.taskSummary.reference)}
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
        {view === null ? null : (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>{view.workflow.verificationPlan.profile.replaceAll('_', ' ')}</span>
            <span>{view.workflow.waits.length} waits</span>
            <span>{view.workflow.capabilities.required.length} capabilities</span>
          </div>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2 py-2">
        <WorkflowStages stages={projection.projection.stages} onSelectAttempt={onSelectAttempt} />
      </ScrollArea>
    </aside>
  );
};

export const App = () => {
  const [tasks, setTasks] = useState<readonly OperatorTaskSummary[]>([]);
  const [repositories, setRepositories] = useState<readonly RepositoryCatalogEntry[]>([]);
  const [tasksStatus, setTasksStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [bootstrapStatus, setBootstrapStatus] = useState<'loading' | 'ready'>('loading');
  const [tasksMessage, setTasksMessage] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>(() => readStoredSelection() ?? '');
  const [tasksCollapsed, setTasksCollapsed] = useState(readStoredTaskRailCollapsed);
  const [theme, setTheme] = useState<OperatorTheme>(readStoredTheme);
  const [workflowState, setWorkflowState] = useState<WorkflowLoadState>({ status: 'loading' });
  const [activityState, setActivityState] = useState<ActivityLoadState>({ status: 'loading' });
  const [operatorProjectionState, setOperatorProjectionState] =
    useState<OperatorProjectionLoadState>({ status: 'loading' });
  const [runLogState, setRunLogState] = useState<RunLogLoadState>({ status: 'missing' });
  const [executionAttemptState, setExecutionAttemptState] = useState<ExecutionAttemptLoadState>({
    status: 'missing',
  });
  const [implementationPlanState, setImplementationPlanState] =
    useState<ImplementationPlanLoadState>({ status: 'missing' });
  const [planningTranscriptState, setPlanningTranscriptState] =
    useState<PlanningTranscriptLoadState>({ status: 'missing' });
  const [planReviewHistoryState, setPlanReviewHistoryState] = useState<PlanReviewHistoryLoadState>({
    status: 'loading',
  });
  const [planAnnotationDrafts, setPlanAnnotationDrafts] =
    useState<ReadonlyMap<string, readonly PlanReviewAnnotation[]>>(readStoredPlanAnnotations);
  const [jiraIssueState, setJiraIssueState] = useState<JiraIssueLoadState>({
    status: 'not_applicable',
  });
  const [jiraSyncState, setJiraSyncState] = useState<JiraSyncState>({ status: 'idle' });
  const [codeReviewNotices, setCodeReviewNotices] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [streamStatus, setStreamStatus] = useState<ConsoleStreamStatus>('connecting');
  const [runtimeWatchTaskId, setRuntimeWatchTaskId] = useState<string | null>(null);
  const [restartConfirmationTaskId, setRestartConfirmationTaskId] = useState<string | null>(null);
  const [pendingOperations, setPendingOperations] = useState<ReadonlyMap<string, TaskOperation>>(
    new Map(),
  );
  const [planGuidanceDrafts, setPlanGuidanceDrafts] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [continuationGuidanceDrafts, setContinuationGuidanceDrafts] = useState<
    ReadonlyMap<string, string>
  >(new Map());
  const [interventionGuidanceDrafts, setInterventionGuidanceDrafts] = useState<
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
  const tasksRefreshSequenceRef = useRef(0);
  const selectionRefreshSequenceRef = useRef(0);
  const runtimeRefreshSequenceRef = useRef(0);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? null,
    [tasks, selectedId],
  );
  const selectedRunId =
    operatorProjectionState.status === 'ready'
      ? operatorProjectionState.projection.activeRunId
      : null;
  const selectedIntervention =
    operatorProjectionState.status === 'ready' &&
    operatorProjectionState.projection.current?.status === 'waiting' &&
    operatorProjectionState.projection.current.intervention.kind !== 'typed_resolution'
      ? operatorProjectionState.projection.current.intervention
      : null;
  const selectedWorkflowContinuation =
    operatorProjectionState.status === 'ready'
      ? (operatorProjectionState.projection.continuations.findLast(
          ({ status }) => status === 'awaiting_review',
        ) ?? null)
      : null;

  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
    if (selectedId.length > 0) {
      writeStoredSelection(selectedId);
    }
  }, [selectedId]);

  useEffect(() => {
    writeStoredPlanAnnotations(planAnnotationDrafts);
  }, [planAnnotationDrafts]);

  const refreshTasks = async (): Promise<string | null> => {
    const sequence = tasksRefreshSequenceRef.current + 1;
    tasksRefreshSequenceRef.current = sequence;
    try {
      const response = await listOperatorTasks();
      if (sequence !== tasksRefreshSequenceRef.current) return null;
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
        selectedIdRef.current = nextSelectedId;
        setSelectedId(nextSelectedId);
      }

      return nextSelectedId;
    } catch (error) {
      if (sequence !== tasksRefreshSequenceRef.current) return null;
      setTasksStatus('failed');
      setTasksMessage(error instanceof Error ? error.message : 'Unexpected task queue failure');
      return null;
    }
  };

  const refreshSelectedWorkflow = async (
    taskReference: string,
    refreshSequence: number,
  ): Promise<void> => {
    setWorkflowState({ status: 'loading' });
    try {
      const response = await loadWorkflow(taskReference);
      if (refreshSequence !== selectionRefreshSequenceRef.current) return;
      setWorkflowState(
        response.status === 'found'
          ? { status: 'ready', response: response.response }
          : { status: 'missing' },
      );
    } catch (error) {
      if (refreshSequence !== selectionRefreshSequenceRef.current) return;
      setWorkflowState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unexpected workflow failure',
      });
    }
  };

  const refreshSelectedActivity = async (
    taskReference: string,
    refreshSequence: number,
  ): Promise<void> => {
    setActivityState({ status: 'loading' });
    try {
      const response = await loadOperatorActivity(taskReference);
      if (refreshSequence !== selectionRefreshSequenceRef.current) return;
      setActivityState({ status: 'ready', response });
    } catch (error) {
      if (refreshSequence !== selectionRefreshSequenceRef.current) return;
      setActivityState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unexpected activity failure',
      });
    }
  };

  const refreshSelectedOperatorProjection = async (
    taskReference: string,
    refreshSequence: number,
  ): Promise<void> => {
    setOperatorProjectionState({ status: 'loading' });
    try {
      const projection = await loadOperatorWorkflowProjection(taskReference);
      if (refreshSequence !== selectionRefreshSequenceRef.current) return;
      setOperatorProjectionState({ status: 'ready', projection });
    } catch (error) {
      if (refreshSequence !== selectionRefreshSequenceRef.current) return;
      setOperatorProjectionState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unexpected workflow projection failure',
      });
    }
  };

  const refreshSelectedRunLog = async (
    taskReference: string,
    refreshSequence: number,
    showLoading = true,
  ): Promise<void> => {
    if (showLoading) setRunLogState({ status: 'loading' });
    try {
      const response = await loadOperatorRunLog(taskReference);
      if (refreshSequence !== selectionRefreshSequenceRef.current) return;
      setRunLogState(response === null ? { status: 'missing' } : { status: 'ready', response });
    } catch (error) {
      if (refreshSequence !== selectionRefreshSequenceRef.current) return;
      setRunLogState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unexpected run log failure',
      });
    }
  };

  const refreshSelectedImplementationPlan = async (
    taskReference: string,
    refreshSequence: number,
  ): Promise<void> => {
    setImplementationPlanState({ status: 'loading' });
    try {
      const response = await loadImplementationPlan(taskReference);
      if (refreshSequence !== selectionRefreshSequenceRef.current) return;
      setImplementationPlanState(
        response.status === 'found'
          ? { status: 'ready', record: response.record }
          : { status: 'missing' },
      );
    } catch (error) {
      if (refreshSequence !== selectionRefreshSequenceRef.current) return;
      setImplementationPlanState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unexpected planning failure',
      });
    }
  };

  const refreshSelectedPlanningTranscript = async (
    taskReference: string,
    refreshSequence: number,
    showLoading = true,
  ): Promise<void> => {
    if (showLoading) setPlanningTranscriptState({ status: 'loading' });
    try {
      const response = await loadPlanningTranscript(taskReference);
      if (refreshSequence !== selectionRefreshSequenceRef.current) return;
      setPlanningTranscriptState(
        response.status === 'found'
          ? { status: 'ready', transcript: response.transcript }
          : { status: 'missing' },
      );
    } catch (error) {
      if (refreshSequence !== selectionRefreshSequenceRef.current) return;
      setPlanningTranscriptState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unexpected transcript failure',
      });
    }
  };

  const refreshSelectedPlanReviewHistory = async (
    taskReference: string,
    refreshSequence: number,
  ): Promise<void> => {
    setPlanReviewHistoryState({ status: 'loading' });
    try {
      const rounds = await loadPlanReviewHistory(taskReference);
      if (refreshSequence !== selectionRefreshSequenceRef.current) return;
      setPlanReviewHistoryState({ status: 'ready', rounds });
    } catch (error) {
      if (refreshSequence !== selectionRefreshSequenceRef.current) return;
      setPlanReviewHistoryState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Plan review history is unavailable',
      });
    }
  };

  const refreshSelectedJiraIssue = async (
    taskReference: string,
    refreshSequence: number,
  ): Promise<void> => {
    if (!taskReference.startsWith('jira:')) {
      if (refreshSequence !== selectionRefreshSequenceRef.current) return;
      setJiraIssueState({ status: 'not_applicable' });
      return;
    }
    setJiraIssueState({ status: 'loading' });
    try {
      const state = await loadJiraIssue(taskReference.slice('jira:'.length));
      if (refreshSequence !== selectionRefreshSequenceRef.current) return;
      setJiraIssueState({ status: 'ready', state });
    } catch (error) {
      if (refreshSequence !== selectionRefreshSequenceRef.current) return;
      setJiraIssueState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unexpected Jira snapshot failure',
      });
    }
  };

  const refreshSelection = async (taskReference: string): Promise<void> => {
    const refreshSequence = selectionRefreshSequenceRef.current + 1;
    selectionRefreshSequenceRef.current = refreshSequence;
    await Promise.all([
      refreshSelectedWorkflow(taskReference, refreshSequence),
      refreshSelectedOperatorProjection(taskReference, refreshSequence),
      refreshSelectedRunLog(taskReference, refreshSequence),
      refreshSelectedActivity(taskReference, refreshSequence),
      refreshSelectedImplementationPlan(taskReference, refreshSequence),
      refreshSelectedPlanningTranscript(taskReference, refreshSequence),
      refreshSelectedPlanReviewHistory(taskReference, refreshSequence),
      refreshSelectedJiraIssue(taskReference, refreshSequence),
    ]);
  };

  const refreshRuntimeSurfaces = async (
    taskReference: string,
  ): Promise<OperatorWorkflowProjection | null> => {
    const sequence = runtimeRefreshSequenceRef.current + 1;
    runtimeRefreshSequenceRef.current = sequence;
    const [projection, activity, runLog] = await Promise.allSettled([
      loadOperatorWorkflowProjection(taskReference),
      loadOperatorActivity(taskReference),
      loadOperatorRunLog(taskReference),
    ]);
    if (sequence !== runtimeRefreshSequenceRef.current || selectedIdRef.current !== taskReference) {
      return null;
    }
    setOperatorProjectionState(
      projection.status === 'fulfilled'
        ? { status: 'ready', projection: projection.value }
        : {
            status: 'failed',
            message:
              projection.reason instanceof Error
                ? projection.reason.message
                : 'Runtime projection is unavailable',
          },
    );
    setActivityState(
      activity.status === 'fulfilled'
        ? { status: 'ready', response: activity.value }
        : {
            status: 'failed',
            message:
              activity.reason instanceof Error
                ? activity.reason.message
                : 'Runtime activity is unavailable',
          },
    );
    setRunLogState(
      runLog.status === 'fulfilled'
        ? runLog.value === null
          ? { status: 'missing' }
          : { status: 'ready', response: runLog.value }
        : {
            status: 'failed',
            message:
              runLog.reason instanceof Error ? runLog.reason.message : 'Run log is unavailable',
          },
    );
    return projection.status === 'fulfilled' ? projection.value : null;
  };

  const applyRuntimeProjectionToSelectedTask = (
    taskReference: string,
    projection: OperatorWorkflowProjection,
  ): void => {
    setTasks((current) =>
      current.map((task) => {
        if (task.id !== taskReference) return task;
        if (projection.status === 'completed') {
          return { ...task, status: 'done', attention: 'none' };
        }
        if (projection.status === 'waiting') {
          const planReview = projection.current?.waitKind === 'plan.approved@1';
          const codeReview = projection.current?.waitKind === 'code_review@1';
          return {
            ...task,
            status: planReview ? 'plan_review' : codeReview ? 'code_review' : 'waiting',
            attention: 'operator',
            currentStage: projection.current?.reason ?? 'Waiting for operator action',
          };
        }
        return {
          ...task,
          status: 'running',
          attention: 'none',
          currentStage:
            projection.current?.reference ??
            projection.current?.nodeId ??
            'Temporal workflow running',
        };
      }),
    );
  };

  useEffect(() => {
    const controller = new AbortController();

    const initialize = async (): Promise<void> => {
      const [nextSelectedId, catalog] = await Promise.all([
        refreshTasks(),
        listRepositories().catch(() => [] as const),
      ]);
      if (!controller.signal.aborted) setRepositories(catalog);
      if (controller.signal.aborted || nextSelectedId === null) {
        return;
      }

      if (nextSelectedId.length > 0) {
        await refreshSelection(nextSelectedId);
      }
      setBootstrapStatus('ready');
    };

    void initialize();

    return () => {
      controller.abort();
    };
  }, []);

  const planningInProgress =
    implementationPlanState.status === 'ready' &&
    implementationPlanState.record.status === 'planning';

  useEffect(() => {
    if (selectedId.length === 0 || !planningInProgress) return;
    const poll = window.setInterval(() => {
      void refreshSelectedPlanningTranscript(
        selectedId,
        selectionRefreshSequenceRef.current,
        false,
      );
    }, 750);
    return () => {
      window.clearInterval(poll);
    };
  }, [planningInProgress, selectedId]);

  useEffect(() => {
    const awaitingRuntimeProjection =
      selectedTask?.status === 'running' || runtimeWatchTaskId === selectedId;
    if (selectedId.length === 0 || !awaitingRuntimeProjection) return;
    const lifecycle = { active: true };
    let inFlight = false;

    const refreshRuntimeProjection = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const projection = await refreshRuntimeSurfaces(selectedId);
        if (!lifecycle.active) return;
        if (projection !== null) {
          applyRuntimeProjectionToSelectedTask(selectedId, projection);
        }
        if (projection !== null && projection.status !== 'running') {
          if (selectedIdRef.current === selectedId) {
            await refreshSelection(selectedId);
          }
          await refreshTasks();
          setRuntimeWatchTaskId((current) => (current === selectedId ? null : current));
        }
      } catch (error) {
        if (!lifecycle.active || selectedIdRef.current !== selectedId) return;
        setOperatorProjectionState({
          status: 'failed',
          message: error instanceof Error ? error.message : 'Runtime state is unavailable',
        });
      } finally {
        inFlight = false;
      }
    };

    void refreshRuntimeProjection().catch(() => undefined);
    const poll = window.setInterval(
      () => void refreshRuntimeProjection().catch(() => undefined),
      2_000,
    );
    return () => {
      lifecycle.active = false;
      window.clearInterval(poll);
    };
  }, [runtimeWatchTaskId, selectedId, selectedTask?.status]);

  useEffect(() => {
    if (bootstrapStatus !== 'ready') {
      return;
    }

    const source = connectOperatorStream(streamCursorRef.current, {
      onEvent: (event) => {
        if (
          event.taskReference === selectedIdRef.current &&
          (event.eventType === 'WorkflowAnalyzed' ||
            event.eventType === 'WorkflowPlanned' ||
            event.eventType === 'WorkflowRejected')
        ) {
          setRuntimeWatchTaskId(event.taskReference);
        }

        void (async () => {
          const nextSelectedId = await refreshTasks();
          if (nextSelectedId === null) {
            return;
          }

          if (event.taskReference === selectedIdRef.current) {
            await refreshSelection(event.taskReference);
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
  }, [bootstrapStatus]);

  const handleSelectTask = (taskId: string): void => {
    setRestartConfirmationTaskId(null);
    setExecutionAttemptState({ status: 'missing' });
    setSelectedId(taskId);
    void refreshSelection(taskId);
  };

  const handleSelectExecutionAttempt = (step: OperatorWorkflowStep, blockRun: number): void => {
    const taskReference = selectedIdRef.current;
    if (taskReference.length === 0 || step.kind === 'wait') return;
    setExecutionAttemptState({ status: 'loading', nodeId: step.id, blockRun });
    void loadOperatorExecutionAttempt(taskReference, step.id, blockRun)
      .then((attempt) => {
        if (selectedIdRef.current !== taskReference) return;
        setExecutionAttemptState({ status: 'ready', attempt });
      })
      .catch((error: unknown) => {
        if (selectedIdRef.current !== taskReference) return;
        setExecutionAttemptState({
          status: 'failed',
          message: error instanceof Error ? error.message : 'Execution attempt is unavailable',
        });
      });
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
    const requirePlanApproval = planApprovalDrafts.get(taskReference) ?? true;
    const planningStrategy = planningStrategyDrafts.get(taskReference) ?? 'auto';
    setRuntimeWatchTaskId(taskReference);
    setPendingOperations((current) => new Map(current).set(taskReference, 'generating'));
    void generateWorkflow(taskReference, {
      settings: {
        planReview: requirePlanApproval ? 'required' : 'automatic',
        planningStrategy,
      },
    })
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

  const handlePlanReview = (decision: 'approve' | 'request_changes'): void => {
    if (selectedTask === null || selectedTask.status !== 'plan_review') return;
    if (selectedRunId === null) return;
    const taskReference = selectedTask.id;
    const guidance = planGuidanceDrafts.get(taskReference)?.trim() ?? '';
    if (
      implementationPlanState.status !== 'ready' ||
      implementationPlanState.record.status !== 'ready'
    ) {
      return;
    }
    const planningRecord = implementationPlanState.record;
    const annotations = planAnnotationDrafts.get(planningRecord.artifactId) ?? [];
    if (decision === 'request_changes' && guidance.length === 0 && annotations.length === 0) return;
    const operation =
      decision === 'approve' ? ('approving_plan' as const) : ('requesting_plan_changes' as const);
    setRuntimeWatchTaskId(taskReference);
    setPendingOperations((current) => new Map(current).set(taskReference, operation));
    if (decision === 'request_changes') {
      setPlanGuidanceDrafts((current) => {
        const next = new Map(current);
        next.delete(taskReference);
        return next;
      });
    }
    const reviewId = crypto.randomUUID();
    void reviewPlan(
      taskReference,
      decision === 'approve'
        ? {
            decision,
            expectedRunId: selectedRunId,
            reviewId,
            planArtifactId: planningRecord.artifactId,
            planAttempt: planningRecord.attempt,
          }
        : {
            decision,
            expectedRunId: selectedRunId,
            reviewId,
            planArtifactId: planningRecord.artifactId,
            planAttempt: planningRecord.attempt,
            guidance,
            annotations: [...annotations],
          },
    )
      .then(async () => {
        setPlanAnnotationDrafts((current) => {
          const next = new Map(current);
          next.delete(planningRecord.artifactId);
          return next;
        });
        await refreshTasks();
        if (selectedIdRef.current === taskReference) {
          await refreshSelection(taskReference);
        }
      })
      .catch((error: unknown) => {
        if (selectedIdRef.current === taskReference) {
          if (decision === 'request_changes') {
            setPlanGuidanceDrafts((current) => new Map(current).set(taskReference, guidance));
          }
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

  const handleCodeReview = (action: 'sync' | 'complete'): void => {
    if (selectedTask === null || selectedTask.status !== 'code_review') return;
    if (selectedRunId === null) return;
    const taskReference = selectedTask.id;
    const operation = action === 'sync' ? 'syncing_review' : 'completing_review';
    setPendingOperations((current) => new Map(current).set(taskReference, operation));
    const request =
      action === 'sync'
        ? syncCodeReview(taskReference, { expectedRunId: selectedRunId })
        : completeCodeReview(taskReference, { expectedRunId: selectedRunId });
    void request
      .then(async (result) => {
        setCodeReviewNotices((current) => {
          const next = new Map(current);
          next.set(
            taskReference,
            result.status === 'pending'
              ? 'No actionable review comments yet.'
              : result.status === 'changes_requested'
                ? 'Review imported. Revision is starting.'
                : 'Review completed.',
          );
          return next;
        });
        await refreshTasks();
        if (selectedIdRef.current === taskReference) await refreshSelection(taskReference);
      })
      .catch((error: unknown) => {
        setCodeReviewNotices((current) =>
          new Map(current).set(
            taskReference,
            error instanceof Error ? error.message : 'Unexpected code review failure',
          ),
        );
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
      selectedRunId === null ||
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

    setRuntimeWatchTaskId(taskReference);
    setPendingOperations((current) => new Map(current).set(taskReference, 'answering_questions'));
    void answerPlanningClarification(taskReference, { expectedRunId: selectedRunId, answers })
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

  const handleResume = (): void => {
    if (selectedTask === null || selectedTask.status !== 'waiting') return;
    if (selectedRunId === null) return;
    const taskReference = selectedTask.id;
    const guidance =
      selectedIntervention?.kind === 'operator_guidance'
        ? (interventionGuidanceDrafts.get(taskReference)?.trim() ?? '')
        : '';
    setRuntimeWatchTaskId(taskReference);
    setPendingOperations((current) => new Map(current).set(taskReference, 'resuming'));
    void resumeWorkflow(
      taskReference,
      guidance.length === 0
        ? { expectedRunId: selectedRunId }
        : { expectedRunId: selectedRunId, guidance },
    )
      .then(async () => {
        setInterventionGuidanceDrafts((current) => {
          const next = new Map(current);
          next.delete(taskReference);
          return next;
        });
        await refreshTasks();
        if (selectedIdRef.current === taskReference) await refreshSelection(taskReference);
      })
      .catch((error: unknown) => {
        if (selectedIdRef.current === taskReference) {
          setActivityState({
            status: 'failed',
            message: error instanceof Error ? error.message : 'Unexpected resume failure',
          });
        }
      })
      .finally(() => {
        setPendingOperations((current) => {
          if (current.get(taskReference) !== 'resuming') return current;
          const next = new Map(current);
          next.delete(taskReference);
          return next;
        });
      });
  };

  const handleRestart = (): void => {
    if (selectedTask === null || selectedTask.status !== 'waiting') return;
    if (selectedRunId === null) return;
    const taskReference = selectedTask.id;
    setRuntimeWatchTaskId(taskReference);
    setPendingOperations((current) => new Map(current).set(taskReference, 'restarting'));
    void restartWorkflow(taskReference, {
      expectedRunId: selectedRunId,
      confirmation: 'restart_from_scratch',
    })
      .then(async () => {
        setRestartConfirmationTaskId(null);
        setInterventionGuidanceDrafts((current) => {
          const next = new Map(current);
          next.delete(taskReference);
          return next;
        });
        await refreshTasks();
        if (selectedIdRef.current === taskReference) await refreshSelection(taskReference);
      })
      .catch((error: unknown) => {
        if (selectedIdRef.current === taskReference) {
          setActivityState({
            status: 'failed',
            message: error instanceof Error ? error.message : 'Unexpected restart failure',
          });
        }
      })
      .finally(() => {
        setPendingOperations((current) => {
          if (current.get(taskReference) !== 'restarting') return current;
          const next = new Map(current);
          next.delete(taskReference);
          return next;
        });
      });
  };

  const handleWorkflowContinuationReview = (decision: 'accept' | 'reject'): void => {
    if (selectedTask === null || selectedRunId === null || selectedWorkflowContinuation === null)
      return;
    const taskReference = selectedTask.id;
    const guidance = continuationGuidanceDrafts.get(taskReference)?.trim() ?? '';
    if (decision === 'reject' && guidance.length === 0) return;
    const operation =
      decision === 'accept'
        ? ('accepting_continuation' as const)
        : ('rejecting_continuation' as const);
    setPendingOperations((current) => new Map(current).set(taskReference, operation));
    void reviewWorkflowChange(
      taskReference,
      decision === 'accept'
        ? {
            expectedRunId: selectedRunId,
            decision,
            continuationId: selectedWorkflowContinuation.continuationId,
          }
        : {
            expectedRunId: selectedRunId,
            decision,
            continuationId: selectedWorkflowContinuation.continuationId,
            guidance,
          },
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
  const view = workflowState.status === 'ready' ? workflowState.response.view : null;

  return (
    <TooltipProvider>
      <div className="flex h-dvh min-w-[1080px] flex-col bg-background text-foreground">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2.5">
            <Button
              aria-label={tasksCollapsed ? 'Show tasks' : 'Hide tasks'}
              title={tasksCollapsed ? 'Show tasks' : 'Hide tasks'}
              variant="ghost"
              size="icon-sm"
              type="button"
              onClick={() => {
                setTasksCollapsed((current) => {
                  const next = !current;
                  writeStoredTaskRailCollapsed(next);
                  return next;
                });
              }}
            >
              {tasksCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </Button>
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
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    onClick={() => {
                      setTheme((current) => {
                        const next = current === 'dark' ? 'light' : 'dark';
                        applyTheme(next);
                        return next;
                      });
                    }}
                  />
                }
              >
                {theme === 'dark' ? <Sun /> : <Moon />}
              </TooltipTrigger>
              <TooltipContent>
                {theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
              </TooltipContent>
            </Tooltip>
          </div>
        </header>

        {tasksStatus === 'failed' ? (
          <InlineError>{tasksMessage ?? 'The task queue could not be loaded'}</InlineError>
        ) : null}

        <div
          className={cn(
            'grid min-h-0 flex-1',
            selectedTask === null
              ? tasksCollapsed
                ? 'grid-cols-[minmax(0,1fr)]'
                : 'grid-cols-[260px_minmax(0,1fr)]'
              : tasksCollapsed
                ? 'grid-cols-[minmax(0,1fr)_340px]'
                : 'grid-cols-[260px_minmax(0,1fr)_340px]',
          )}
          data-tasks-collapsed={String(tasksCollapsed)}
          data-testid="operator-layout"
        >
          {tasksCollapsed ? null : (
            <TaskQueue
              tasks={tasks}
              repositories={repositories}
              selectedId={selectedId}
              onSelect={handleSelectTask}
              onImportJira={handleJiraSync}
              jiraSync={jiraSyncState}
              liveStatus={streamStatus}
            />
          )}

          <main className="flex min-h-0 flex-col border-r border-border">
            {selectedTask === null ? (
              <EmptyState>{tasksStatus === 'loading' ? 'Loading tasks…' : 'No tasks'}</EmptyState>
            ) : (
              <>
                <SelectedTaskHeader
                  task={selectedTask}
                  workflow={workflowState}
                  activity={activityState}
                  onGenerate={handleGenerate}
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
                <ExecutionProgressSurface projection={operatorProjectionState} />
                <RunLogSurface state={runLogState} />
                <ExecutionAttemptSurface
                  state={executionAttemptState}
                  onClose={() => {
                    setExecutionAttemptState({ status: 'missing' });
                  }}
                />
                {selectedTask.status === 'code_review' ? (
                  <CodeReviewControls
                    pendingOperation={pendingOperations.get(selectedTask.id) ?? null}
                    notice={codeReviewNotices.get(selectedTask.id) ?? null}
                    onSync={() => {
                      handleCodeReview('sync');
                    }}
                    onComplete={() => {
                      handleCodeReview('complete');
                    }}
                  />
                ) : null}
                {selectedTask.status === 'waiting' && selectedIntervention !== null ? (
                  <OperatorIntervention
                    action={selectedIntervention}
                    stage={selectedTask.currentStage}
                    guidance={interventionGuidanceDrafts.get(selectedTask.id) ?? ''}
                    pending={
                      pendingOperations.get(selectedTask.id) === 'resuming' ||
                      pendingOperations.get(selectedTask.id) === 'restarting'
                    }
                    restartConfirming={restartConfirmationTaskId === selectedTask.id}
                    onGuidanceChange={(guidance) => {
                      setInterventionGuidanceDrafts((current) =>
                        new Map(current).set(selectedTask.id, guidance),
                      );
                    }}
                    onResume={handleResume}
                    onRestartRequest={() => {
                      setRestartConfirmationTaskId(selectedTask.id);
                    }}
                    onRestartCancel={() => {
                      setRestartConfirmationTaskId(null);
                    }}
                    onRestartConfirm={handleRestart}
                  />
                ) : null}
                {view === null ? null : <ValidationSurface view={view} />}
                <JiraPlanningSurface task={selectedTask} />
                <WorkflowContinuationSurface
                  continuation={selectedWorkflowContinuation}
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
                />
                <ScrollArea className="min-h-0 flex-1">
                  {selectedTask.status === 'plan_review' ? (
                    <ImplementationPlanSurface
                      planning={implementationPlanState}
                      answers={planningAnswerDrafts.get(selectedTask.id) ?? new Map()}
                      pending={pendingOperations.get(selectedTask.id) === 'answering_questions'}
                      reviewMode
                      annotations={
                        implementationPlanState.status === 'ready' &&
                        implementationPlanState.record.status === 'ready'
                          ? (planAnnotationDrafts.get(implementationPlanState.record.artifactId) ??
                            [])
                          : []
                      }
                      history={
                        planReviewHistoryState.status === 'ready'
                          ? planReviewHistoryState.rounds
                          : []
                      }
                      reviewActions={
                        <PlanReviewActions
                          guidance={planGuidanceDrafts.get(selectedTask.id) ?? ''}
                          annotationCount={
                            implementationPlanState.status === 'ready' &&
                            implementationPlanState.record.status === 'ready'
                              ? (planAnnotationDrafts.get(implementationPlanState.record.artifactId)
                                  ?.length ?? 0)
                              : 0
                          }
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
                      }
                      onAnnotationsChange={(annotations) => {
                        if (
                          implementationPlanState.status !== 'ready' ||
                          implementationPlanState.record.status !== 'ready'
                        ) {
                          return;
                        }
                        const artifactId = implementationPlanState.record.artifactId;
                        setPlanAnnotationDrafts((current) =>
                          new Map(current).set(artifactId, annotations),
                        );
                      }}
                      onAnswerChange={(questionId, answer) => {
                        setPlanningAnswerDrafts((current) => {
                          const taskAnswers = new Map(current.get(selectedTask.id) ?? []);
                          taskAnswers.set(questionId, answer);
                          return new Map(current).set(selectedTask.id, taskAnswers);
                        });
                      }}
                      onSubmitAnswers={handlePlanningClarification}
                    />
                  ) : null}
                  <ActivityTimeline activity={activityState} streamStatus={streamStatus} />
                  {runLogState.status === 'missing' ? (
                    <PlanningTranscriptSurface
                      transcript={planningTranscriptState}
                      live={planningInProgress}
                    />
                  ) : null}
                  {selectedTask.status === 'plan_review' ? null : (
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
                  )}
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

          {selectedTask === null ? null : (
            <WorkflowSidebar
              workflow={workflowState}
              projection={operatorProjectionState}
              task={selectedTask}
              onSelectAttempt={handleSelectExecutionAttempt}
            />
          )}
        </div>
      </div>
    </TooltipProvider>
  );
};
