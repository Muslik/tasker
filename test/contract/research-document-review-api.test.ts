import { afterEach, describe, expect, it } from 'vitest';

import { BlockReceiptStore } from '../../src/steps/index.js';
import { TaskStepOutputArtifactSchema } from '../../src/steps/task-step-output.js';
import { ResearchDocumentReviewWaitDetailsSchema } from '../../src/shared/research-document-review.js';
import { buildOperatorApi } from '../../src/server/operator-api.js';
import { OperatorExecutionAttemptSchema } from '../../src/server/operator-contracts.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/store/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { err, ok, type Outcome } from '../../src/shared/outcome.js';
import {
  BootstrapWorkflowPublicStateSchema,
  ExecutionWorkflowPublicStateSchema,
  type BootstrapWorkflowInput,
  type ExecutionWorkflowPublicState,
  type ResolveBootstrapWaitCommand,
  type TaskRunLifecycle,
  type TaskRunError,
  type TaskRunPublicState,
  type TaskRunService,
} from '../../src/kernel/index.js';

const resources: SqliteLedger[] = [];

afterEach(() => {
  for (const ledger of resources.splice(0)) ledger.close();
});

const bootstrapFor = (taskReference: string) =>
  BootstrapWorkflowPublicStateSchema.parse({
    runtime: 'bootstrap',
    schemaVersion: 3,
    taskReference,
    workflowId: `tasker:v3:${taskReference}`,
    runId: 'bootstrap-run',
    workflowHash: 'a'.repeat(64),
    settings: { planReview: 'automatic', planningStrategy: 'fast' },
    phase: 'execution',
    workspaceContext: null,
    context: null,
    draft: null,
    planning: null,
    activeTranscriptOperationId: null,
    freezeReceipt: null,
    executionWorkflowId: 'execution-workflow',
    nodeStates: { freeze: 'succeeded' },
    attempts: { planning: 1 },
    status: 'completed',
    currentNodeId: null,
    wait: null,
    outcome: 'execution_started',
  });

const researchDocumentReviewRun = (
  taskReference: string,
  runId = 'execution-run',
): ExecutionWorkflowPublicState =>
  ExecutionWorkflowPublicStateSchema.parse({
    runtime: 'execution',
    schemaVersion: 2,
    taskReference,
    workflowId: 'execution-workflow',
    runId,
    workflowHash: 'a'.repeat(64),
    nodeStates: { 'document-review': 'waiting' },
    blockRuns: { 'document-review': 2 },
    loopIterations: {},
    continuations: [],
    retrospective: 'disabled',
    status: 'waiting',
    currentNodeId: 'document-review',
    wait: {
      nodeId: 'document-review',
      waitKind: 'research.document-review@1',
      reason: 'Review the research draft',
    },
    outcome: null,
  });

class ContractTaskRunService implements TaskRunService {
  public readonly resolutions: ResolveBootstrapWaitCommand[] = [];

  public constructor(private current: TaskRunPublicState | null) {}

  public start(input: BootstrapWorkflowInput) {
    void input;
    return Promise.resolve(err({ kind: 'run_input_conflict' as const, taskReference: 'unused' }));
  }

  public read(taskReference: string) {
    if (this.current === null || this.current.taskReference !== taskReference) {
      return Promise.resolve(ok(null));
    }
    return Promise.resolve(ok(this.current));
  }

  public readLifecycle(
    taskReference: string,
  ): Promise<Outcome<TaskRunLifecycle | null, TaskRunError>> {
    if (this.current === null || this.current.taskReference !== taskReference) {
      return Promise.resolve(ok(null));
    }
    const lifecycle =
      this.current.runtime === 'execution'
        ? { bootstrap: bootstrapFor(taskReference), execution: this.current }
        : { bootstrap: this.current, execution: null };
    return Promise.resolve(ok(lifecycle));
  }

  public restart(taskReference: string): Promise<Outcome<TaskRunPublicState, TaskRunError>> {
    return Promise.resolve(err({ kind: 'run_not_restartable' as const, taskReference }));
  }

  public terminate(): Promise<Outcome<void, TaskRunError>> {
    this.current = null;
    return Promise.resolve(ok(undefined));
  }

  public resolveWait(
    taskReference: string,
    command: ResolveBootstrapWaitCommand,
  ): Promise<Outcome<TaskRunPublicState, TaskRunError>> {
    if (this.current === null || this.current.taskReference !== taskReference) {
      return Promise.resolve(err({ kind: 'run_not_found' as const, taskReference }));
    }
    if (this.current.runId !== command.runId) {
      return Promise.resolve(
        err({
          kind: 'stale_run' as const,
          taskReference,
          providedRunId: command.runId,
          activeRunId: this.current.runId,
        }),
      );
    }
    this.resolutions.push(command);
    return Promise.resolve(ok(this.current));
  }
}

const attemptFor = (details: unknown) =>
  OperatorExecutionAttemptSchema.parse({
    schemaVersion: 1,
    taskReference: 'jira:AVIA-12045',
    workflowId: 'execution-workflow',
    workflowRunId: 'execution-run',
    nodeId: 'document-review',
    blockRun: 2,
    transcript: null,
    output: TaskStepOutputArtifactSchema.parse({
      schemaVersion: 4,
      operationId: 'execution-workflow:execution-run:document-review:attempt-2',
      workflowId: 'execution-workflow',
      workflowRunId: 'execution-run',
      nodeId: 'document-review',
      stepReference: 'research.document-review@1',
      stepAttempt: 2,
      runner: 'integration',
      command: null,
      args: [],
      cwd: '/tmp/tasker',
      exitCode: null,
      status: 'blocked',
      stdout: '',
      stderr: '',
      details,
      usage: null,
      result: {
        status: 'blocked',
        summary: 'Research document review is waiting for operator feedback',
        waitKind: 'research.document-review@1',
        category: 'task_ambiguity',
        retryable: true,
        artifactIds: [],
        transcriptId: null,
      },
      recordedAt: '2026-08-29T10:00:00.000Z',
    }),
    evidence: [],
    workspaceChanges: null,
  });

