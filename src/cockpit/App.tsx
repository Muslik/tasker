import { useEffect, useState } from 'react';

import type {
  FixtureSummary,
  WorkflowResponse,
  WorkflowView,
} from '../control-plane/m1-contracts.js';
import { generateWorkflow, graphDownloadUrl, listFixtures, loadWorkflow } from './api-client.js';
import { WorkflowTree } from './WorkflowTree.js';

type ScreenState =
  | { readonly status: 'loading_fixtures' }
  | { readonly status: 'fixtures_failed'; readonly message: string }
  | {
      readonly status: 'idle';
      readonly fixtures: readonly FixtureSummary[];
      readonly selectedId: string;
    }
  | {
      readonly status: 'loading_workflow';
      readonly fixtures: readonly FixtureSummary[];
      readonly selectedId: string;
      readonly action: 'load' | 'generate';
    }
  | {
      readonly status: 'showing_workflow';
      readonly fixtures: readonly FixtureSummary[];
      readonly selectedId: string;
      readonly response: WorkflowResponse;
    }
  | {
      readonly status: 'workflow_failed';
      readonly fixtures: readonly FixtureSummary[];
      readonly selectedId: string;
      readonly message: string;
    };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Unexpected cockpit failure';

const formatValue = (value: unknown): string =>
  value === undefined ? '—' : JSON.stringify(value, null, 2);

const StatusPill = ({
  children,
  tone,
}: {
  readonly children: string;
  readonly tone: 'danger' | 'good';
}) => <span className={`status-pill status-pill--${tone}`}>{children}</span>;

const Fact = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <div className="fact">
    <dt>{label}</dt>
    <dd>{value}</dd>
  </div>
);

const ChipList = ({
  empty,
  values,
}: {
  readonly empty: string;
  readonly values: readonly string[];
}) =>
  values.length === 0 ? (
    <p className="empty-copy">{empty}</p>
  ) : (
    <ul className="chip-list">
      {values.map((value) => (
        <li key={value}>{value}</li>
      ))}
    </ul>
  );

const WorkflowSummary = ({ view }: { readonly view: WorkflowView }) => (
  <section className="summary-grid" aria-label="Workflow summary">
    <article className="panel panel--summary">
      <div className="panel__heading">
        <div>
          <p className="eyebrow">Intake</p>
          <h2>Eligibility</h2>
        </div>
        <StatusPill tone={view.intake.eligibility.eligible ? 'good' : 'danger'}>
          {view.intake.eligibility.eligible ? 'eligible' : 'blocked'}
        </StatusPill>
      </div>
      <dl className="fact-list">
        <Fact label="Intake" value={view.intake.id} />
        <Fact label="Status" value={view.intake.status} />
        <Fact label="Task" value={view.task.id} />
        <Fact label="Task state" value={view.task.status} />
      </dl>
      <p className="reason">{view.intake.eligibility.reason}</p>
    </article>

    <article className="panel panel--summary">
      <div className="panel__heading">
        <div>
          <p className="eyebrow">Immutable graph</p>
          <h2>Workflow</h2>
        </div>
        <StatusPill tone={view.workflow.status === 'valid' ? 'good' : 'danger'}>
          {view.workflow.status}
        </StatusPill>
      </div>
      <dl className="fact-list">
        <Fact label="Template" value={view.workflow.templateId} />
        <Fact label="Proposal" value={view.workflow.proposalId} />
        <Fact label="Execution" value="disabled in M1" />
      </dl>
      <div className="hash-block">
        <span>Graph hash</span>
        <code data-testid="graph-hash">{view.workflow.graphHash ?? 'not compiled'}</code>
      </div>
    </article>

    <article className="panel panel--summary">
      <p className="eyebrow">Verification policy</p>
      <h2>{view.workflow.verificationPlan.profile.replaceAll('_', ' ')}</h2>
      <p className="reason">{view.workflow.verificationPlan.rationale}</p>
      <p className="eyebrow eyebrow--spaced">Expected artifacts</p>
      <ChipList empty="No artifacts declared" values={view.workflow.expectedArtifacts} />
    </article>
  </section>
);

