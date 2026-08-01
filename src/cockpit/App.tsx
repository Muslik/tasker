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
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, fixtureId);
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

const attentionLabel = (attention: OperatorTaskSummary['attention']): string =>
  attention === 'operator' ? 'Operator attention' : 'Quiet';

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

const levelLabel = (level: OperatorActivityResponse['entries'][number]['level']): string =>
  level === 'error' ? 'Error' : level === 'warning' ? 'Warning' : 'Info';

const levelTone = (level: OperatorActivityResponse['entries'][number]['level']): string =>
  level === 'error' ? 'danger' : level === 'warning' ? 'warning' : 'neutral';

const SelectionBadge = ({
  children,
  tone,
}: {
  readonly children: string;
  readonly tone: 'neutral' | 'good' | 'warning' | 'danger' | 'accent';
}) => <span className={`badge badge--${tone}`}>{children}</span>;

const SectionTitle = ({
  eyebrow,
  title,
  detail,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly detail?: string | undefined;
}) => (
  <div className="section-title">
    <p className="eyebrow">{eyebrow}</p>
    <h2>{title}</h2>
    {detail === undefined ? null : <p className="section-title__detail">{detail}</p>}
  </div>
);

const EmptyPrompt = ({ title, detail }: { readonly title: string; readonly detail: string }) => (
  <div className="empty-prompt">
    <p className="empty-prompt__title">{title}</p>
    <p>{detail}</p>
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

  return (
    <aside className="pane pane--queue" aria-label="Task queue">
      <div className="pane__header">
        <div>
          <p className="eyebrow">Queue</p>
          <h2>Tasks</h2>
        </div>
        <SelectionBadge tone={liveStatus === 'live' ? 'good' : 'warning'}>
          {liveStatus === 'live'
            ? 'live'
            : liveStatus === 'reconnecting'
              ? 'reconnecting'
              : 'syncing'}
        </SelectionBadge>
      </div>

      <div className="queue-stats" aria-label="Task status summary">
        {(
          [
            'backlog',
            'planned',
            'workflow_rejected',
            'needs_attention',
            'code_review',
            'done',
          ] as const
        ).map((status) => (
          <div key={status} className="queue-stat">
            <span>{statusLabel(status)}</span>
            <strong>{counts.get(status) ?? 0}</strong>
          </div>
        ))}
      </div>

      <ol className="task-list" data-testid="task-list">
        {tasks.map((task) => {
          const selected = task.fixture.id === selectedId;

          return (
            <li key={task.fixture.id}>
              <button
                className={`task-card ${selected ? 'task-card--selected' : ''}`}
                data-testid={`task-item-${task.fixture.id}`}
                type="button"
                aria-current={selected ? 'true' : undefined}
                onClick={() => {
                  onSelect(task.fixture.id);
                }}
              >
                <div className="task-card__topline">
                  <div className="task-card__titles">
                    <span className="task-card__task-id">{task.taskId}</span>
                    <strong>{task.fixture.title}</strong>
                  </div>
                  {selected ? <SelectionBadge tone="accent">selected</SelectionBadge> : null}
                </div>

                <div className="task-card__badges">
                  <SelectionBadge
                    tone={
                      task.status === 'done'
                        ? 'good'
                        : task.status === 'failed'
                          ? 'danger'
                          : 'neutral'
                    }
                  >
                    {statusLabel(task.status)}
                  </SelectionBadge>
                  <SelectionBadge tone={task.attention === 'operator' ? 'warning' : 'neutral'}>
                    {attentionLabel(task.attention)}
                  </SelectionBadge>
                </div>

                <p className="task-card__stage">{task.currentStage}</p>
                <p className="task-card__meta">{task.fixture.purpose}</p>
                <time className="task-card__time" dateTime={task.updatedAt ?? undefined}>
                  {task.updatedAt === null
                    ? 'No ledger activity yet'
                    : `Updated ${formatShortDateTime(task.updatedAt)}`}
                </time>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
};

const ActivityTimeline = ({
  activity,
  streamStatus,
}: {
  readonly activity: ActivityLoadState;
  readonly streamStatus: ConsoleStreamStatus;
}) => {
  const providerSession =
    activity.status === 'ready'
      ? activity.response.providerSession
      : { status: 'not_started', reason: 'm1_planning_only' as const };

  return (
    <section className="panel panel--timeline" aria-label="Activity timeline">
      <div className="panel__header">
        <SectionTitle
          eyebrow="Realtime surface"
          title="Persisted activity"
          detail="Kernel and planner events are persisted today. Agent and tool events will appear once execution is enabled."
        />
        <div className="panel__header-stack">
          <SelectionBadge tone={streamStatus === 'live' ? 'good' : 'warning'}>
            {streamStatus === 'live'
              ? 'stream live'
              : streamStatus === 'reconnecting'
                ? 'reconnecting'
                : 'stream paused'}
          </SelectionBadge>
          <SelectionBadge tone="neutral">
            {providerSession.status === 'not_started'
              ? 'not started · M1 planning only'
              : providerSession.status}
          </SelectionBadge>
        </div>
      </div>

      {activity.status === 'loading' ? (
        <EmptyPrompt
          title="Loading activity"
          detail="Reading the ledger timeline for the selected task."
        />
      ) : null}
      {activity.status === 'failed' ? (
        <div className="callout callout--danger" role="alert">
          {activity.message}
        </div>
      ) : null}
      {activity.status === 'ready' ? (
        <div className="timeline" data-testid="task-activity-timeline">
          {activity.response.entries.length === 0 ? (
            <EmptyPrompt
              title="No persisted activity"
              detail="Generate the selected backlog task to create the first ledger events."
            />
          ) : (
            activity.response.entries.map((entry) => (
              <article key={entry.sequence} className="timeline-entry timeline-entry--open">
                <div className="timeline-entry__rail" aria-hidden="true" />
                <div className="timeline-entry__body">
                  <div className="timeline-entry__head">
                    <span className={`badge badge--${levelTone(entry.level)}`}>
                      {levelLabel(entry.level)}
                    </span>
                    <span className="timeline-entry__source">{sourceLabel(entry.source)}</span>
                    <time dateTime={entry.occurredAt}>{formatShortDateTime(entry.occurredAt)}</time>
                  </div>
                  <h3>{entry.title}</h3>
                  <p>{entry.detail}</p>
                  <span className="timeline-entry__sequence">#{entry.sequence}</span>
                </div>
              </article>
            ))
          )}
        </div>
      ) : null}
    </section>
  );
};

const WhyThisWorkflow = ({ view }: { readonly view: WorkflowView }) => (
  <section className="panel" aria-label="Workflow assembly decisions">
    <div className="panel__header">
      <SectionTitle
        eyebrow="Why this workflow"
        title="Assembly decisions"
        detail="The planner records why each branch exists. The UI shows those reasons directly instead of paraphrasing them into generic steps."
      />
      <SelectionBadge tone={view.workflow.status === 'valid' ? 'good' : 'danger'}>
        {view.workflow.status}
      </SelectionBadge>
    </div>
    <div className="decision-grid" data-testid="workflow-decisions">
      {view.workflow.assemblyDecisions.map((decision) => (
        <article className="decision-card" key={decision.id}>
          <div className="decision-card__head">
            <strong>{decision.title}</strong>
            <code>{decision.source}</code>
          </div>
          <p>{decision.reason}</p>
          <span>{decision.effect}</span>
        </article>
      ))}
    </div>
  </section>
);

const ValidationSurface = ({
  task,
  workflow,
}: {
  readonly task: OperatorTaskSummary | null;
  readonly workflow: WorkflowLoadState;
}) => {
  if (workflow.status === 'loading') {
    return (
      <section className="panel" aria-label="Validation surface">
        <EmptyPrompt
          title="Validation surface loading"
          detail="The selected task graph is being read from the ledger."
        />
      </section>
    );
  }

  if (workflow.status === 'missing') {
    return (
      <section className="panel" aria-label="Validation surface">
        <EmptyPrompt
          title="No validator report yet"
          detail="Generate a backlog task to materialize the validator output and the immutable task graph."
        />
      </section>
    );
  }

  if (workflow.status === 'failed') {
    return (
      <section className="panel" aria-label="Validation surface">
        <div className="callout callout--danger" role="alert">
          {workflow.message}
        </div>
      </section>
    );
  }

  const view = workflow.response.view;
  const issues = view.workflow.validatorReport.issues;
  const blocked = view.workflow.status === 'rejected' || issues.length > 0;

  return (
    <section className="panel" aria-label="Validation surface" data-testid="validation-panel">
      <div className="panel__header">
        <SectionTitle
          eyebrow="Validation / intervention"
          title={blocked ? 'Human review required' : 'Validator passed'}
          detail="This panel is the operator’s decision point: what was accepted, what was blocked, and what needs intervention."
        />
        <SelectionBadge tone={blocked ? 'warning' : 'good'}>
          {blocked ? 'needs review' : 'clear'}
        </SelectionBadge>
      </div>

      <div className="validation-grid">
        <article>
          <span>Task state</span>
          <strong>{task === null ? 'unknown' : statusLabel(task.status)}</strong>
          <p>{task === null ? 'Task metadata is still loading' : task.currentStage}</p>
        </article>
        <article>
          <span>Workflow state</span>
          <strong>{view.workflow.status}</strong>
          <p>{view.workflow.graphHash ?? 'not compiled'}</p>
        </article>
      </div>

      {issues.length === 0 ? (
        <div className="callout callout--neutral">
          No structural issues were found. The graph is ready for later execution phases.
        </div>
      ) : (
        <ol className="issue-list" data-testid="validation-errors">
          {issues.map((issue) => (
            <li key={`${issue.code}:${issue.path.join('.')}`}>
              <div className="issue-list__topline">
                <SelectionBadge tone="warning">{issue.code}</SelectionBadge>
                <code>{issue.path.length === 0 ? '$' : issue.path.join(' → ')}</code>
              </div>
              <p>{issue.message}</p>
              {issue.details === undefined ? null : <pre>{formatValue(issue.details)}</pre>}
            </li>
          ))}
        </ol>
      )}

      {blocked ? (
        <div className="callout callout--danger">
          Stop here and review the decision surface. In M1 this is a planning failure, not an
          execution failure.
        </div>
      ) : null}
    </section>
  );
};

const WorkflowDiagnostics = ({ view }: { readonly view: WorkflowView }) => (
  <details className="panel diagnostics" data-testid="workflow-debug-details">
    <summary>
      <SectionTitle
        eyebrow="Diagnostics"
        title="Template → task graph"
        detail="Collapsed by default. This is useful when you need to inspect the raw deterministic diff and the proposal source without turning the console into a blob of JSON."
      />
    </summary>
    <div className="diagnostics__content">
      <div className="diagnostics__columns">
        <article>
          <p className="eyebrow">Template</p>
          <code>{view.workflow.templateId}</code>
        </article>
        <article>
          <p className="eyebrow">Proposal</p>
          <code>{view.workflow.proposalId}</code>
        </article>
        <article>
          <p className="eyebrow">Hash</p>
          <code data-testid="graph-hash">{view.workflow.graphHash ?? 'not compiled'}</code>
        </article>
      </div>

      {view.workflow.diff.length === 0 ? (
        <EmptyPrompt
          title="No graph diff"
          detail="The selected task graph matches the chosen template exactly."
        />
      ) : (
        <ol className="diff-list" data-testid="graph-diff">
          {view.workflow.diff.map((entry, index) => (
            <li key={`${entry.kind}:${entry.path}:${String(index)}`}>
              <div className="diff-list__topline">
                <SelectionBadge
                  tone={
                    entry.kind === 'removed'
                      ? 'danger'
                      : entry.kind === 'added'
                        ? 'good'
                        : 'warning'
                  }
                >
                  {entry.kind}
                </SelectionBadge>
                <code>{entry.path}</code>
              </div>
              <div className="diff-values">
                <pre>{formatValue(entry.before)}</pre>
                <span aria-hidden="true">→</span>
                <pre>{formatValue(entry.after)}</pre>
              </div>
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
      <aside className="pane pane--workflow" aria-label="Current workflow">
        <EmptyPrompt
          title="Loading workflow"
          detail="Reading the selected task graph from the ledger."
        />
      </aside>
    );
  }

  if (workflow.status === 'missing') {
    return (
      <aside className="pane pane--workflow" aria-label="Current workflow">
        <EmptyPrompt
          title="No workflow materialized yet"
          detail="Generate a backlog task on the left. The workflow will then appear here and remain immutable until the ledger is updated."
        />
      </aside>
    );
  }

  if (workflow.status === 'failed') {
    return (
      <aside className="pane pane--workflow" aria-label="Current workflow">
        <div className="callout callout--danger" role="alert">
          {workflow.message}
        </div>
      </aside>
    );
  }

  const view = workflow.response.view;

  return (
    <aside
      className="pane pane--workflow"
      aria-label="Current workflow"
      data-testid="workflow-sidebar"
    >
      <div className="workflow-sidebar__sticky">
        <div className="panel__header">
          <SectionTitle
            eyebrow="Current workflow"
            title={view.fixture.title}
            detail="The operator console reads this graph from the ledger and never simulates execution."
          />
          <div className="panel__header-stack">
            <SelectionBadge tone={view.workflow.status === 'valid' ? 'good' : 'danger'}>
              {view.workflow.status}
            </SelectionBadge>
            {view.workflow.graphHash === null ? null : (
              <a className="download-link" href={graphDownloadUrl(view.fixture.id)} download>
                Download graph JSON
              </a>
            )}
          </div>
        </div>

        <div className="workflow-metrics">
          <article>
            <span>Verification</span>
            <strong>{view.workflow.verificationPlan.profile.replaceAll('_', ' ')}</strong>
            <p>{view.workflow.verificationPlan.rationale}</p>
          </article>
          <article>
            <span>Capabilities</span>
            <strong>{view.workflow.capabilities.required.length}</strong>
            <p>{view.workflow.capabilities.required.join(', ') || 'None required'}</p>
          </article>
          <article>
            <span>Waits</span>
            <strong>{view.workflow.waits.length}</strong>
            <p>
              {view.workflow.waits.length === 0
                ? 'No durable waits'
                : view.workflow.waits
                    .map((wait) => `${wait.nodeId}:${wait.waitKind}/${wait.slotPolicy}`)
                    .join(' · ')}
            </p>
          </article>
          <article>
            <span>Retries</span>
            <strong>{Object.keys(view.workflow.retryBudgets).length}</strong>
            <p>
              {Object.entries(view.workflow.retryBudgets)
                .map(([nodeId, budget]) => `${nodeId} ≤ ${String(budget)}`)
                .join(' · ') || 'No retry budgets'}
            </p>
          </article>
        </div>

        <div className="workflow-graph">
          <SectionTitle
            eyebrow="Workflow tree"
            title="Current task graph"
            detail="The tree is sticky and independently scrollable on desktop so you can keep the queue and activity feed in view."
          />
          {view.workflow.tree === null ? (
            <div className="callout callout--danger" role="alert">
              This workflow was rejected before graph materialization.
            </div>
          ) : (
            <WorkflowTree root={view.workflow.tree} />
          )}
        </div>
      </div>
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
}) => {
  const canGenerate = task.status === 'backlog';

  return (
    <section
      className="panel panel--selected"
      aria-label="Selected task"
      data-testid="selected-task"
    >
      <div className="panel__header panel__header--stacked">
        <div>
          <p className="eyebrow">Selected task</p>
          <h1>{task.fixture.title}</h1>
          <p className="section-title__detail">{task.fixture.purpose}</p>
        </div>
        <div className="panel__header-stack panel__header-stack--dense">
          <SelectionBadge tone={task.attention === 'operator' ? 'warning' : 'neutral'}>
            {attentionLabel(task.attention)}
          </SelectionBadge>
          <SelectionBadge
            tone={
              task.status === 'done'
                ? 'good'
                : task.status === 'failed'
                  ? 'danger'
                  : task.status === 'workflow_rejected'
                    ? 'warning'
                    : 'neutral'
            }
          >
            {statusLabel(task.status)}
          </SelectionBadge>
          <SelectionBadge tone="neutral">{task.currentStage}</SelectionBadge>
        </div>
      </div>

      <div className="selected-task__meta">
        <div>
          <span>Task ID</span>
          <strong>{task.taskId}</strong>
        </div>
        <div>
          <span>Fixture</span>
          <strong>{task.fixture.id}</strong>
        </div>
        <div>
          <span>Updated</span>
          <strong>{task.updatedAt === null ? 'Never' : formatShortDateTime(task.updatedAt)}</strong>
        </div>
      </div>

      <div className="selected-task__actions">
        <div className="selected-task__session">
          <p className="eyebrow">Provider session</p>
          <strong data-testid="provider-session-banner">not started · M1 planning only</strong>
          <p>
            No provider calls are allowed in M1. This console is showing the planner and ledger
            only.
          </p>
        </div>

        {canGenerate ? (
          <button
            className="button button--primary"
            type="button"
            onClick={onGenerate}
            disabled={generating}
          >
            {generating ? 'Generating…' : 'Generate workflow'}
          </button>
        ) : (
          <div className="selected-task__locked">
            <SelectionBadge tone="neutral">workflow already materialized</SelectionBadge>
            <p>
              Generation is only available for backlog tasks. This selected task is now read only.
            </p>
          </div>
        )}
      </div>

      {workflow.status === 'ready' || workflow.status === 'failed' ? null : (
        <div className="callout callout--neutral" role="status">
          {workflow.status === 'missing'
            ? 'This task has no persisted workflow yet.'
            : 'Loading the selected task timeline and workflow…'}
        </div>
      )}

      {workflow.status === 'ready' ? (
        <div className="selected-task__ready">
          <SelectionBadge tone="good">workflow persisted</SelectionBadge>
          <p>
            The graph is compiled, hashed, and frozen in the ledger. Changes only happen when the
            ledger is updated, not inside the UI.
          </p>
        </div>
      ) : null}
    </section>
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
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Tasker</p>
          <h1>Operator console</h1>
        </div>
        <div className="app-header__meta">
          <SelectionBadge tone={tasksStatus === 'ready' ? 'good' : 'warning'}>
            {tasksStatus === 'ready' ? 'ledger ready' : 'loading ledger'}
          </SelectionBadge>
          <SelectionBadge tone={streamStatus === 'live' ? 'good' : 'warning'}>
            {streamStatus === 'live'
              ? 'SSE live'
              : streamStatus === 'reconnecting'
                ? 'SSE reconnecting'
                : 'SSE offline'}
          </SelectionBadge>
          <SelectionBadge tone="neutral">M1 planning only</SelectionBadge>
        </div>
      </header>

      {tasksStatus === 'failed' ? (
        <div className="callout callout--danger" role="alert">
          {tasksMessage ?? 'The operator task queue could not be loaded.'}
        </div>
      ) : null}

      <div className="console-grid">
        <TaskQueue
          tasks={tasks}
          selectedId={selectedId}
          onSelect={handleSelectTask}
          liveStatus={streamStatus}
        />

        <main className="console-main">
          {selectedTask === null ? (
            <EmptyPrompt
              title="No task selected"
              detail="Load the queue first, then pick the task you want to inspect."
            />
          ) : (
            <>
              <SelectedTaskHeader
                task={selectedTask}
                workflow={workflowState}
                onGenerate={handleGenerate}
                generating={generating}
              />

              <ActivityTimeline activity={activityState} streamStatus={streamStatus} />

              {view === null ? null : (
                <>
                  <ValidationSurface task={selectedTask} workflow={workflowState} />
                  <WhyThisWorkflow view={view} />
                  <WorkflowDiagnostics view={view} />
                </>
              )}
            </>
          )}
        </main>

        <WorkflowSidebar workflow={workflowState} />
      </div>
    </div>
  );
};
