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
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type {
  OperatorInterventionAction,
  OperatorActivityResponse,
  OperatorRunLogResponse,
  OperatorTaskSummary,
  OperatorWorkflowContinuation,
  OperatorWorkflowProjection,
  OperatorWorkflowStep,
  RunStartCommand,
  WorkflowResponse,
  WorkflowView,
} from '../server/operator-contracts.js';
import type { ImplementationPlanningRecord } from '../server/implementation-planning-contracts.js';
import type { PlanningTranscriptView } from '../server/planning-transcript.js';
import {
  PlanReviewAnnotationSchema,
  type PlanReviewAnnotation,
  type PlanReviewRound,
} from '../server/plan-review.js';
import type { JiraIssueState, JiraIssueSnapshot } from '../integrations/jira/contracts.js';
import type { PlanningStrategyRequest } from '../planning/implementation-plan.js';
import type { RepositoryCatalogEntry } from '../workspace/contracts.js';
import type { RetrospectiveResponse } from '../server/report.js';
import { taskBranchName, taskBranchNameMatches } from '../shared/git-branch.js';
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
  loadOperatorRunLog,
  loadRetrospective,
  loadOperatorWorkflowProjection,
  loadWorkflow,
  previewJiraIssue,
  removeOperatorTask,
  restoreOperatorTask,
  reviewPlan,
  reviewWorkflowChange,
  restartWorkflow,
  resolveDependencyAvailable,
  resolveDependencyDiscovery,
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

type RetrospectiveLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly response: RetrospectiveResponse & { status: 'ready' } }
  | { readonly status: 'failed'; readonly message: string };

type ConsoleStreamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

type TaskOperation =
  | 'generating'
  | 'approving_plan'
  | 'requesting_plan_changes'
  | 'syncing_review'
  | 'completing_review'
  | 'answering_questions'
  | 'verifying_dependency'
  | 'configuring_discovered_dependency'
  | 'resuming'
  | 'restarting'
  | 'accepting_continuation'
  | 'rejecting_continuation'
  | 'removing';

type DependencySummary = OperatorWorkflowProjection['dependencies'][number];
type TypedResolutionAction = Extract<
  OperatorInterventionAction,
  { readonly kind: 'typed_resolution' }
>;
type DependencyAvailableDetails = Extract<
  NonNullable<TypedResolutionAction['details']>,
  { readonly kind: 'dependency_available' }
>;
type DependencyDiscoveryDetails = Extract<
  NonNullable<TypedResolutionAction['details']>,
  { readonly kind: 'dependency_discovery' }
>;
type TaskDependencyDraft = {
  readonly producerTaskReference: string;
  readonly producerRepository: string;
  readonly packages: string;
  readonly mode: 'final_only';
  readonly linkId: string;
  readonly linkTypeId: string;
  readonly direction: 'inward' | 'outward';
};
type DependencyProvenanceDraft = {
  readonly postId: string;
  readonly url: string;
};

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

