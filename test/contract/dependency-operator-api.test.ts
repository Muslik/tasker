import { afterEach, describe, expect, it } from 'vitest';

import { BlockReceiptStore } from '../../src/blocks/index.js';
import {
  DependencyDeclarationStore,
  DependencyOperatorService,
  VerifiedPackagePublicationStore,
  buildOperatorApi,
  createOperatorWorkflowService,
} from '../../src/control-plane/index.js';
import { dependencyDeclarationIdFor } from '../../src/control-plane/dependency-declaration.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import type { JiraIssueService } from '../../src/integrations/jira/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { ok, type Outcome } from '../../src/shared/outcome.js';
import {
  BootstrapWorkflowInputSchema,
  BootstrapWorkflowPublicStateSchema,
  TaskRunLifecycleSchema,
  type BootstrapWorkflowInput,
  type ResolveBootstrapWaitCommand,
  type TaskRunError,
  type TaskRunLifecycle,
  type TaskRunPublicState,
  type TaskRunService,
} from '../../src/temporal/index.js';
import { makeJiraSnapshot } from '../helpers/jira.js';

const resources: SqliteLedger[] = [];

afterEach(() => {
  for (const ledger of resources.splice(0)) ledger.close();
});

const taskReference = 'jira:AVIA-12045';

const persistWorkflowChangeRequest = (ledger: SqliteLedger, requestArtifactId: string): void => {
  const recorded = ledger.repository.transact({
    artifacts: [
      {
        artifactId: requestArtifactId,
        artifactKind: 'task_step_output',
        storageUri: `ledger://artifacts/${requestArtifactId}`,
        payload: {
          schemaVersion: 4,
          operationId: 'tasker:execution:workflow-change:1',
          workflowId: 'workflow-1',
          workflowRunId: 'run-1',
          nodeId: 'implement-step',
          stepReference: 'implement.change@1',
          stepAttempt: 1,
          runner: 'agent',
          command: 'codex',
          args: [],
          cwd: '/workspace/front-avia',
          exitCode: 0,
          status: 'workflow_change_required',
          stdout: '',
          stderr: '',
          details: {
            request: {
              schemaVersion: 1,
              discoveredAtNodeId: 'implement-step',
              summary: 'Need a package from another repository',
              evidenceArtifactIds: ['evidence:1'],
              changes: [
                {
                  kind: 'cross_repository_dependency',
                  repository: 'front-core-packages',
                  requestedOutcome: 'Publish @ott/fare-card and continue',
                  componentPath: 'packages/@ott/fare-card',
                },
              ],
            },
          },
          usage: null,
          result: {
            status: 'workflow_change_required',
            summary: 'Need a package from another repository',
            artifactIds: [],
            transcriptId: null,
            request: {
              schemaVersion: 1,
              discoveredAtNodeId: 'implement-step',
              summary: 'Need a package from another repository',
              evidenceArtifactIds: ['evidence:1'],
              changes: [
                {
                  kind: 'cross_repository_dependency',
                  repository: 'front-core-packages',
                  requestedOutcome: 'Publish @ott/fare-card and continue',
                  componentPath: 'packages/@ott/fare-card',
                },
              ],
            },
          },
          recordedAt: '2026-08-25T10:00:00.000Z',
        },
        metadata: {},
        createdAt: '2026-08-25T10:00:00.000Z',
      },
    ],
    timestamp: '2026-08-25T10:00:00.000Z',
  });
  if (!recorded.ok) throw new Error(recorded.error.kind);
};

