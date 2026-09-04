import { describe, expect, it } from 'vitest';

import {
  DependencyDeclarationStore,
  DependencyOperatorService,
  VerifiedPackagePublicationStore,
} from '../../../src/server/index.js';
import { openSqliteLedger } from '../../../src/store/index.js';
import type { JsonValue } from '../../../src/store/types.js';
import { makeAdjustableClock } from '../../../src/shared/clock.js';
import { ok } from '../../../src/shared/outcome.js';
import { TaskRunLifecycleSchema } from '../../../src/steps/public-state.js';

const taskReference = 'jira:AVIA-12045';

const requestArtifact = {
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
} as const;

const discoveryRun = TaskRunLifecycleSchema.parse({
  bootstrap: {
    runtime: 'bootstrap',
    schemaVersion: 3,
    taskReference,
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
    taskReference,
    workflowId: 'execution-workflow',
    runId: 'execution-run',
    workflowHash: 'a'.repeat(64),
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

describe('DependencyOperatorService', () => {
  it('restores an existing publication observation without re-observing Nexus', async () => {
    const clock = makeAdjustableClock('2026-08-25T10:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const declarations = new DependencyDeclarationStore(ledger.repository, clock);
      const publications = new VerifiedPackagePublicationStore(ledger.repository, clock);
      const observedVersions: string[] = [];
      const service = new DependencyOperatorService(declarations, ledger.repository, publications, {
        observe: (input) => {
          observedVersions.push(input.packages[0]?.version ?? '');
          return Promise.resolve(
            ok({
              channel: input.channel,
              observedAt: '2026-08-25T10:01:00.000Z',
              packages: [
                {
                  packageName: '@ott/fare-card',
                  version: input.packages[0]?.version ?? '1.2.3',
                  registry: 'https://registry.npmjs.org',
                  tarballUrl: 'https://registry.npmjs.org/@ott/fare-card/-/fare-card-1.2.3.tgz',
                  integrity: 'sha512-verified',
                  shasum: null,
                },
              ],
            }),
          );
        },
      });
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
      const lifecycle = TaskRunLifecycleSchema.parse({
        ...discoveryRun,
        bootstrap: {
          ...discoveryRun.bootstrap,
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
                references: {
                  predicates: [],
                  stepTypes: ['dependency.await_packages@1'],
                  waits: [],
                },
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
                  declarationId: declaration.value.declarationId,
                  declarationRevision: declaration.value.revision,
                  channel: 'final',
                  packages: ['@ott/fare-card'],
                },
              },
            },
            planningSnapshot: { artifactId: 'planning-snapshot', checksum: 'd'.repeat(64) },
            evidenceBundle: {
              artifactId: 'evidence-bundle',
              checksum: 'e'.repeat(64),
              revision: 1,
            },
          },
        },
        execution: {
          ...discoveryRun.execution,
          nodeStates: { 'await-shared-package': 'waiting' },
          blockRuns: { 'await-shared-package': 1 },
          currentNodeId: 'await-shared-package',
          continuations: [],
          wait: {
            nodeId: 'await-shared-package',
            waitKind: 'dependency.available@1',
            reason: 'Waiting for published versions',
          },
        },
      });
      if (lifecycle.execution === null) throw new Error('Expected execution lifecycle');
      if (lifecycle.execution.status !== 'waiting') throw new Error('Expected waiting execution');
      const execution = lifecycle.execution;
      const first = await service.prepareAvailableResolution(taskReference, lifecycle, execution, {
        expectedRunId: 'execution-run',
        nodeId: 'await-shared-package',
        waitKind: 'dependency.available@1',
        declarationId: declaration.value.declarationId,
        declarationRevision: declaration.value.revision,
        channel: 'final',
        packages: [{ name: '@ott/fare-card', version: '1.2.3' }],
      });
      const second = await service.prepareAvailableResolution(taskReference, lifecycle, execution, {
        expectedRunId: 'execution-run',
        nodeId: 'await-shared-package',
        waitKind: 'dependency.available@1',
        declarationId: declaration.value.declarationId,
        declarationRevision: declaration.value.revision,
        channel: 'final',
        packages: [{ name: '@ott/fare-card', version: '1.2.3' }],
      });

      expect(first).toMatchObject({ ok: true });
      expect(second).toMatchObject({ ok: true });
      expect(observedVersions).toEqual(['1.2.3']);
    } finally {
      ledger.close();
    }
  });

  it('rejects a discovery declaration that conflicts with the active request artifact boundary', () => {
    const clock = makeAdjustableClock('2026-08-25T10:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const service = new DependencyOperatorService(
        new DependencyDeclarationStore(ledger.repository, clock),
        {
          readArtifact: (artifactId) =>
            artifactId === 'artifact:workflow-change-request:1'
              ? {
                  artifactId,
                  artifactKind: 'task_step_output',
                  taskReference: null,
                  storageUri: `ledger://artifacts/${artifactId}`,
                  payload: JSON.parse(JSON.stringify(requestArtifact.payload)) as JsonValue,
                  metadata: {},
                  checksum: 'a'.repeat(64),
                  createdAt: '2026-08-25T10:00:00.000Z',
                  parentArtifactId: null,
                }
              : null,
        },
        new VerifiedPackagePublicationStore(ledger.repository, clock),
        {
          observe: () => Promise.resolve(ok({ channel: 'final', observedAt: '', packages: [] })),
        },
      );
      if (discoveryRun.execution === null) throw new Error('Expected discovery execution');
      if (discoveryRun.execution.status !== 'waiting')
        throw new Error('Expected waiting discovery');

      const result = service.prepareDiscoveryResolution(taskReference, discoveryRun.execution, {
        expectedRunId: 'execution-run',
        nodeId: 'implement',
        waitKind: 'dependency.discovery@1',
        requestArtifactId: 'artifact:workflow-change-request:1',
        producerTaskReference: 'jira:AVIA-11999',
        producerRepository: 'wrong-repository',
        packages: ['@ott/fare-card'],
        mode: 'validate_dev_then_final',
      });

      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'wait_input_mismatch',
          waitKind: 'dependency.discovery@1',
          reason:
            'The submitted dependency declaration does not match the active workflow-change request',
        },
      });
    } finally {
      ledger.close();
    }
  });
});
