import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Circle,
  Download,
  GitBranch,
  LoaderCircle,
  Radio,
  Sparkles,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  OperatorActivityResponse,
  OperatorTaskSummary,
  WorkflowResponse,
  WorkflowView,
} from '../control-plane/m1-contracts.js';
import {
  connectOperatorStream,
  generateWorkflow,
  graphDownloadUrl,
  listOperatorTasks,
  loadOperatorActivity,
  loadWorkflow,
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

type ConsoleStreamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

const STORAGE_KEY = 'tasker.operator.selectedFixtureId';

const formatValue = (value: unknown): string =>
  value === undefined ? '—' : JSON.stringify(value, null, 2);

const formatShortDateTime = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));

const readStoredSelection = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored !== null && stored.length > 0 ? stored : null;
};

const writeStoredSelection = (fixtureId: string): void => {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, fixtureId);
  }
};

const chooseInitialFixture = (
  tasks: readonly OperatorTaskSummary[],
  storedSelection: string | null,
): string => {
  if (storedSelection !== null && tasks.some((task) => task.fixture.id === storedSelection)) {
    return storedSelection;
  }

  return tasks.find((task) => task.status === 'backlog')?.fixture.id ?? tasks[0]?.fixture.id ?? '';
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
    case 'waiting':
      return 'bg-amber-500/12 text-amber-300';
    case 'running':
      return 'bg-blue-500/12 text-blue-300';
    case 'code_review':
      return 'bg-violet-500/12 text-violet-300';
    case 'backlog':
    case 'planned':
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
  selectedId,
  onSelect,
  liveStatus,
}: {
  readonly tasks: readonly OperatorTaskSummary[];
  readonly selectedId: string;
  readonly onSelect: (fixtureId: string) => void;
  readonly liveStatus: ConsoleStreamStatus;
}) => {
  const counts = useMemo(() => {
    const result = new Map<OperatorTaskSummary['status'], number>();
    for (const task of tasks) {
      result.set(task.status, (result.get(task.status) ?? 0) + 1);
    }
    return result;
  }, [tasks]);

  const visibleCounts = (
    ['backlog', 'planned', 'needs_attention', 'code_review', 'done'] as const
  ).filter((status) => (counts.get(status) ?? 0) > 0);

  return (
    <aside className="flex min-h-0 flex-col border-r border-border" aria-label="Task queue">
      <div className="px-3 pb-2 pt-3">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-semibold">Tasks</h2>
            <span className="text-xs tabular-nums text-muted-foreground">{tasks.length}</span>
          </div>
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
        </div>
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
            const selected = task.fixture.id === selectedId;

            return (
              <li key={task.fixture.id}>
                <button
                  className={cn(
                    'group relative w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/45',
                    selected && 'bg-muted/70',
                  )}
                  data-testid={`task-item-${task.fixture.id}`}
                  type="button"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => {
                    onSelect(task.fixture.id);
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
                    {task.fixture.title}
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
  onGenerate,
  generating,
}: {
  readonly task: OperatorTaskSummary;
  readonly workflow: WorkflowLoadState;
  readonly onGenerate: () => void;
  readonly generating: boolean;
}) => (
  <section className="border-b border-border px-5 py-3.5" data-testid="selected-task">
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{task.taskId}</span>
          <span className="text-muted-foreground/50">·</span>
          <StateBadge className={statusTone(task.status)}>{statusLabel(task.status)}</StateBadge>
          <StateBadge>{task.currentStage}</StateBadge>
        </div>
        <h1 className="truncate text-lg font-semibold tracking-tight">{task.fixture.title}</h1>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span data-testid="provider-session-banner">not started · M1 planning only</span>
          {task.updatedAt === null ? null : (
            <>
              <span>·</span>
              <time dateTime={task.updatedAt}>{formatShortDateTime(task.updatedAt)}</time>
            </>
          )}
        </div>
      </div>
      {task.status === 'backlog' ? (
        <Button size="sm" type="button" onClick={onGenerate} disabled={generating}>
          {generating ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <Sparkles data-icon="inline-start" />
          )}
          {generating ? 'Generating…' : 'Generate workflow'}
        </Button>
      ) : workflow.status === 'ready' ? (
        <StateBadge className="bg-emerald-500/12 text-emerald-300">Workflow ready</StateBadge>
      ) : null}
    </div>
    {workflow.status === 'failed' ? <InlineError>{workflow.message}</InlineError> : null}
  </section>
);

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
        <dt>Template</dt>
        <dd className="truncate font-mono text-foreground">{view.workflow.templateId}</dd>
        <dt>Proposal</dt>
        <dd className="truncate font-mono text-foreground">{view.workflow.proposalId}</dd>
        <dt>Graph</dt>
        <dd className="truncate font-mono text-foreground" data-testid="graph-hash">
          {view.workflow.graphHash ?? 'not compiled'}
        </dd>
      </dl>
      <p className="font-medium">Template → task graph</p>
      {view.workflow.diff.length === 0 ? (
        <p className="text-muted-foreground">No graph diff</p>
      ) : (
        <ol className="space-y-2" data-testid="graph-diff">
          {view.workflow.diff.map((entry, index) => (
            <li key={`${entry.kind}:${entry.path}:${String(index)}`}>
              <div className="flex items-center gap-2">
                <StateBadge>{entry.kind}</StateBadge>
                <code className="truncate text-muted-foreground">{entry.path}</code>
              </div>
              <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-muted/40 p-2 text-[10px] text-muted-foreground">
                {formatValue(entry.before)} → {formatValue(entry.after)}
              </pre>
            </li>
          ))}
        </ol>
      )}
    </div>
  </details>
);