const ValidationPanel = ({ view }: { readonly view: WorkflowView }) => {
  const issues = view.workflow.validatorReport.issues;

  return (
    <article className={`panel ${issues.length === 0 ? 'panel--success' : 'panel--danger'}`}>
      <div className="panel__heading">
        <div>
          <p className="eyebrow">Deterministic validator</p>
          <h2>{issues.length === 0 ? 'Graph accepted' : 'Graph rejected'}</h2>
        </div>
        <span className="issue-count">{issues.length}</span>
      </div>
      {issues.length === 0 ? (
        <p className="reason">No structural or contract violations were found.</p>
      ) : (
        <ol className="issue-list" data-testid="validation-errors">
          {issues.map((issue, index) => (
            <li key={`${issue.code}:${issue.path.join('.')}:${String(index)}`}>
              <div>
                <code>{issue.code}</code>
                <span>{issue.path.length === 0 ? '$' : issue.path.join(' → ')}</span>
              </div>
              <p>{issue.message}</p>
              {issue.details === undefined ? null : <pre>{formatValue(issue.details)}</pre>}
            </li>
          ))}
        </ol>
      )}
    </article>
  );
};

const CapabilitiesPanel = ({ view }: { readonly view: WorkflowView }) => (
  <article className="panel">
    <p className="eyebrow">Capability check</p>
    <h2>Provider surface</h2>
    <div className="capability-columns">
      <div>
        <h3>Required</h3>
        <ChipList empty="No capabilities required" values={view.workflow.capabilities.required} />
      </div>
      <div>
        <h3>Available</h3>
        <ChipList
          empty="No providers enabled in M1"
          values={view.workflow.capabilities.available}
        />
      </div>
    </div>
  </article>
);

const DiffPanel = ({ view }: { readonly view: WorkflowView }) => (
  <article className="panel panel--wide">
    <div className="panel__heading">
      <div>
        <p className="eyebrow">Template → task graph</p>
        <h2>Deterministic diff</h2>
      </div>
      <span className="issue-count">{view.workflow.diff.length}</span>
    </div>
    {view.workflow.diff.length === 0 ? (
      <p className="empty-copy">The task graph matches its template exactly.</p>
    ) : (
      <ol className="diff-list" data-testid="graph-diff">
        {view.workflow.diff.map((entry, index) => (
          <li key={`${entry.kind}:${entry.path}:${String(index)}`}>
            <span className={`diff-kind diff-kind--${entry.kind}`}>{entry.kind}</span>
            <code>{entry.path}</code>
            <div className="diff-values">
              <pre>{formatValue(entry.before)}</pre>
              <span aria-hidden="true">→</span>
              <pre>{formatValue(entry.after)}</pre>
            </div>
          </li>
        ))}
      </ol>
    )}
  </article>
);

const GraphPanel = ({ view }: { readonly view: WorkflowView }) => (
  <article className="panel panel--wide">
    <div className="panel__heading">
      <div>
        <p className="eyebrow">Planned nodes</p>
        <h2>Workflow tree</h2>
      </div>
      <span className="read-only-badge">read only</span>
    </div>
    {view.workflow.tree === null ? (
      <p className="empty-copy">A rejected proposal has no executable tree.</p>
    ) : (
      <WorkflowTree root={view.workflow.tree} />
    )}
  </article>
);

const WorkflowDetails = ({ response }: { readonly response: WorkflowResponse }) => {
  const { view } = response;

  return (
    <main className="workspace" data-testid="workflow-details">
      <header className="task-header">
        <div>
          <p className="eyebrow">{view.fixture.family.replaceAll('_', ' ')}</p>
          <h1>{view.fixture.title}</h1>
          <p>{view.fixture.purpose}</p>
        </div>
        <time dateTime={view.persistedAt}>
          Persisted{' '}
          {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
            new Date(view.persistedAt),
          )}
        </time>
      </header>
      <WorkflowSummary view={view} />
      <section className="detail-grid">
        <ValidationPanel view={view} />
        <CapabilitiesPanel view={view} />
        <GraphPanel view={view} />
        <DiffPanel view={view} />
      </section>
    </main>
  );
};