const availableLifecycle = (declarationId: string, declarationRevision: number): TaskRunLifecycle =>
  TaskRunLifecycleSchema.parse({
    bootstrap: {
      runtime: 'bootstrap',
      schemaVersion: 3,
      taskReference,
      workflowId: 'bootstrap-workflow',
      runId: 'bootstrap-run',
      workflowHash: 'a'.repeat(64),
      settings: { planReview: 'automatic', planningStrategy: 'fast' },
      phase: 'execution',
      workspaceContext: null,
      context: null,
      draft: {
        semanticHash: 'b'.repeat(64),
        compilerVersion: 'semantic-workflow-v1',
        harnessSnapshotHash: 'c'.repeat(64),
        retrospectiveEnabled: true,
        workflowHash: 'a'.repeat(64),
        graph: {
          metadata: {
            compilerVersion: 4,
            irVersion: 'workflow-ir-v1',
            workflowId: 'execution-workflow',
            workflowVersion: 1,
            references: { predicates: [], stepTypes: ['dependency.await_packages@1'], waits: [] },
          },
          root: {
            kind: 'step',
            id: 'await-shared-package',
            uses: 'dependency.await_packages@1',
            activityDelivery: { kind: 'read_only' },
            with: {
              objective: 'Continue after the shared package is published',
              repository: 'onetwotrip/front-avia',
              taskId: 'AVIA-12045',
              declarationId,
              declarationRevision,
              channel: 'final',
              packages: ['@ott/fare-card'],
            },
          },
        },
        planningSnapshot: { artifactId: 'planning-snapshot', checksum: 'd'.repeat(64) },
        evidenceBundle: { artifactId: 'evidence-bundle', checksum: 'e'.repeat(64), revision: 1 },
      },
      planning: null,
      activeTranscriptOperationId: null,
      freezeReceipt: null,
      executionWorkflowId: 'execution-workflow',
      nodeStates: {},
      attempts: {},
      status: 'completed',
      currentNodeId: null,
      wait: null,
      outcome: 'execution_started',
    },
    execution: {
      runtime: 'execution',
      schemaVersion: 2,
      taskReference,
      workflowId: 'execution-workflow',
      runId: 'execution-run',
      workflowHash: 'a'.repeat(64),
      nodeStates: { 'await-shared-package': 'waiting' },
      blockRuns: { 'await-shared-package': 1 },
      loopIterations: {},
      continuations: [],
      retrospective: 'disabled',
      status: 'waiting',
      currentNodeId: 'await-shared-package',
      wait: {
        nodeId: 'await-shared-package',
        waitKind: 'dependency.available@1',
        reason: 'Waiting for published versions',
      },
      outcome: null,
    },
  });

const discoveryLifecycle = (requestArtifactId: string): TaskRunLifecycle =>
  TaskRunLifecycleSchema.parse({
    bootstrap: {
      runtime: 'bootstrap',
      schemaVersion: 3,
      taskReference,
      workflowId: 'bootstrap-workflow',
      runId: 'bootstrap-run',
      workflowHash: 'f'.repeat(64),
      settings: { planReview: 'automatic', planningStrategy: 'fast' },
      phase: 'execution',
      workspaceContext: null,
      context: null,
      draft: null,
      planning: null,
      activeTranscriptOperationId: null,
      freezeReceipt: null,
      executionWorkflowId: 'execution-workflow',
      nodeStates: {},
      attempts: {},
      status: 'completed',
      currentNodeId: null,
      wait: null,
      outcome: 'execution_started',
    },
    execution: {
      runtime: 'execution',
      schemaVersion: 2,
      taskReference,
      workflowId: 'execution-workflow',
      runId: 'execution-run',
      workflowHash: 'f'.repeat(64),
      nodeStates: { implement: 'waiting' },
      blockRuns: { implement: 1 },
      loopIterations: {},
      continuations: [
        {
          continuationId: 'execution-run:continuation-1',
          attempt: 1,
          parentNodeId: 'implement',
          requestReference: requestArtifactId,
          reason: 'Need dependency configuration',
          transcriptOperationId: 'continuation:1',
          status: 'needs_input',
        },
      ],
      retrospective: 'disabled',
      status: 'waiting',
      currentNodeId: 'implement',
      wait: {
        nodeId: 'implement',
        waitKind: 'dependency.discovery@1',
        reason: 'Waiting for dependency declaration',
      },
      outcome: null,
    },
  });

class DependencyTaskRunService implements TaskRunService {
  public readonly resolutions: ResolveBootstrapWaitCommand[] = [];
  private current: TaskRunPublicState | null = null;
  private lifecycle: TaskRunLifecycle | null = null;
  public nextResolveError: TaskRunError | null = null;

  public setLifecycle(lifecycle: TaskRunLifecycle | null): void {
    this.lifecycle = lifecycle;
    this.current = lifecycle?.execution ?? lifecycle?.bootstrap ?? null;
  }