const WorkflowSidebar = ({ workflow }: { readonly workflow: WorkflowLoadState }) => {
  if (workflow.status === 'loading') {
    return (
      <aside className="flex min-h-0 flex-col" aria-label="Current workflow">
        <EmptyState>Loading workflow…</EmptyState>
      </aside>
    );
  }

  if (workflow.status === 'missing') {
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
  const [tasksStatus, setTasksStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [tasksMessage, setTasksMessage] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>(() => readStoredSelection() ?? '');
  const [workflowState, setWorkflowState] = useState<WorkflowLoadState>({ status: 'loading' });
  const [activityState, setActivityState] = useState<ActivityLoadState>({ status: 'loading' });
  const [streamStatus, setStreamStatus] = useState<ConsoleStreamStatus>('connecting');
  const [generating, setGenerating] = useState(false);
  const streamCursorRef = useRef(0);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.fixture.id === selectedId) ?? null,
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
        currentSelectedId.length > 0 &&
        nextTasks.some((task) => task.fixture.id === currentSelectedId)
          ? currentSelectedId
          : chooseInitialFixture(nextTasks, readStoredSelection());

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

  const refreshSelection = async (fixtureId: string): Promise<void> => {
    await Promise.all([refreshSelectedWorkflow(fixtureId), refreshSelectedActivity(fixtureId)]);
  };

  useEffect(() => {
    let active = true;

    const initialize = async (): Promise<void> => {
      const nextSelectedId = await refreshTasks();
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

  const handleSelectTask = (fixtureId: string): void => {
    setSelectedId(fixtureId);
    void refreshSelection(fixtureId);
  };

  const handleGenerate = (): void => {
    if (selectedTask === null || selectedTask.status !== 'backlog') {
      return;
    }

    setGenerating(true);
    void generateWorkflow(selectedTask.fixture.id)
      .then(async () => {
        const nextSelectedId = await refreshTasks();
        if (nextSelectedId !== null) {
          await refreshSelection(nextSelectedId);
        }
      })
      .catch((error: unknown) => {
        setWorkflowState({
          status: 'failed',
          message: error instanceof Error ? error.message : 'Unexpected generation failure',
        });
      })
      .finally(() => {
        setGenerating(false);
      });
  };

  const view = workflowState.status === 'ready' ? workflowState.response.view : null;

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
            <StateBadge>M1 · planning only</StateBadge>
          </div>
        </header>

        {tasksStatus === 'failed' ? (
          <InlineError>{tasksMessage ?? 'The task queue could not be loaded'}</InlineError>
        ) : null}

        <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_340px]">
          <TaskQueue
            tasks={tasks}
            selectedId={selectedId}
            onSelect={handleSelectTask}
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
                  onGenerate={handleGenerate}
                  generating={generating}
                />
                {view === null ? null : <ValidationSurface task={selectedTask} view={view} />}
                <ScrollArea className="min-h-0 flex-1">
                  <ActivityTimeline activity={activityState} streamStatus={streamStatus} />
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

          <WorkflowSidebar workflow={workflowState} />
        </div>
      </div>
    </TooltipProvider>
  );
};