export const App = () => {
  const [state, setState] = useState<ScreenState>({ status: 'loading_fixtures' });

  useEffect(() => {
    let active = true;
    const updateIfActive = (nextState: ScreenState): void => {
      if (active) {
        setState(nextState);
      }
    };

    void listFixtures()
      .then(async (fixtures) => {
        const selectedId = fixtures[0]?.id;
        if (selectedId === undefined) {
          updateIfActive({ status: 'fixtures_failed', message: 'The fixture catalog is empty' });
          return;
        }

        updateIfActive({ status: 'loading_workflow', fixtures, selectedId, action: 'load' });
        const lookup = await loadWorkflow(selectedId);

        updateIfActive(
          lookup.status === 'found'
            ? { status: 'showing_workflow', fixtures, selectedId, response: lookup.response }
            : { status: 'idle', fixtures, selectedId },
        );
      })
      .catch((error: unknown) => {
        updateIfActive({ status: 'fixtures_failed', message: errorMessage(error) });
      });

    return () => {
      active = false;
    };
  }, []);

  const controls = 'fixtures' in state ? state : null;
  const fixtures = controls?.fixtures ?? null;
  const selectedId = controls?.selectedId ?? '';

  const selectFixture = (nextId: string) => {
    if (fixtures === null) {
      return;
    }

    setState({ status: 'loading_workflow', fixtures, selectedId: nextId, action: 'load' });
    void loadWorkflow(nextId)
      .then((lookup) => {
        setState(
          lookup.status === 'found'
            ? {
                status: 'showing_workflow',
                fixtures,
                selectedId: nextId,
                response: lookup.response,
              }
            : { status: 'idle', fixtures, selectedId: nextId },
        );
      })
      .catch((error: unknown) => {
        setState({
          status: 'workflow_failed',
          fixtures,
          selectedId: nextId,
          message: errorMessage(error),
        });
      });
  };

  const requestGeneration = () => {
    if (fixtures === null || selectedId.length === 0) {
      return;
    }

    setState({ status: 'loading_workflow', fixtures, selectedId, action: 'generate' });
    void generateWorkflow(selectedId)
      .then((response) => {
        setState({ status: 'showing_workflow', fixtures, selectedId, response });
      })
      .catch((error: unknown) => {
        setState({
          status: 'workflow_failed',
          fixtures,
          selectedId,
          message: errorMessage(error),
        });
      });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Tasker cockpit home">
          <span className="brand__mark" aria-hidden="true">
            T
          </span>
          <span>
            <strong>Tasker</strong>
            <small>workflow cockpit</small>
          </span>
        </a>
        <span className="milestone">M1 · plan only</span>
      </header>

      <section className="control-strip" aria-label="Workflow controls">
        <div className="selector">
          <label htmlFor="fixture">Task fixture</label>
          <select
            id="fixture"
            value={selectedId}
            disabled={fixtures === null || state.status === 'loading_workflow'}
            onChange={(event) => {
              selectFixture(event.currentTarget.value);
            }}
          >
            {fixtures?.map((fixture) => (
              <option key={fixture.id} value={fixture.id}>
                {fixture.title}
              </option>
            ))}
          </select>
        </div>
        <div className="control-strip__actions">
          {state.status === 'showing_workflow' && state.response.view.workflow.graph !== null ? (
            <a
              className="button button--secondary"
              href={graphDownloadUrl(state.selectedId)}
              download
            >
              Download graph JSON
            </a>
          ) : null}
          <button
            className="button button--primary"
            type="button"
            disabled={fixtures === null || state.status === 'loading_workflow'}
            onClick={requestGeneration}
          >
            {state.status === 'loading_workflow' && state.action === 'generate'
              ? 'Generating…'
              : 'Generate workflow'}
          </button>
        </div>
      </section>

      <div className="announcer" aria-live="polite">
        {state.status === 'loading_fixtures' ? 'Loading task fixtures…' : null}
        {state.status === 'loading_workflow' && state.action === 'load'
          ? 'Checking for a persisted workflow…'
          : null}
        {state.status === 'loading_workflow' && state.action === 'generate'
          ? 'Compiling and validating the workflow…'
          : null}
      </div>

      {state.status === 'fixtures_failed' ? (
        <main className="empty-state" role="alert">
          <p className="eyebrow">Cockpit unavailable</p>
          <h1>Fixture catalog could not be loaded</h1>
          <p>{state.message}</p>
        </main>
      ) : null}

      {state.status === 'workflow_failed' ? (
        <main className="empty-state" role="alert">
          <p className="eyebrow">Request failed</p>
          <h1>Workflow could not be displayed</h1>
          <p>{state.message}</p>
        </main>
      ) : null}

      {state.status === 'idle' ? (
        <main className="empty-state">
          <div className="empty-state__glyph" aria-hidden="true">
            ↗
          </div>
          <p className="eyebrow">Ready to analyze</p>
          <h1>Turn the selected task into a reviewable workflow</h1>
          <p>
            Generation is deterministic and read-only. No provider or remote effect can run in M1.
          </p>
        </main>
      ) : null}

      {state.status === 'showing_workflow' ? <WorkflowDetails response={state.response} /> : null}
    </div>
  );
};
