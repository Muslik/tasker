import { describe, expect, it } from 'vitest';

import { blockReceiptId } from '../steps/index.js';
import { createOperatorWorkflowProjection } from './operator-workflow-projection.js';
import { ok } from '../shared/outcome.js';
import { TaskRunLifecycleSchema } from '../steps/public-state.js';

const availableLifecycle = TaskRunLifecycleSchema.parse({
  bootstrap: {
    runtime: 'bootstrap',
    schemaVersion: 3,
    taskReference: 'jira:AVIA-12045',
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
            declarationId: 'dependency-declaration:runtime-discovery:artifact:1:jira:AVIA-12045',
            declarationRevision: 2,
            channel: 'final',
            packages: ['@ott/fare-card'],
            afterObservationId: 'verified-package-publication:operation:available',
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
    taskReference: 'jira:AVIA-12045',
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

const discoveryLifecycle = TaskRunLifecycleSchema.parse({
  bootstrap: {
    runtime: 'bootstrap',
    schemaVersion: 3,
    taskReference: 'jira:AVIA-12045',
    workflowId: 'bootstrap-workflow',
    runId: 'bootstrap-run',
    workflowHash: null,
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
    taskReference: 'jira:AVIA-12045',
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
        requestReference: 'artifact:workflow-change-request:1',
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

describe('dependency operator projection', () => {
  it('classifies dependency.available@1 as a typed resolution with recorded observation details', () => {
    const projection = createOperatorWorkflowProjection(
      'jira:AVIA-12045',
      availableLifecycle,
      { read: () => ok(null) },
      () => null,
      () => null,
      () => null,
      {
        listDeclarations: () => [],
        readDeclaration: () => null,
        readPublication: () => ({
          schemaVersion: 1,
          observationId: 'verified-package-publication:operation:available',
          declarationId: 'dependency-declaration:runtime-discovery:artifact:1:jira:AVIA-12045',
          declarationRevision: 2,
          producerTaskReference: 'jira:AVIA-11999',
          channel: 'final',
          packages: [
            {
              name: '@ott/fare-card',
              version: '1.2.3',
              registry: 'https://registry.npmjs.org',
              tarballUrl: 'https://registry.npmjs.org/@ott/fare-card/-/fare-card-1.2.3.tgz',
              integrity: 'sha512-verified',
            },
          ],
          sourceOperationId: 'operator:dependency.available',
          observedAt: '2026-08-25T10:02:00.000Z',
        }),
        readArtifact: () => null,
      },
    );

    expect(projection.current).toMatchObject({
      status: 'waiting',
      intervention: {
        kind: 'typed_resolution',
        waitKind: 'dependency.available@1',
        details: {
          kind: 'dependency_available',
          declarationRevision: 2,
          observation: {
            status: 'recorded',
            observationId: 'verified-package-publication:operation:available',
          },
        },
      },
    });
  });

  it('classifies dependency.discovery@1 from the active continuation request artifact', () => {
    const projection = createOperatorWorkflowProjection(
      'jira:AVIA-12045',
      discoveryLifecycle,
      { read: () => ok(null) },
      () => null,
      () => null,
      () => null,
      {
        listDeclarations: () => [],
        readDeclaration: () => null,
        readPublication: () => null,
        readArtifact: () => ({
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
        }),
      },
    );

    expect(projection.current).toMatchObject({
      status: 'waiting',
      intervention: {
        kind: 'typed_resolution',
        waitKind: 'dependency.discovery@1',
        details: {
          kind: 'dependency_discovery',
          requestArtifactId: 'artifact:workflow-change-request:1',
          requestedRepository: 'front-core-packages',
          expectedPackage: '@ott/fare-card',
          declaration: { status: 'missing' },
        },
      },
    });
  });

  it('surfaces claim category and retryability on projected block receipts', () => {
    const lifecycle = TaskRunLifecycleSchema.parse({
      bootstrap: {
        runtime: 'bootstrap',
        schemaVersion: 3,
        taskReference: 'jira:AVIA-12045',
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
              references: { predicates: [], stepTypes: ['implement.change@1'], waits: [] },
            },
            root: {
              kind: 'step',
              id: 'implement-change',
              uses: 'implement.change@1',
              activityDelivery: { kind: 'workspace_reconciled' },
              with: {},
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
        taskReference: 'jira:AVIA-12045',
        workflowId: 'execution-workflow',
        runId: 'execution-run',
        workflowHash: 'a'.repeat(64),
        nodeStates: { 'implement-change': 'waiting' },
        blockRuns: { 'implement-change': 1 },
        loopIterations: {},
        continuations: [],
        retrospective: 'disabled',
        status: 'waiting',
        currentNodeId: 'implement-change',
        wait: {
          nodeId: 'implement-change',
          waitKind: 'code_review@1',
          reason: 'Waiting for review approval',
        },
        outcome: null,
      },
    });
    const receiptId = blockReceiptId({
      workflowId: 'execution-workflow',
      workflowRunId: 'execution-run',
      nodeId: 'implement-change',
      blockRun: 1,
    });

    const projection = createOperatorWorkflowProjection(
      'jira:AVIA-12045',
      lifecycle,
      {
        read: (candidateReceiptId) =>
          ok(
            candidateReceiptId === receiptId
              ? {
                  schemaVersion: 7,
                  receiptId,
                  blockReference: 'implement.change@1',
                  blockDefinitionHash: 'f'.repeat(64),
                  taskReference: 'jira:AVIA-12045',
                  workflowId: 'execution-workflow',
                  workflowRunId: 'execution-run',
                  workflowHash: 'a'.repeat(64),
                  nodeId: 'implement-change',
                  blockRun: 1,
                  claim: {
                    status: 'blocked',
                    summary: 'Waiting for review approval',
                    waitKind: 'code_review@1',
                    category: 'dependency',
                    retryable: true,
                  },
                  verdict: {
                    status: 'waiting',
                    waitKind: 'code_review@1',
                    summary: 'Waiting for review approval',
                  },
                  predicateFacts: {},
                  evidence: [],
                  transcriptReference: null,
                  usageReference: null,
                  usage: null,
                  completedAt: '2026-08-25T10:01:00.000Z',
                }
              : null,
          ),
      },
      () => null,
      () => null,
      () => null,
      {
        listDeclarations: () => [],
        readDeclaration: () => null,
        readPublication: () => null,
        readArtifact: () => null,
      },
    );

    const step = projection.stages
      .flatMap((stage) => stage.steps)
      .find((candidate) => candidate.kind === 'agent' && candidate.id === 'implement-change');

    expect(step).toMatchObject({
      kind: 'agent',
      receipts: [
        {
          receiptId,
          claimStatus: 'blocked',
          category: 'dependency',
          retryable: true,
        },
      ],
    });
  });
});