  public start(inputValue: BootstrapWorkflowInput) {
    const input = BootstrapWorkflowInputSchema.parse(inputValue);
    const current = BootstrapWorkflowPublicStateSchema.parse({
      runtime: 'bootstrap',
      schemaVersion: 3,
      taskReference: input.taskReference,
      workflowId: `tasker:v3:${input.taskReference}`,
      runId: 'run-1',
      workflowHash: null,
      settings: input.settings,
      phase: 'plan_review',
      workspaceContext: null,
      context: null,
      draft: null,
      planning: null,
      activeTranscriptOperationId: null,
      freezeReceipt: null,
      executionWorkflowId: null,
      nodeStates: { plan_review: 'waiting' },
      attempts: { planning: 1 },
      status: 'waiting',
      currentNodeId: 'plan_review',
      wait: { nodeId: 'plan_review', waitKind: 'plan.approved@1' },
      outcome: null,
    });
    this.current = current;
    this.lifecycle = { bootstrap: current, execution: null };
    return Promise.resolve(ok(current));
  }

  public read(): Promise<Outcome<TaskRunPublicState | null, TaskRunError>> {
    return Promise.resolve(ok(this.current));
  }

  public readLifecycle(): Promise<Outcome<TaskRunLifecycle | null, TaskRunError>> {
    return Promise.resolve(ok(this.lifecycle));
  }

  public restart(): Promise<Outcome<TaskRunPublicState, TaskRunError>> {
    throw new Error('restart is not used in dependency contract tests');
  }

  public terminate(): Promise<Outcome<void, TaskRunError>> {
    this.current = null;
    this.lifecycle = null;
    return Promise.resolve(ok(undefined));
  }

  public resolveWait(
    taskReference: string,
    command: ResolveBootstrapWaitCommand,
  ): Promise<Outcome<TaskRunPublicState, TaskRunError>> {
    this.resolutions.push(command);
    if (this.nextResolveError !== null) {
      const failure = this.nextResolveError;
      this.nextResolveError = null;
      return Promise.resolve({
        ok: false,
        error:
          failure.kind === 'stale_run'
            ? failure
            : {
                kind: 'stale_run',
                taskReference,
                providedRunId: command.runId,
                activeRunId: 'execution-run',
              },
      });
    }
    if (this.current === null) throw new Error('Expected a current run');
    return Promise.resolve(ok(this.current));
  }
}

const setup = () => {
  const clock = makeAdjustableClock('2026-08-25T10:00:00.000Z');
  const ledger = openSqliteLedger({ filename: ':memory:', clock });
  resources.push(ledger);
  const declarations = new DependencyDeclarationStore(ledger.repository, clock);
  const publications = new VerifiedPackagePublicationStore(ledger.repository, clock);
  const runs = new DependencyTaskRunService();
  const observer = {
    observe: () =>
      Promise.resolve(
        ok({
          channel: 'final' as const,
          observedAt: '2026-08-25T10:02:00.000Z',
          packages: [
            {
              packageName: '@ott/fare-card',
              version: '1.2.3',
              registry: 'https://registry.npmjs.org',
              tarballUrl: 'https://registry.npmjs.org/@ott/fare-card/-/fare-card-1.2.3.tgz',
              integrity: null,
              shasum: 'abc123',
            },
          ],
        }),
      ),
  };
  const dependencyOperator = new DependencyOperatorService(
    declarations,
    ledger.repository,
    publications,
    observer,
  );
  const jiraIssueService = {
    read: () =>
      ok({
        status: 'current' as const,
        issue: makeJiraSnapshot({
          issueKey: 'AVIA-12045',
          links: [
            {
              linkId: '118870',
              linkTypeId: '10016',
              linkTypeName: 'Blocks',
              direction: 'outward',
              issueKey: 'AVIA-11999',
              summary: 'Publish the shared fare card package',
              relationship: 'blocks',
              status: 'Open',
            },
          ],
        }),
        lastSuccessfulSyncAt: '2026-08-25T10:00:00.000Z',
        recordedAt: '2026-08-25T10:00:00.000Z',
      }),
  } as unknown as JiraIssueService;
  const api = buildOperatorApi({
    service: createOperatorWorkflowService(ledger.repository, clock),
    dependencyOperator,
    dependencyDeclarations: declarations,
    artifacts: ledger.repository,
    verifiedPackagePublications: publications,
    jiraIssueService,
    temporalRunService: runs,
    blockReceipts: new BlockReceiptStore(ledger.repository, clock),
  });
  return { api, declarations, publications, ledger, runs };
};

