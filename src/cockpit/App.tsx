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
import type { JiraIssueState, JiraIssueSnapshot } from '../integrations/jira/contracts.js';
import type { RepositoryCatalogEntry } from '../repositories/contracts.js';
import {
  connectOperatorStream,
  generateWorkflow,
  graphDownloadUrl,
  jiraAttachmentUrl,
  listOperatorTasks,
  listRepositories,
  loadJiraIssue,
  loadOperatorActivity,
  loadWorkflow,
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
  if (session.status === 'not_started') return 'not started · M1 planning only';

  const seconds = Math.max(0.1, session.durationMs / 1000).toFixed(1);
  const measuredTokens = session.usage.inputTokens + session.usage.outputTokens;
  return `${session.model} · read-only · ${seconds}s · ${measuredTokens.toLocaleString()} tok`;
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
  onSyncJira,
  generating,
  jiraSync,
}: {
  readonly task: OperatorTaskSummary;
  readonly workflow: WorkflowLoadState;
  readonly activity: ActivityLoadState;
  readonly onGenerate: () => void;
  readonly onSyncJira: (issueKey: string) => void;
  readonly generating: boolean;
  readonly jiraSync: JiraSyncState;
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
      {task.status === 'backlog' && task.planning.status === 'available' ? (
        <Button size="sm" type="button" onClick={onGenerate} disabled={generating}>
          {generating ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <Sparkles data-icon="inline-start" />
          )}
          {generating ? 'Generating…' : 'Generate workflow'}
        </Button>
      ) : task.origin.kind === 'jira' ? (
        <div className="flex items-center gap-1.5">
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
        </div>
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
  const [jiraIssueState, setJiraIssueState] = useState<JiraIssueLoadState>({
    status: 'not_applicable',
  });
  const [jiraSyncState, setJiraSyncState] = useState<JiraSyncState>({ status: 'idle' });
  const [streamStatus, setStreamStatus] = useState<ConsoleStreamStatus>('connecting');
  const [generating, setGenerating] = useState(false);
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
      selectedTask.status !== 'backlog' ||
      selectedTask.planning.status !== 'available'
    ) {
      return;
    }

    setGenerating(true);
    void generateWorkflow(selectedTask.id)
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
                  onSyncJira={handleJiraSync}
                  generating={generating}
                  jiraSync={jiraSyncState}
                />
                {view === null ? null : <ValidationSurface task={selectedTask} view={view} />}
                <JiraPlanningSurface task={selectedTask} />
                <ScrollArea className="min-h-0 flex-1">
                  <ActivityTimeline activity={activityState} streamStatus={streamStatus} />
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

          <WorkflowSidebar workflow={workflowState} task={selectedTask} />
        </div>
      </div>
    </TooltipProvider>
  );
};