const parsePackageLines = (value: string): string[] =>
  value
    .split(/[\n,]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

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
  <Badge
    variant="outline"
    className={cn('h-5 border-transparent px-1.5 text-[11px] font-medium', className)}
  >
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

type JiraTaskLaunchInput = {
  readonly issueKey: string;
  readonly repository: string;
  readonly startImmediately: boolean;
  readonly settings: RunStartCommand['settings'];
};

type JiraLaunchIssuePreview =
  | { readonly status: 'idle' }
  | { readonly status: 'checking'; readonly issueKey: string }
  | { readonly status: 'invalid'; readonly issueKey: string; readonly message: string }
  | { readonly status: 'ready'; readonly issue: JiraIssueSnapshot };

export const JiraTaskLaunchDialog = ({
  open,
  repositories,
  pending,
  error,
  mode = 'add',
  initialIssue,
  initialRepository = '',
  onClose,
  onResolveIssue,
  onSubmit,
}: {
  readonly open: boolean;
  readonly repositories: readonly RepositoryCatalogEntry[];
  readonly pending: boolean;
  readonly error: string | null;
  readonly mode?: 'add' | 'start';
  readonly initialIssue?: JiraIssueSnapshot;
  readonly initialRepository?: string;
  readonly onClose: () => void;
  readonly onResolveIssue: (issueKey: string) => Promise<JiraIssueSnapshot>;
  readonly onSubmit: (input: JiraTaskLaunchInput) => Promise<void>;
}) => {
  const [issueKey, setIssueKey] = useState(initialIssue?.issueKey ?? '');
  const [issuePreview, setIssuePreview] = useState<JiraLaunchIssuePreview>(
    initialIssue === undefined ? { status: 'idle' } : { status: 'ready', issue: initialIssue },
  );
  const [branchName, setBranchName] = useState(
    initialIssue === undefined ? '' : taskBranchName(initialIssue.issueKey, initialIssue.summary),
  );
  const [repository, setRepository] = useState(initialRepository);
  const [startImmediately, setStartImmediately] = useState(mode === 'start');
  const [planningStrategy, setPlanningStrategy] = useState<PlanningStrategyRequest>('auto');
  const [requirePlanReview, setRequirePlanReview] = useState(true);
  const [updateJiraStatuses, setUpdateJiraStatuses] = useState(true);
  const previewSequence = useRef(0);

  useEffect(() => {
    if (!open) return;
    const normalized = issueKey.trim().toUpperCase();
    if (initialIssue !== undefined && normalized === initialIssue.issueKey) return;
    const sequence = previewSequence.current + 1;
    previewSequence.current = sequence;
    setBranchName('');
    if (normalized.length === 0) {
      setIssuePreview({ status: 'idle' });
      return;
    }
    if (!/^[A-Z][A-Z0-9]*-\d+$/u.test(normalized)) {
      setIssuePreview({
        status: 'invalid',
        issueKey: normalized,
        message: 'Enter a Jira key such as FC-2244.',
      });
      return;
    }
    setIssuePreview({ status: 'checking', issueKey: normalized });
    const timer = window.setTimeout(() => {
      void onResolveIssue(normalized)
        .then((issue) => {
          if (previewSequence.current !== sequence) return;
          setIssuePreview({ status: 'ready', issue });
          setBranchName(taskBranchName(issue.issueKey, issue.summary));
        })
        .catch((resolutionError: unknown) => {
          if (previewSequence.current !== sequence) return;
          setIssuePreview({
            status: 'invalid',
            issueKey: normalized,
            message:
              resolutionError instanceof Error
                ? resolutionError.message
                : 'Jira task could not be loaded.',
          });
        });
    }, 400);
    return () => {
      window.clearTimeout(timer);
    };
  }, [initialIssue, issueKey, onResolveIssue, open]);

  if (!open) return null;

  const normalizedIssueKey = issueKey.trim().toUpperCase();
  const issueReady =
    issuePreview.status === 'ready' && issuePreview.issue.issueKey === normalizedIssueKey;
  const branchValid = issueReady && taskBranchNameMatches(branchName, normalizedIssueKey);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <form
        className="w-full max-w-md rounded-xl border border-border bg-background p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="jira-task-launch-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (
            !issueReady ||
            pending ||
            (startImmediately && (!branchValid || repository.length === 0))
          ) {
            return;
          }
          void onSubmit({
            issueKey: normalizedIssueKey,
            repository,
            startImmediately,
            settings: {
              planReview: requirePlanReview ? 'required' : 'automatic',
              planningStrategy,
              trackerStatusUpdates: updateJiraStatuses ? 'enabled' : 'disabled',
              branchName,
            },
          })
            .then(() => {
              setIssueKey('');
              setIssuePreview({ status: 'idle' });
              setBranchName('');
              setRepository('');
              setPlanningStrategy('auto');
              setRequirePlanReview(true);
              setUpdateJiraStatuses(true);
              onClose();
            })
            .catch(() => undefined);
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="jira-task-launch-title" className="text-base font-semibold">
              {mode === 'start' ? 'Task settings' : 'Add Jira task'}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {mode === 'start'
                ? 'Review the workspace and planning settings before starting work.'
                : 'Add an existing Jira issue to Tasker, with optional immediate start.'}
            </p>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            type="button"
            aria-label="Close task launch dialog"
            disabled={pending}
            onClick={onClose}
          >
            <X />
          </Button>
        </div>

        <div className="mt-5 space-y-4">
          <label className="block space-y-1.5 text-xs font-medium">
            Jira task
            <input
              autoFocus
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm uppercase outline-none placeholder:normal-case placeholder:text-muted-foreground focus:border-ring"
              aria-label="Jira task"
              placeholder="FC-2244"
              value={issueKey}
              disabled={pending || mode === 'start'}
              onChange={(event) => {
                setIssueKey(event.target.value);
              }}
            />
            {issuePreview.status === 'checking' ? (
              <span className="block text-[11px] text-muted-foreground">Checking Jira…</span>
            ) : null}
            {issuePreview.status === 'invalid' ? (
              <span className="block text-[11px] text-destructive">{issuePreview.message}</span>
            ) : null}
            {issueReady ? (
              <span className="block text-[11px] leading-4 text-muted-foreground">
                {issuePreview.issue.summary}
              </span>
            ) : null}
          </label>

          <label className="block space-y-1.5 text-xs font-medium">
            Working repository
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-ring"
              aria-label="Repository"
              value={repository}
              disabled={pending}
              onChange={(event) => {
                setRepository(event.target.value);
              }}
            >
              <option value="">Select when starting work</option>
              {repositories.map((entry) => (
                <option
                  key={`${entry.repositoryId}:${entry.remoteUrl ?? entry.checkout.path}`}
                  value={entry.repositoryId}
                >
                  {entry.repositoryId}
                </option>
              ))}
            </select>
            <span className="block text-[11px] font-normal text-muted-foreground">
              Tasker creates the task worktree here. It is required only when work starts.
            </span>
          </label>

          {mode === 'add' ? (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-muted/20 p-3 text-sm">
              <input
                className="mt-0.5 size-4 accent-primary"
                type="checkbox"
                aria-label="Start immediately"
                checked={startImmediately}
                disabled={pending}
                onChange={(event) => {
                  setStartImmediately(event.target.checked);
                }}
              />
              <span>
                <span className="block font-medium">Start immediately</span>
                <span className="block text-xs text-muted-foreground">
                  Create the worktree and begin read-only planning after the task is added.
                </span>
              </span>
            </label>
          ) : null}

          {startImmediately ? (
            <label className="block space-y-1.5 text-xs font-medium">
              Branch name
              <input
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground focus:border-ring"
                aria-label="Branch name"
                placeholder="Loaded from the Jira task title"
                value={branchName}
                disabled={pending || !issueReady}
                onChange={(event) => {
                  setBranchName(event.target.value);
                }}
              />
              {issueReady && !branchValid ? (
                <span className="block text-[11px] text-destructive">
                  Branch must start with {normalizedIssueKey} and be a valid Git branch name.
                </span>
              ) : null}
            </label>
          ) : null}

          {startImmediately ? (
            <label className="block space-y-1.5 text-xs font-medium">
              Planning strategy
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-ring"
                aria-label="Planning strategy"
                value={planningStrategy}
                disabled={pending}
                onChange={(event) => {
                  setPlanningStrategy(event.target.value as PlanningStrategyRequest);
                }}
              >
                <option value="auto">Auto</option>
                <option value="fast">Fast</option>
                <option value="ralplan">Ralplan</option>
              </select>
            </label>
          ) : null}

          {startImmediately ? (
            <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
              <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                <input
                  className="mt-0.5 size-4 accent-primary"
                  type="checkbox"
                  checked={requirePlanReview}
                  disabled={pending}
                  onChange={(event) => {
                    setRequirePlanReview(event.target.checked);
                  }}
                />
                <span>
                  <span className="block font-medium">Review plan before execution</span>
                  <span className="block text-xs text-muted-foreground">
                    Pause after planning for explicit approval.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                <input
                  className="mt-0.5 size-4 accent-primary"
                  type="checkbox"
                  aria-label="Update Jira statuses"
                  checked={updateJiraStatuses}
                  disabled={pending}
                  onChange={(event) => {
                    setUpdateJiraStatuses(event.target.checked);
                  }}
                />
                <span>
                  <span className="block font-medium">Update Jira statuses</span>
                  <span className="block text-xs text-muted-foreground">
                    Try In Progress and Code Review transitions. Failure never blocks
                    implementation, evidence, or comments.
                  </span>
                </span>
              </label>
            </div>
          ) : null}
        </div>

        {error === null ? null : <p className="mt-3 text-xs text-destructive">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" type="button" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              pending ||
              !issueReady ||
              (startImmediately && (!branchValid || repository.length === 0))
            }
          >
            {pending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
            {pending
              ? startImmediately
                ? 'Starting…'
                : 'Adding…'
              : mode === 'start'
                ? 'Start task'
                : startImmediately
                  ? 'Add and start'
                  : 'Add task'}
          </Button>
        </div>
      </form>
    </div>
  );
};

export const RemoveTaskDialog = ({
  task,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  readonly task: OperatorTaskSummary;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) => {
  const [confirmation, setConfirmation] = useState('');
  const active = task.status !== 'backlog' && task.status !== 'done';
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-xl border border-destructive/40 bg-background p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-task-title"
      >
        <h2 id="remove-task-title" className="text-base font-semibold">
          {active ? 'Stop and remove task' : 'Remove task from Tasker'}
        </h2>
        <p className="mt-2 text-sm leading-5 text-muted-foreground">
          {active
            ? 'Tasker will terminate the active workflow and remove its managed containers, volumes, worktree, and local branch.'
            : 'Tasker will hide this task and remove any remaining managed workspace resources.'}{' '}
          Jira, remote branches, and pull requests are not deleted.
        </p>
        <label className="mt-4 block space-y-1.5 text-xs font-medium">
          Type {task.taskId} to confirm
          <input
            autoFocus
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono text-sm outline-none focus:border-ring"
            aria-label="Removal confirmation"
            value={confirmation}
            disabled={pending}
            onChange={(event) => {
              setConfirmation(event.target.value.toUpperCase());
            }}
          />
        </label>
        {error === null ? null : <p className="mt-3 text-xs text-destructive">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" type="button" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            type="button"
            disabled={pending || confirmation !== task.taskId}
            onClick={onConfirm}
          >
            {pending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
            {pending ? 'Removing…' : active ? 'Stop and remove' : 'Remove task'}
          </Button>
        </div>
      </div>
    </div>
  );
};

const TaskQueue = ({
  tasks,
  repositories,
  selectedId,
  onSelect,
  onResolveJiraIssue,
  onAddJira,
  jiraSync,
  liveStatus,
}: {
  readonly tasks: readonly OperatorTaskSummary[];
  readonly repositories: readonly RepositoryCatalogEntry[];
  readonly selectedId: string;
  readonly onSelect: (taskId: string) => void;
  readonly onResolveJiraIssue: (issueKey: string) => Promise<JiraIssueSnapshot>;
  readonly onAddJira: (input: JiraTaskLaunchInput) => Promise<void>;
  readonly jiraSync: JiraSyncState;
  readonly liveStatus: ConsoleStreamStatus;
}) => {
  const [importOpen, setImportOpen] = useState(false);
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
                aria-label="Add Jira task"
                onClick={() => {
                  setImportOpen((open) => !open);
                }}
              >
                <Plus className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Add Jira task</TooltipContent>
            </Tooltip>
          </div>
        </div>
        {importOpen ? (
          <JiraTaskLaunchDialog
            open
            repositories={repositories}
            pending={jiraSync.status === 'syncing'}
            error={jiraSync.status === 'failed' ? jiraSync.message : null}
            onClose={() => {
              setImportOpen(false);
            }}
            onResolveIssue={onResolveJiraIssue}
            onSubmit={onAddJira}
          />
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
  onOpenSettings,
  onRemove,
  onSyncJira,
  pendingOperation,
  jiraSync,
}: {
  readonly task: OperatorTaskSummary;
  readonly workflow: WorkflowLoadState;
  readonly activity: ActivityLoadState;
  readonly onOpenSettings: () => void;
  readonly onRemove: () => void;
  readonly onSyncJira: (issueKey: string) => void;
  readonly pendingOperation: TaskOperation | null;
  readonly jiraSync: JiraSyncState;
}) => {
  const generating = pendingOperation === 'generating';
  const canStart =
    (task.status === 'backlog' || task.status === 'workflow_rejected') &&
    task.planning.status === 'available';

  return (
    <section
      className="sticky top-0 z-30 border-b border-border bg-background px-5 py-3.5"
      data-testid="selected-task"
    >
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
          {canStart ? (
            <Button size="sm" type="button" onClick={onOpenSettings} disabled={generating}>
              {generating ? (
                <LoaderCircle data-icon="inline-start" className="animate-spin" />
              ) : (
                <Sparkles data-icon="inline-start" />
              )}
              {generating ? 'Starting…' : 'Start task'}
            </Button>
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
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={pendingOperation === 'removing'}
              onClick={onRemove}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 data-icon="inline-start" />
              Remove
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
  const retriesStep = action.kind === 'retry_step';
  return (
    <section className="border-b border-amber-500/20 bg-amber-500/4 px-5 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <strong className="text-sm">
            {acceptsGuidance
              ? 'Guidance required'
              : retriesStep
                ? 'Retry required'
                : 'Prerequisite required'}
          </strong>
          <p className="mt-1 max-w-4xl text-sm leading-5 text-foreground/90">{stage}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {acceptsGuidance
              ? 'Tell the agent what changed or how to approach the same step. Completed work will not repeat.'
              : retriesStep
                ? 'Automatic retries were exhausted. Retry the same step without additional guidance.'
                : 'Fix the prerequisite, then click Resume. Completed work will not repeat.'}
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
            {pending ? 'Working…' : retriesStep ? 'Retry step' : 'Resume'}
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

export const DependencyWaitSurface = ({
  details,
  pending,
  restartConfirming,
  versions,
  provenance,
  discoveryDraft,
  onVersionChange,
  onProvenanceChange,
  onDiscoveryDraftChange,
  onSubmit,
  onRestartRequest,
  onRestartCancel,
  onRestartConfirm,
}: {
  readonly details: DependencyAvailableDetails | DependencyDiscoveryDetails;
  readonly pending: boolean;
  readonly restartConfirming: boolean;
  readonly versions: ReadonlyMap<string, string>;
  readonly provenance: DependencyProvenanceDraft;
  readonly discoveryDraft: TaskDependencyDraft;
  readonly onVersionChange: (packageName: string, version: string) => void;
  readonly onProvenanceChange: (draft: DependencyProvenanceDraft) => void;
  readonly onDiscoveryDraftChange: (draft: TaskDependencyDraft) => void;
  readonly onSubmit: () => void;
  readonly onRestartRequest: () => void;
  readonly onRestartCancel: () => void;
  readonly onRestartConfirm: () => void;
}) => {
  const title =
    details.kind === 'dependency_available' ? 'Published versions' : 'Configure dependency';
  const actionLabel =
    details.kind === 'dependency_available' ? 'Verify published versions' : 'Configure dependency';
  return (
    <section className="border-b border-cyan-500/20 bg-cyan-500/4 px-5 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <strong className="text-sm">{title}</strong>
          <p className="mt-1 max-w-4xl text-sm leading-5 text-foreground/90">
            {details.kind === 'dependency_available'
              ? 'Verify the exact published versions in Nexus before Tasker rechecks the dependency.'
              : 'Persist the discovered cross-repository dependency before Tasker continues.'}
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
          <Button size="sm" type="button" disabled={pending} onClick={onSubmit}>
            {pending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
            {pending ? 'Working…' : actionLabel}
          </Button>
        </div>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-border/70 bg-background/60 p-3 text-sm">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Status
          </div>
          <dl className="mt-2 space-y-1">
            {details.kind === 'dependency_available' ? (
              <>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Declaration</dt>
                  <dd>
                    {details.declarationId} rev {String(details.declarationRevision)}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Channel</dt>
                  <dd>{details.channel}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Result status</dt>
                  <dd>
                    {details.observation.status === 'recorded'
                      ? 'Verified publication recorded'
                      : 'Waiting for published versions'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Provenance</dt>
                  <dd>
                    {details.observation.provenance === null
                      ? 'None recorded'
                      : `Loop ${details.observation.provenance.postId}`}
                  </dd>
                </div>
              </>
            ) : (
              <>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Requested repository</dt>
                  <dd>{details.requestedRepository}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Requested outcome</dt>
                  <dd>{details.requestedOutcome}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Component path</dt>
                  <dd>{details.componentPath ?? 'Not specified'}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Declaration</dt>
                  <dd>
                    {details.declaration.status === 'recorded'
                      ? `${details.declaration.declarationId} rev ${String(details.declaration.declarationRevision)}`
                      : 'Not persisted yet'}
                  </dd>
                </div>
              </>
            )}
          </dl>
        </div>
        <div className="rounded-md border border-border/70 bg-background/60 p-3 text-sm">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Packages
          </div>
          {details.kind === 'dependency_available' ? (
            <div className="mt-2 space-y-2">
              {details.packages.map((packageName) => (
                <label key={packageName} className="block">
                  <span className="mb-1 block text-xs text-muted-foreground">{packageName}</span>
                  <input
                    className="w-full rounded-md border border-input bg-background/60 px-2.5 py-2 text-sm outline-none focus:border-ring"
                    aria-label={`${packageName} version`}
                    placeholder="1.2.3 or 1.2.3-dev.4"
                    value={versions.get(packageName) ?? ''}
                    disabled={pending}
                    onChange={(event) => {
                      onVersionChange(packageName, event.target.value);
                    }}
                  />
                </label>
              ))}
              <div className="grid gap-2 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs text-muted-foreground">Loop post ID</span>
                  <input
                    className="w-full rounded-md border border-input bg-background/60 px-2.5 py-2 text-sm outline-none focus:border-ring"
                    aria-label="Loop post ID"
                    placeholder="Optional"
                    value={provenance.postId}
                    disabled={pending}
                    onChange={(event) => {
                      onProvenanceChange({ ...provenance, postId: event.target.value });
                    }}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-muted-foreground">Loop URL</span>
                  <input
                    className="w-full rounded-md border border-input bg-background/60 px-2.5 py-2 text-sm outline-none focus:border-ring"
                    aria-label="Loop URL"
                    placeholder="https://…"
                    value={provenance.url}
                    disabled={pending}
                    onChange={(event) => {
                      onProvenanceChange({ ...provenance, url: event.target.value });
                    }}
                  />
                </label>
              </div>
            </div>
          ) : (
            <div className="mt-2 grid gap-2">
              <input
                className="rounded-md border border-input bg-background/60 px-2.5 py-2 text-sm outline-none focus:border-ring"
                aria-label="Discovered producer task reference"
                placeholder={details.declaration.producerTaskReference ?? 'Producer task reference'}
                value={discoveryDraft.producerTaskReference}
                disabled={pending}
                onChange={(event) => {
                  onDiscoveryDraftChange({
                    ...discoveryDraft,
                    producerTaskReference: event.target.value,
                  });
                }}
              />
              <textarea
                className="min-h-20 resize-y rounded-md border border-input bg-background/60 px-2.5 py-2 text-sm outline-none focus:border-ring"
                aria-label="Discovered dependency packages"
                placeholder={
                  details.declaration.packages.length === 0
                    ? (details.expectedPackage ?? 'One package per line')
                    : details.declaration.packages.join('\n')
                }
                value={discoveryDraft.packages}
                disabled={pending}
                onChange={(event) => {
                  onDiscoveryDraftChange({ ...discoveryDraft, packages: event.target.value });
                }}
              />
              <p className="text-xs text-muted-foreground">
                Expected package boundary:{' '}
                {details.expectedPackage ?? 'Operator must supply the package list'}
              </p>
            </div>
          )}
        </div>
      </div>
      {details.kind === 'dependency_available' && details.observation.status === 'recorded' ? (
        <div className="mt-3 rounded-md border border-emerald-500/20 bg-emerald-500/6 p-3 text-sm">
          <div className="flex justify-between gap-4">
            <strong className="text-emerald-800 dark:text-emerald-200">Recorded observation</strong>
            <span className="text-xs text-muted-foreground">
              {formatShortDateTime(details.observation.observedAt)}
            </span>
          </div>
          <ul className="mt-2 space-y-1">
            {details.observation.packages.map((entry) => (
              <li key={`${entry.name}@${entry.version}`}>
                {entry.name}@{entry.version}
              </li>
            ))}
          </ul>
        </div>
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

export const TaskDependencyPanel = ({
  dependencies,
}: {
  readonly dependencies: readonly DependencySummary[];
}) => {
  if (dependencies.length === 0) return null;

  return (
    <section className="border-b border-border px-5 py-4" aria-label="Task dependencies">
      <div>
        <strong className="text-sm">Package dependencies</strong>
        <p className="mt-1 text-sm text-foreground/90">
          Exact external versions already declared for this task.
        </p>
      </div>
      <div className="mt-3 space-y-2">
        {dependencies.map((dependency) => (
          <div
            key={dependency.declarationId}
            className="rounded-md border border-border/70 bg-background/60 p-3 text-sm"
          >
            <div className="flex items-center justify-between gap-3">
              <strong>
                {dependency.packages.join(', ')} from{' '}
                {dependency.producerTaskReference.replace(/^jira:/u, '')}
              </strong>
              <Badge variant="outline">Exact version</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Repository {dependency.producerRepository} · recorded{' '}
              {formatShortDateTime(dependency.createdAt)}
            </p>
          </div>
        ))}
      </div>
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
          fullscreen || annotations.length > 0 || history.length > 0 || selection !== null
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
        {fullscreen || annotations.length > 0 || history.length > 0 || selection !== null ? (
          <aside
            className="min-h-0 overflow-y-auto border-l border-border bg-muted/15 p-4"
            aria-label="Plan annotations"
          >
            <div className="flex items-center justify-between gap-2">
              <strong className="text-sm">Plan feedback</strong>
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
        <CollapsibleContent className="border-t border-border/60">
          {document}
          {history.length === 0 ? null : (
            <section className="border-t border-border px-5 py-4" aria-label="Plan review history">
              <strong className="text-sm">Review history</strong>
              <ol className="mt-3 space-y-2 text-xs">
                {history.map((round) => (
                  <li className="rounded-md bg-muted/40 p-3" key={round.reviewId}>
                    <div className="flex justify-between gap-2">
                      <span>Attempt {round.planAttempt}</span>
                      <StateBadge>{round.decision.replace('_', ' ')}</StateBadge>
                    </div>
                    {round.guidance === null ? null : (
                      <p className="mt-2 leading-5">{round.guidance}</p>
                    )}
                    {round.annotations.length === 0 ? null : (
                      <ol className="mt-2 space-y-2">
                        {round.annotations.map((annotation, index) => (
                          <li className="border-l-2 border-border pl-2" key={annotation.id}>
                            <p className="text-muted-foreground">{annotation.quote}</p>
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
            </section>
          )}
        </CollapsibleContent>
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
            <div className="pr-2">
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

const RetrospectiveSurface = ({
  retrospective,
}: {
  readonly retrospective: RetrospectiveLoadState;
}) => {
  if (retrospective.status === 'loading' || retrospective.status === 'pending') {
    return (
      <section className="border-y border-border bg-muted/5 px-5 py-3 text-sm text-muted-foreground">
        Retrospective is running…
      </section>
    );
  }
  if (retrospective.status === 'failed') return <InlineError>{retrospective.message}</InlineError>;
  const report = retrospective.response.report;
  return (
    <Collapsible defaultOpen>
      <section className="border-y border-border bg-muted/5">
        <CollapsibleTrigger className="group flex w-full items-center justify-between bg-muted/10 px-5 py-3 text-left hover:bg-muted/30">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Retrospective</span>
            <StateBadge>{`${String(report.proposals.length)} proposals`}</StateBadge>
          </div>
          <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-4 border-t border-border/60 px-5 py-4 text-sm">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{report.metrics.attempts} attempts</span>
              <span>{report.metrics.blockedAttempts} recoveries</span>
              <span>{report.metrics.inputTokens.toLocaleString()} measured input tokens</span>
              <span>~${report.metrics.estimatedCostUsd.toFixed(2)} API</span>
            </div>
            {report.findings.map((finding) => (
              <div key={`${finding.kind}:${finding.title}`}>
                <strong className="text-sm">{finding.title}</strong>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{finding.detail}</p>
              </div>
            ))}
            {report.proposals.length === 0 ? (
              <p className="text-xs text-muted-foreground">No harness changes proposed.</p>
            ) : (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Proposed improvements · review required
                </p>
                <ul className="space-y-2">
                  {report.proposals.map((proposal) => (
                    <li key={proposal.id} className="border-l-2 border-primary/40 pl-3">
                      <strong className="text-sm">{proposal.title}</strong>
                      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                        {proposal.rationale}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </section>
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
      {current.status === 'waiting' ||
      latestAttempt === null ||
      latestAttempt.events.length === 0 ? null : (
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

const runLogEntryId = (nodeId: string, blockRun: number): string =>
  `run-log-${nodeId.replace(/[^a-zA-Z0-9_-]/gu, '-')}-${String(blockRun)}`;

export const compactCommand = (command: string): string =>
  command
    .replace(/^\/usr\/bin\/bash\s+-lc\s+/u, '')
    .replace(
      /\/Users\/[^/]+\/Library\/Application Support\/Tasker\/worktrees\/[a-f0-9]+/gu,
      '$WORKSPACE',
    )
    .replace(
      /\/Users\/[^/]+\/Library\/Application Support\/Tasker\/step-data\/scratch\/[a-f0-9]+/gu,
      '$SCRATCH',
    )
    .replace(
      /\/Users\/[^/]+\/Library\/Application Support\/Tasker\/step-data\/artifacts\/[a-f0-9]+/gu,
      '$ARTIFACTS',
    )
    .replace(
      /\/var\/folders\/[^\s'"/]+(?:\/[^\s'"/]+)*\/tasker-step-agent-[^\s'"/]+\/provider-home\/skills/gu,
      '$SKILLS',
    )
    .replace(/\s+/gu, ' ')
    .trim();

const RunLogSurface = ({
  state,
  planning,
  open,
  focusedAttempt,
  onOpenChange,
}: {
  readonly state: RunLogLoadState;
  readonly planning: ImplementationPlanLoadState;
  readonly open: boolean;
  readonly focusedAttempt: { readonly nodeId: string; readonly blockRun: number } | null;
  readonly onOpenChange: (open: boolean) => void;
}) => {
  useEffect(() => {
    if (!open || focusedAttempt === null || state.status !== 'ready') return;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(runLogEntryId(focusedAttempt.nodeId, focusedAttempt.blockRun))
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [focusedAttempt, open, state]);

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
  const planningRecord = planning.status === 'ready' ? planning.record : null;
  const plannerReceipt =
    planningRecord === null || planningRecord.status === 'planning' ? null : planningRecord.receipt;
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
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
            <div className="divide-y divide-border" data-testid="run-log-transcript">
              {state.response.entries.map((entry) => {
                const parsed = planningAgentLogFromRaw(entry.rawLog);
                const events = parsed.attempts.flatMap((attempt) => attempt.events);
                const investigationCommandCount = events.filter(
                  (event) => event.kind === 'command',
                ).length;
                const entryTokens =
                  entry.usage === null ? null : entry.usage.inputTokens + entry.usage.outputTokens;
                const focused =
                  focusedAttempt?.nodeId === entry.nodeId &&
                  focusedAttempt.blockRun === entry.blockRun;
                return (
                  <article
                    className={cn(
                      'scroll-m-24 px-5 py-4 transition-colors',
                      focused && 'border-l-2 border-primary bg-primary/5 pl-[18px]',
                    )}
                    id={runLogEntryId(entry.nodeId, entry.blockRun)}
                    key={entry.id}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <strong className="text-sm">
                            {entry.runtime === 'bootstrap' && entry.runner === 'planner'
                              ? 'Planning'
                              : entry.reference.replaceAll('.', ' ')}
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

                    {entry.runtime === 'bootstrap' && entry.runner === 'planner' ? (
                      <div className="mt-3 rounded-md border border-border/70 bg-muted/20 p-3 text-xs">
                        <div className="flex items-center justify-between gap-3">
                          <strong className="font-medium">Planner input</strong>
                          <a
                            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                            href={`/api/workflows/${encodeURIComponent(state.response.taskReference)}/planner-input`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View input JSON
                            <ExternalLink className="size-3" />
                          </a>
                        </div>
                        <p className="mt-1 leading-5 text-muted-foreground">
                          Tasker sent the Jira task, repository evidence, project rules, available
                          workflow steps, and the required result format. The planner had read-only
                          repository access.
                        </p>
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
                          {plannerReceipt === null ? null : (
                            <span>Prompt {plannerReceipt.promptHash.slice(0, 8)}</span>
                          )}
                          {planningRecord?.planningSnapshot === null ||
                          planningRecord?.planningSnapshot === undefined ? null : (
                            <span>
                              Context {planningRecord.planningSnapshot.checksum.slice(0, 8)}
                            </span>
                          )}
                          {planningRecord === null ? null : (
                            <span>Evidence r{String(planningRecord.evidenceBundle.revision)}</span>
                          )}
                        </div>
                      </div>
                    ) : null}

                    {events.length === 0 ? null : (
                      <div className="mt-3 divide-y divide-border/50 border-t border-border/60">
                        {entry.runtime === 'bootstrap' &&
                        entry.runner === 'planner' &&
                        investigationCommandCount > 0 ? (
                          <div className="py-2 text-[11px] text-muted-foreground">
                            <strong className="font-medium text-foreground/80">
                              Read-only investigation
                            </strong>{' '}
                            · {String(investigationCommandCount)} commands · expand a command to see
                            its full input and output
                          </div>
                        ) : null}
                        {events.map((event, index) => {
                          if (event.kind === 'command') {
                            return (
                              <details
                                className="group/command py-2"
                                key={`${entry.id}:${event.id}:${String(index)}`}
                                open={event.status === 'running'}
                              >
                                <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
                                  <ChevronDown className="size-3.5 shrink-0 -rotate-90 text-muted-foreground transition-transform group-open/command:rotate-0" />
                                  <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
                                  <code
                                    className="min-w-0 flex-1 truncate text-xs"
                                    title={event.command}
                                  >
                                    {compactCommand(event.command)}
                                  </code>
                                  <span className="shrink-0 text-[10px] text-muted-foreground">
                                    {event.status === 'running'
                                      ? 'running'
                                      : `exit ${String(event.exitCode ?? 0)}`}
                                  </span>
                                </summary>
                                <div className="ml-9 mt-2 space-y-2 text-xs">
                                  <div>
                                    <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                                      Full command
                                    </div>
                                    <pre className="overflow-x-auto rounded-md bg-muted/50 p-3 font-mono text-[11px] leading-5">
                                      {event.command}
                                    </pre>
                                  </div>
                                  {event.output.length === 0 ? null : (
                                    <div>
                                      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                                        Output · {event.output.length.toLocaleString()} characters
                                      </div>
                                      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-3 font-mono text-[11px] leading-5">
                                        {event.output}
                                      </pre>
                                    </div>
                                  )}
                                </div>
                              </details>
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
                      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                        <span>Evidence:</span>
                        {entry.evidence.map(({ artifactId, relativePath }) => (
                          <a
                            className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                            href={`/api/operator/tasks/${encodeURIComponent(state.response.taskReference)}/evidence/${encodeURIComponent(artifactId)}`}
                            key={artifactId}
                            rel="noreferrer"
                            target="_blank"
                          >
                            {relativePath}
                          </a>
                        ))}
                      </div>
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
    if (task?.status === 'done') {
      return (
        <aside className="flex min-h-0 flex-col" aria-label="Current workflow">
          <div className="border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Workflow</h2>
              <StateBadge className="bg-emerald-500/12 text-emerald-700 dark:text-emerald-300">
                complete
              </StateBadge>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Tasker work is complete. The durable retrospective remains available in the task.
            </p>
          </div>
        </aside>
      );
    }
    if (task?.origin.kind === 'jira') {
      const binding = task.origin.repositoryBinding;
      const repositoryResolved = binding.status === 'resolved';
      const jiraSnapshotReady = task.origin.syncStatus === 'current';
      const repositoryLabel = repositoryResolved
        ? binding.repository.repositoryId
        : binding.status === 'missing'
          ? null
          : 'reference' in binding
            ? binding.reference
            : null;
      const readyToStart = jiraSnapshotReady && repositoryResolved;
      const prerequisites = [
        ['Jira task', jiraSnapshotReady ? 'ready' : 'blocked'],
        ['Working repository', repositoryResolved ? 'ready' : 'blocked'],
      ] as const;
      return (
        <aside className="flex min-h-0 flex-col" aria-label="Current workflow">
          <div className="border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Ready to start</h2>
              <StateBadge
                className={
                  readyToStart
                    ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                    : 'bg-amber-500/12 text-amber-700 dark:text-amber-300'
                }
              >
                {readyToStart ? 'ready' : 'needs setup'}
              </StateBadge>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              No Tasker run has started. Review settings when you are ready to create the worktree.
            </p>
          </div>
          <div className="px-4 py-4 text-xs">
            <p className="mb-4 text-[11px] uppercase tracking-wide text-muted-foreground">
              {task.origin.issueKey} · Jira imported
              {repositoryLabel === null ? '' : ` · ${repositoryLabel}`}
            </p>
            <ol className="space-y-1" aria-label="Workflow planning prerequisites">
              {prerequisites.map(([label, status], index) => (
                <li className="relative flex min-h-9 items-start gap-2.5" key={label}>
                  {index === prerequisites.length - 1 ? null : (
                    <span className="absolute bottom-0 left-[5px] top-3 w-px bg-border" />
                  )}
                  <span
                    className={cn(
                      'relative mt-1 size-3 rounded-full border-2 border-background',
                      status === 'ready' ? 'bg-cyan-400' : 'bg-amber-400',
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
                    ? 'Open Task settings to review the branch and planning options, then start work.'
                    : 'Choose the working repository in Task settings before starting.'}
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
        <WorkflowStages
          stages={projection.projection.stages}
          continuation={projection.projection.continuations.at(-1) ?? null}
          onSelectAttempt={onSelectAttempt}
        />
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
  const [runLogOpen, setRunLogOpen] = useState(true);
  const [focusedRunLogAttempt, setFocusedRunLogAttempt] = useState<{
    readonly nodeId: string;
    readonly blockRun: number;
  } | null>(null);
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
  const [retrospectiveState, setRetrospectiveState] = useState<RetrospectiveLoadState>({
    status: 'pending',
  });
  const [codeReviewNotices, setCodeReviewNotices] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [streamStatus, setStreamStatus] = useState<ConsoleStreamStatus>('connecting');
  const [runtimeWatchTaskId, setRuntimeWatchTaskId] = useState<string | null>(null);
  const [restartConfirmationTaskId, setRestartConfirmationTaskId] = useState<string | null>(null);
  const [launchSettingsTaskId, setLaunchSettingsTaskId] = useState<string | null>(null);
  const [removeConfirmationTaskId, setRemoveConfirmationTaskId] = useState<string | null>(null);
  const [taskRemovalError, setTaskRemovalError] = useState<string | null>(null);
  const [pendingOperations, setPendingOperations] = useState<ReadonlyMap<string, TaskOperation>>(
    new Map(),
  );
  const [planGuidanceDrafts, setPlanGuidanceDrafts] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [continuationGuidanceDrafts, setContinuationGuidanceDrafts] = useState<
    ReadonlyMap<string, string>
  >(new Map());
  const [taskDependencyDrafts, setTaskDependencyDrafts] = useState<
    ReadonlyMap<string, TaskDependencyDraft>
  >(new Map());
  const [dependencyVersionDrafts, setDependencyVersionDrafts] = useState<
    ReadonlyMap<string, ReadonlyMap<string, string>>
  >(new Map());
  const [dependencyProvenanceDrafts, setDependencyProvenanceDrafts] = useState<
    ReadonlyMap<string, DependencyProvenanceDraft>
  >(new Map());
  const [interventionGuidanceDrafts, setInterventionGuidanceDrafts] = useState<
    ReadonlyMap<string, string>
  >(new Map());
  const [planningAnswerDrafts, setPlanningAnswerDrafts] = useState<
    ReadonlyMap<string, ReadonlyMap<string, string>>
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
  const selectedTypedResolution =
    operatorProjectionState.status === 'ready' &&
    operatorProjectionState.projection.current?.status === 'waiting' &&
    operatorProjectionState.projection.current.intervention.kind === 'typed_resolution'
      ? operatorProjectionState.projection.current.intervention
      : null;
  const selectedDependencyWait =
    selectedTypedResolution?.details?.kind === 'dependency_available' ||
    selectedTypedResolution?.details?.kind === 'dependency_discovery'
      ? selectedTypedResolution.details
      : null;
  const selectedIntervention =
    operatorProjectionState.status === 'ready' &&
    operatorProjectionState.projection.current?.status === 'waiting' &&
    operatorProjectionState.projection.current.intervention.kind !== 'typed_resolution'
      ? operatorProjectionState.projection.current.intervention
      : null;
  const selectedDependencies =
    operatorProjectionState.status === 'ready'
      ? operatorProjectionState.projection.dependencies
      : [];
  const selectedWorkflowContinuation =
    operatorProjectionState.status === 'ready'
      ? (operatorProjectionState.projection.continuations.findLast(
          ({ status }) => status === 'awaiting_review',
        ) ?? null)
      : null;
  const linkedProducerTask =
    jiraIssueState.status === 'ready' && jiraIssueState.state.status !== 'unavailable'
      ? (jiraIssueState.state.issue.links.find(
          (link) =>
            link.linkTypeName.toLocaleLowerCase('en-US') === 'blocks' &&
            link.direction === 'inward',
        )?.issueKey ?? null)
      : null;
  const selectedTaskDependencyDraft =
    selectedTask === null
      ? null
      : (taskDependencyDrafts.get(selectedTask.id) ?? {
          producerTaskReference:
            selectedDependencyWait?.kind === 'dependency_discovery'
              ? (selectedDependencyWait.declaration.producerTaskReference ??
                (linkedProducerTask === null ? '' : `jira:${linkedProducerTask}`))
              : '',
          producerRepository:
            selectedDependencyWait?.kind === 'dependency_discovery'
              ? selectedDependencyWait.requestedRepository
              : '',
          packages:
            selectedDependencyWait?.kind === 'dependency_discovery'
              ? selectedDependencyWait.declaration.packages.length > 0
                ? selectedDependencyWait.declaration.packages.join('\n')
                : (selectedDependencyWait.expectedPackage ?? '')
              : '',
          mode: 'final_only',
          linkId: '',
          linkTypeId: '',
          direction: 'outward',
        });
  const selectedDependencyVersions =
    selectedTask === null
      ? new Map<string, string>()
      : (dependencyVersionDrafts.get(selectedTask.id) ?? new Map<string, string>());
  const selectedDependencyProvenance =
    selectedTask === null
      ? { postId: '', url: '' }
      : (dependencyProvenanceDrafts.get(selectedTask.id) ?? { postId: '', url: '' });

  useEffect(() => {
    if (selectedTask?.status !== 'done') {
      setRetrospectiveState({ status: 'pending' });
      return;
    }
    let active = true;
    setRetrospectiveState({ status: 'loading' });
    void loadRetrospective(selectedTask.id)
      .then((response) => {
        if (!active) return;
        setRetrospectiveState(
          response.status === 'ready' ? { status: 'ready', response } : { status: 'pending' },
        );
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRetrospectiveState({
          status: 'failed',
          message: error instanceof Error ? error.message : 'Retrospective is unavailable',
        });
      });
    return () => {
      active = false;
    };
  }, [selectedTask?.id, selectedTask?.status]);

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
          const workflowChangeReview = projection.current?.waitKind === 'workflow_change.review@1';
          return {
            ...task,
            status: planReview ? 'plan_review' : codeReview ? 'code_review' : 'waiting',
            attention: 'operator',
            currentStage: workflowChangeReview
              ? 'Review proposed workflow change'
              : (projection.current?.reason ?? 'Waiting for operator action'),
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
    setFocusedRunLogAttempt(null);
    setRunLogOpen(true);
    setSelectedId(taskId);
    void refreshSelection(taskId);
  };

  const handleSelectExecutionAttempt = (step: OperatorWorkflowStep, blockRun: number): void => {
    if (selectedIdRef.current.length === 0 || step.kind === 'wait') return;
    setRunLogOpen(true);
    setFocusedRunLogAttempt({ nodeId: step.id, blockRun });
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

  const handleResolveJiraIssue = useCallback(
    (issueKey: string): Promise<JiraIssueSnapshot> => previewJiraIssue(issueKey),
    [],
  );

  const handleJiraAdd = async (input: JiraTaskLaunchInput): Promise<void> => {
    const issueKey = input.issueKey.trim().toUpperCase();
    if (issueKey.length === 0) return;
    let taskReference = `jira:${issueKey}`;
    setJiraSyncState({ status: 'syncing', issueKey });
    try {
      const state = await syncJiraIssue(
        issueKey,
        input.repository.length === 0 ? undefined : input.repository,
      );
      const normalizedKey = state.status === 'unavailable' ? state.issueKey : state.issue.issueKey;
      taskReference = `jira:${normalizedKey}`;
      await restoreOperatorTask(taskReference);
      if (input.startImmediately) {
        setRuntimeWatchTaskId(taskReference);
        setPendingOperations((current) => new Map(current).set(taskReference, 'generating'));
        await generateWorkflow(taskReference, { settings: input.settings });
      }
      await refreshTasks();
      setSelectedId(taskReference);
      await refreshSelection(taskReference);
      setJiraSyncState({ status: 'idle' });
    } catch (error) {
      setJiraSyncState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unexpected Jira task start failure',
      });
      throw error;
    } finally {
      setPendingOperations((current) => {
        if (current.get(taskReference) !== 'generating') return current;
        const next = new Map(current);
        next.delete(taskReference);
        return next;
      });
    }
  };

  const handleRemoveTask = async (): Promise<void> => {
    if (selectedTask === null || removeConfirmationTaskId !== selectedTask.id) return;
    const taskReference = selectedTask.id;
    setTaskRemovalError(null);
    setPendingOperations((current) => new Map(current).set(taskReference, 'removing'));
    try {
      await removeOperatorTask(taskReference, selectedTask.taskId);
      setRemoveConfirmationTaskId(null);
      setLaunchSettingsTaskId(null);
      selectedIdRef.current = '';
      setSelectedId('');
      await refreshTasks();
    } catch (error) {
      setTaskRemovalError(error instanceof Error ? error.message : 'Task removal did not complete');
    } finally {
      setPendingOperations((current) => {
        if (current.get(taskReference) !== 'removing') return current;
        const next = new Map(current);
        next.delete(taskReference);
        return next;
      });
    }
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

  const handleResolveDependencyAvailable = (): void => {
    if (
      selectedTask === null ||
      selectedRunId === null ||
      selectedDependencyWait === null ||
      selectedDependencyWait.kind !== 'dependency_available' ||
      operatorProjectionState.status !== 'ready' ||
      operatorProjectionState.projection.current?.status !== 'waiting'
    ) {
      return;
    }
    const packages = selectedDependencyWait.packages.map((packageName) => ({
      name: packageName,
      version: (selectedDependencyVersions.get(packageName) ?? '').trim(),
    }));
    if (packages.some((entry) => entry.version.length === 0)) return;
    const taskReference = selectedTask.id;
    const postId = selectedDependencyProvenance.postId.trim();
    const url = selectedDependencyProvenance.url.trim();
    setRuntimeWatchTaskId(taskReference);
    setPendingOperations((current) => new Map(current).set(taskReference, 'verifying_dependency'));
    void resolveDependencyAvailable(taskReference, {
      expectedRunId: selectedRunId,
      nodeId: operatorProjectionState.projection.current.nodeId,
      waitKind: 'dependency.available@1',
      declarationId: selectedDependencyWait.declarationId,
      declarationRevision: selectedDependencyWait.declarationRevision,
      channel: selectedDependencyWait.channel,
      packages,
      ...(postId.length === 0
        ? {}
        : {
            provenance: {
              kind: 'loop' as const,
              postId,
              ...(url.length === 0 ? {} : { url }),
            },
          }),
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
            message:
              error instanceof Error ? error.message : 'Unexpected dependency verification failure',
          });
        }
      })
      .finally(() => {
        setPendingOperations((current) => {
          if (current.get(taskReference) !== 'verifying_dependency') return current;
          const next = new Map(current);
          next.delete(taskReference);
          return next;
        });
      });
  };

  const handleResolveDependencyDiscovery = (): void => {
    if (
      selectedTask === null ||
      selectedRunId === null ||
      selectedDependencyWait === null ||
      selectedDependencyWait.kind !== 'dependency_discovery' ||
      operatorProjectionState.status !== 'ready' ||
      operatorProjectionState.projection.current?.status !== 'waiting'
    ) {
      return;
    }
    const producerTaskReference = selectedTaskDependencyDraft?.producerTaskReference.trim().length
      ? selectedTaskDependencyDraft.producerTaskReference.trim()
      : (selectedDependencyWait.declaration.producerTaskReference ?? '');
    const packages = parsePackageLines(selectedTaskDependencyDraft?.packages ?? '');
    const resolvedPackages =
      packages.length > 0 ? packages : [...selectedDependencyWait.declaration.packages];
    const mode = 'final_only';
    if (producerTaskReference.length === 0 || resolvedPackages.length === 0) {
      return;
    }
    const taskReference = selectedTask.id;
    setRuntimeWatchTaskId(taskReference);
    setPendingOperations((current) =>
      new Map(current).set(taskReference, 'configuring_discovered_dependency'),
    );
    void resolveDependencyDiscovery(taskReference, {
      expectedRunId: selectedRunId,
      nodeId: operatorProjectionState.projection.current.nodeId,
      waitKind: 'dependency.discovery@1',
      requestArtifactId: selectedDependencyWait.requestArtifactId,
      producerTaskReference,
      producerRepository: selectedDependencyWait.requestedRepository,
      packages: resolvedPackages,
      mode,
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
            message:
              error instanceof Error ? error.message : 'Unexpected discovered dependency failure',
          });
        }
      })
      .finally(() => {
        setPendingOperations((current) => {
          if (current.get(taskReference) !== 'configuring_discovered_dependency') return current;
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
              onResolveJiraIssue={handleResolveJiraIssue}
              onAddJira={handleJiraAdd}
              jiraSync={jiraSyncState}
              liveStatus={streamStatus}
            />
          )}

          <main className="min-h-0 overflow-y-auto border-r border-border">
            {selectedTask === null ? (
              <EmptyState>{tasksStatus === 'loading' ? 'Loading tasks…' : 'No tasks'}</EmptyState>
            ) : (
              <>
                <SelectedTaskHeader
                  task={selectedTask}
                  workflow={workflowState}
                  activity={activityState}
                  onOpenSettings={() => {
                    setLaunchSettingsTaskId(selectedTask.id);
                  }}
                  onRemove={() => {
                    setTaskRemovalError(null);
                    setRemoveConfirmationTaskId(selectedTask.id);
                  }}
                  onSyncJira={handleJiraSync}
                  pendingOperation={pendingOperations.get(selectedTask.id) ?? null}
                  jiraSync={jiraSyncState}
                />
                {removeConfirmationTaskId === selectedTask.id ? (
                  <RemoveTaskDialog
                    task={selectedTask}
                    pending={pendingOperations.get(selectedTask.id) === 'removing'}
                    error={taskRemovalError}
                    onClose={() => {
                      setRemoveConfirmationTaskId(null);
                      setTaskRemovalError(null);
                    }}
                    onConfirm={() => {
                      void handleRemoveTask();
                    }}
                  />
                ) : null}
                {launchSettingsTaskId === selectedTask.id &&
                jiraIssueState.status === 'ready' &&
                jiraIssueState.state.status !== 'unavailable' ? (
                  <JiraTaskLaunchDialog
                    open
                    mode="start"
                    initialIssue={jiraIssueState.state.issue}
                    initialRepository={
                      selectedTask.origin.repositoryBinding.status === 'resolved'
                        ? selectedTask.origin.repositoryBinding.repository.repositoryId
                        : ''
                    }
                    repositories={repositories}
                    pending={jiraSyncState.status === 'syncing'}
                    error={jiraSyncState.status === 'failed' ? jiraSyncState.message : null}
                    onClose={() => {
                      setLaunchSettingsTaskId(null);
                    }}
                    onResolveIssue={handleResolveJiraIssue}
                    onSubmit={handleJiraAdd}
                  />
                ) : null}
                <TaskDependencyPanel dependencies={selectedDependencies} />
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
                {selectedTask.status === 'waiting' && selectedDependencyWait !== null ? (
                  <DependencyWaitSurface
                    details={selectedDependencyWait}
                    pending={
                      pendingOperations.get(selectedTask.id) === 'verifying_dependency' ||
                      pendingOperations.get(selectedTask.id) ===
                        'configuring_discovered_dependency' ||
                      pendingOperations.get(selectedTask.id) === 'restarting'
                    }
                    restartConfirming={restartConfirmationTaskId === selectedTask.id}
                    versions={selectedDependencyVersions}
                    provenance={selectedDependencyProvenance}
                    discoveryDraft={
                      selectedTaskDependencyDraft ?? {
                        producerTaskReference: '',
                        producerRepository: '',
                        packages: '',
                        mode: 'final_only',
                        linkId: '',
                        linkTypeId: '',
                        direction: 'outward',
                      }
                    }
                    onVersionChange={(packageName, version) => {
                      setDependencyVersionDrafts((current) => {
                        const next = new Map(current);
                        next.set(
                          selectedTask.id,
                          new Map(selectedDependencyVersions).set(packageName, version),
                        );
                        return next;
                      });
                    }}
                    onProvenanceChange={(draft) => {
                      setDependencyProvenanceDrafts((current) =>
                        new Map(current).set(selectedTask.id, draft),
                      );
                    }}
                    onDiscoveryDraftChange={(draft) => {
                      setTaskDependencyDrafts((current) =>
                        new Map(current).set(selectedTask.id, draft),
                      );
                    }}
                    onSubmit={() => {
                      if (selectedDependencyWait.kind === 'dependency_available') {
                        handleResolveDependencyAvailable();
                      } else {
                        handleResolveDependencyDiscovery();
                      }
                    }}
                    onRestartRequest={() => {
                      setRestartConfirmationTaskId(selectedTask.id);
                    }}
                    onRestartCancel={() => {
                      setRestartConfirmationTaskId(null);
                    }}
                    onRestartConfirm={handleRestart}
                  />
                ) : null}
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
                {selectedIntervention !== null ||
                selectedDependencyWait !== null ||
                selectedWorkflowContinuation?.status === 'awaiting_review' ? null : (
                  <ExecutionProgressSurface projection={operatorProjectionState} />
                )}
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
                      planReviewHistoryState.status === 'ready' ? planReviewHistoryState.rounds : []
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
                {view === null ? null : <ValidationSurface view={view} />}
                <JiraPlanningSurface task={selectedTask} />
                <RunLogSurface
                  state={runLogState}
                  planning={implementationPlanState}
                  open={runLogOpen}
                  focusedAttempt={focusedRunLogAttempt}
                  onOpenChange={setRunLogOpen}
                />
                <div>
                  {selectedTask.status === 'done' ? (
                    <RetrospectiveSurface retrospective={retrospectiveState} />
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
                      history={
                        planReviewHistoryState.status === 'ready'
                          ? planReviewHistoryState.rounds
                          : []
                      }
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
                </div>
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