const setup = (input: {
  current?: TaskRunPublicState | null;
  attemptDetails?: unknown;
  withExecutionActivity?: boolean;
}) => {
  const clock = makeAdjustableClock('2026-08-30T00:00:00.000Z');
  const ledger = openSqliteLedger({ filename: ':memory:', clock });
  resources.push(ledger);
  const runs = new ContractTaskRunService(
    input.current ?? researchDocumentReviewRun('jira:AVIA-12045'),
  );
  const api = buildOperatorApi({
    service: {} as never,
    temporalRunService: runs,
    blockReceipts: new BlockReceiptStore(ledger.repository, clock),
    ...(input.withExecutionActivity === false
      ? {}
      : {
          executionActivity: {
            readActivity: () => [],
            readCurrentTranscript: () => null,
            readAttempt: () =>
              attemptFor(
                input.attemptDetails ??
                  ResearchDocumentReviewWaitDetailsSchema.parse({
                    kind: 'research_document_review',
                    documentArtifactId: 'artifact:research-draft',
                    documentStorageHtml: '<p>Draft</p>',
                  }),
              ),
            readRunLog: () => ({
              schemaVersion: 1,
              taskReference: 'jira:AVIA-12045',
              bootstrapRunId: 'bootstrap-run',
              executionRunId: 'execution-run',
              entries: [],
            }),
            readEvidence: () => Promise.resolve({ status: 'failed', message: 'not used' }),
          },
        }),
  });
  return { api, runs };
};

describe('research document review HTTP contract', () => {
  it('resolves an approval against the active execution wait', async () => {
    const { api, runs } = setup({});

    const response = await api.inject({
      method: 'POST',
      url: '/api/workflows/jira:AVIA-12045/research-document-review',
      payload: {
        expectedRunId: 'execution-run',
        blockRun: 2,
        documentArtifactId: 'artifact:research-draft',
        decision: 'approve',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runs.resolutions).toEqual([
      {
        runId: 'execution-run',
        nodeId: 'document-review',
        waitKind: 'research.document-review@1',
        resolution: { decision: 'approve' },
      },
    ]);
    await api.close();
  });

  it('combines annotations into the Temporal change-request resolution', async () => {
    const { api, runs } = setup({});

    const response = await api.inject({
      method: 'POST',
      url: '/api/workflows/jira:AVIA-12045/research-document-review',
      payload: {
        expectedRunId: 'execution-run',
        blockRun: 2,
        documentArtifactId: 'artifact:research-draft',
        decision: 'request_changes',
        guidance: 'Tighten the intro.',
        annotations: [
          {
            quote: 'Need stronger evidence',
            note: '  Cite the supporting KPI.  ',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runs.resolutions).toEqual([
      {
        runId: 'execution-run',
        nodeId: 'document-review',
        waitKind: 'research.document-review@1',
        resolution: {
          decision: 'request_changes',
          guidance:
            'Tighten the intro.\n\n«Фрагмент: "Need stronger evidence" — Cite the supporting KPI.»',
          annotations: [
            {
              quote: 'Need stronger evidence',
              note: 'Cite the supporting KPI.',
            },
          ],
        },
      },
    ]);
    await api.close();
  });

  it('rejects a stale document binding before resolving the wait', async () => {
    const { api, runs } = setup({});

    const response = await api.inject({
      method: 'POST',
      url: '/api/workflows/jira:AVIA-12045/research-document-review',
      payload: {
        expectedRunId: 'execution-run',
        blockRun: 2,
        documentArtifactId: 'artifact:other-draft',
        decision: 'approve',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'stale_research_document_review',
    });
    expect(runs.resolutions).toHaveLength(0);
    await api.close();
  });

  it('rejects invalid review payloads', async () => {
    const { api, runs } = setup({});

    const response = await api.inject({
      method: 'POST',
      url: '/api/workflows/jira:AVIA-12045/research-document-review',
      payload: {
        expectedRunId: 'execution-run',
        blockRun: 2,
        documentArtifactId: 'artifact:research-draft',
        decision: 'request_changes',
        annotations: [],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'invalid_research_document_review',
    });
    expect(runs.resolutions).toHaveLength(0);
    await api.close();
  });

  it('requires the dedicated command instead of generic resume', async () => {
    const { api, runs } = setup({});

    const response = await api.inject({
      method: 'POST',
      url: '/api/workflows/jira:AVIA-12045/resume',
      payload: {
        expectedRunId: 'execution-run',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'typed_resolution_required',
    });
    expect(runs.resolutions).toHaveLength(0);
    await api.close();
  });

  it('returns 503 when execution activity is unavailable', async () => {
    const { api } = setup({ withExecutionActivity: false });

    const response = await api.inject({
      method: 'POST',
      url: '/api/workflows/jira:AVIA-12045/research-document-review',
      payload: {
        expectedRunId: 'execution-run',
        blockRun: 2,
        documentArtifactId: 'artifact:research-draft',
        decision: 'approve',
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: 'execution_activity_unavailable',
    });
    await api.close();
  });
});