describe('dependency operator HTTP contract', () => {
  it('persists a known dependency and exposes it through the operator projection before a run starts', async () => {
    const { api } = setup();

    const configured = await api.inject({
      method: 'POST',
      url: `/api/operator/tasks/${encodeURIComponent(taskReference)}/dependencies/configure`,
      payload: {
        consumerTaskReference: taskReference,
        producerTaskReference: 'jira:AVIA-11999',
        producerRepository: 'front-core-packages',
        packages: ['@ott/fare-card'],
        mode: 'validate_dev_then_final',
        source: {
          kind: 'jira_link',
          linkId: '118870',
          linkTypeId: '10016',
          direction: 'outward',
        },
      },
    });
    const projection = await api.inject({
      method: 'GET',
      url: `/api/operator/tasks/${encodeURIComponent(taskReference)}/projection`,
    });

    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({
      consumerTaskReference: taskReference,
      producerTaskReference: 'jira:AVIA-11999',
      revision: 1,
    });
    expect(projection.statusCode).toBe(200);
    expect(projection.json()).toMatchObject({
      status: 'not_started',
      dependencies: [
        {
          producerTaskReference: 'jira:AVIA-11999',
          producerRepository: 'front-core-packages',
          packages: ['@ott/fare-card'],
          mode: 'validate_dev_then_final',
          source: { kind: 'jira_link', linkId: '118870' },
        },
      ],
    });
    await api.close();
  });

  it('rejects a known dependency that is not backed by the imported Jira Blocks link', async () => {
    const { api } = setup();

    const response = await api.inject({
      method: 'POST',
      url: `/api/operator/tasks/${encodeURIComponent(taskReference)}/dependencies/configure`,
      payload: {
        consumerTaskReference: taskReference,
        producerTaskReference: 'jira:AVIA-11999',
        producerRepository: 'front-core-packages',
        packages: ['@ott/fare-card'],
        mode: 'final_only',
        source: {
          kind: 'jira_link',
          linkId: 'wrong-link',
          linkTypeId: '10016',
          direction: 'outward',
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'dependency_jira_link_mismatch' });
    await api.close();
  });

  it('records a verified package publication before resolving dependency.available@1', async () => {
    const { api, declarations, publications, runs } = setup();
    const declaration = declarations.declare({
      consumerTaskReference: taskReference,
      producerTaskReference: 'jira:AVIA-11999',
      producerRepository: 'front-core-packages',
      packages: ['@ott/fare-card'],
      mode: 'final_only',
      source: {
        kind: 'runtime_discovery',
        workflowRunId: 'execution-run',
        requestArtifactId: 'artifact:workflow-change-request:1',
      },
    });
    if (!declaration.ok) throw new Error(declaration.error.kind);
    runs.setLifecycle(
      availableLifecycle(declaration.value.declarationId, declaration.value.revision),
    );

    const response = await api.inject({
      method: 'POST',
      url: `/api/workflows/${encodeURIComponent(taskReference)}/dependency/available`,
      payload: {
        expectedRunId: 'execution-run',
        nodeId: 'await-shared-package',
        waitKind: 'dependency.available@1',
        declarationId: declaration.value.declarationId,
        declarationRevision: declaration.value.revision,
        channel: 'final',
        packages: [{ name: '@ott/fare-card', version: '1.2.3' }],
      },
    });
    const observationId = (
      runs.resolutions.at(-1)?.resolution as { observationId?: string } | undefined
    )?.observationId;
    const recorded =
      observationId === undefined ? { ok: false as const } : publications.read(observationId);

    expect(response.statusCode).toBe(200);
    expect(runs.resolutions.at(-1)).toMatchObject({
      waitKind: 'dependency.available@1',
      resolution: {
        decision: 'recheck',
        declarationId: declaration.value.declarationId,
        declarationRevision: declaration.value.revision,
      },
    });
    expect(recorded).toMatchObject({
      ok: true,
      value: {
        channel: 'final',
        packages: [{ name: '@ott/fare-card', integrity: 'sha1-abc123' }],
      },
    });
    await api.close();
  });

  it('persists the verified publication before a stale resolveWait response on dependency.available@1', async () => {
    const { api, declarations, publications, runs } = setup();
    const declaration = declarations.declare({
      consumerTaskReference: taskReference,
      producerTaskReference: 'jira:AVIA-11999',
      producerRepository: 'front-core-packages',
      packages: ['@ott/fare-card'],
      mode: 'final_only',
      source: {
        kind: 'runtime_discovery',
        workflowRunId: 'execution-run',
        requestArtifactId: 'artifact:workflow-change-request:1',
      },
    });
    if (!declaration.ok) throw new Error(declaration.error.kind);
    runs.setLifecycle(
      availableLifecycle(declaration.value.declarationId, declaration.value.revision),
    );
    runs.nextResolveError = {
      kind: 'stale_run',
      taskReference,
      providedRunId: 'execution-run',
      activeRunId: 'execution-run:newer',
    };

    const response = await api.inject({
      method: 'POST',
      url: `/api/workflows/${encodeURIComponent(taskReference)}/dependency/available`,
      payload: {
        expectedRunId: 'execution-run',
        nodeId: 'await-shared-package',
        waitKind: 'dependency.available@1',
        declarationId: declaration.value.declarationId,
        declarationRevision: declaration.value.revision,
        channel: 'final',
        packages: [{ name: '@ott/fare-card', version: '1.2.3' }],
      },
    });
    const observationId = (
      runs.resolutions.at(-1)?.resolution as { observationId?: string } | undefined
    )?.observationId;
    const recorded =
      observationId === undefined ? { ok: false as const } : publications.read(observationId);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'stale_run' });
    expect(recorded).toMatchObject({
      ok: true,
      value: { declarationId: declaration.value.declarationId },
    });
    await api.close();
  });

  it('configures dependency.discovery@1 from the active continuation request artifact', async () => {
    const { api, declarations, ledger, runs } = setup();
    persistWorkflowChangeRequest(ledger, 'artifact:workflow-change-request:1');
    runs.setLifecycle(discoveryLifecycle('artifact:workflow-change-request:1'));

    const response = await api.inject({
      method: 'POST',
      url: `/api/workflows/${encodeURIComponent(taskReference)}/dependency/discovery`,
      payload: {
        expectedRunId: 'execution-run',
        nodeId: 'implement',
        waitKind: 'dependency.discovery@1',
        requestArtifactId: 'artifact:workflow-change-request:1',
        producerTaskReference: 'jira:AVIA-11999',
        producerRepository: 'front-core-packages',
        packages: ['@ott/fare-card'],
        mode: 'validate_dev_then_final',
      },
    });
    const declarationId = dependencyDeclarationIdFor(taskReference, {
      kind: 'runtime_discovery',
      workflowRunId: 'execution-run',
      requestArtifactId: 'artifact:workflow-change-request:1',
    });
    const declaration = declarations.readLatest(declarationId);

    expect(response.statusCode).toBe(200);
    expect(runs.resolutions.at(-1)).toMatchObject({
      waitKind: 'dependency.discovery@1',
      resolution: {
        decision: 'configured',
        requestArtifactId: 'artifact:workflow-change-request:1',
        declarationId,
      },
    });
    expect(declaration).toMatchObject({
      ok: true,
      value: {
        producerTaskReference: 'jira:AVIA-11999',
        producerRepository: 'front-core-packages',
        packages: ['@ott/fare-card'],
        mode: 'validate_dev_then_final',
      },
    });
    await api.close();
  });

  it('does not let a stale discovery declaration satisfy a newer workflow run', async () => {
    const { api, declarations, ledger, runs } = setup();
    persistWorkflowChangeRequest(ledger, 'artifact:workflow-change-request:1');
    runs.setLifecycle(discoveryLifecycle('artifact:workflow-change-request:1'));
    runs.nextResolveError = {
      kind: 'stale_run',
      taskReference,
      providedRunId: 'execution-run',
      activeRunId: 'execution-run:newer',
    };

    const response = await api.inject({
      method: 'POST',
      url: `/api/workflows/${encodeURIComponent(taskReference)}/dependency/discovery`,
      payload: {
        expectedRunId: 'execution-run',
        nodeId: 'implement',
        waitKind: 'dependency.discovery@1',
        requestArtifactId: 'artifact:workflow-change-request:1',
        producerTaskReference: 'jira:AVIA-11999',
        producerRepository: 'front-core-packages',
        packages: ['@ott/fare-card'],
        mode: 'validate_dev_then_final',
      },
    });
    const newerDeclarationId = dependencyDeclarationIdFor(taskReference, {
      kind: 'runtime_discovery',
      workflowRunId: 'execution-run:newer',
      requestArtifactId: 'artifact:workflow-change-request:1',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'stale_run' });
    expect(declarations.readLatest(newerDeclarationId)).toEqual({ ok: true, value: null });
    await api.close();
  });
});
