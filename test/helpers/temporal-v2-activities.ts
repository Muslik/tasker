import type { BootstrapWorkflowActivities } from '../../src/temporal/bootstrap-kernel/contracts.js';
import type { ExecutionWorkflowActivities } from '../../src/temporal/execution-kernel/contracts.js';

const HASH = '0'.repeat(64);

export const testTemporalV2Activities = {
  prepareTaskWorkspace: (input) => {
    const workspace = {
      schemaVersion: 1 as const,
      workspaceId: '0'.repeat(24),
      taskReference: input.taskReference,
      workflowId: input.workflowId,
      workflowRunId: input.workflowRunId,
      workflowHash: input.workflowHash,
      repository: {
        reference: 'fixture/repository',
        sourcePath: '/tasker/repositories/fixture',
        baseCommit: '0'.repeat(40),
      },
      runnerId: 'temporal-v2-test',
      path: '/tasker/worktrees/fixture',
      branch: `tasker/${input.taskReference}`,
      preparedAt: '2026-08-09T00:00:00.000Z',
    };
    return Promise.resolve({
      workspace,
      bootstrap: {
        schemaVersion: 1 as const,
        operationId: `workspace:${workspace.workspaceId}:bootstrap@1`,
        workspaceId: workspace.workspaceId,
        adapterId: 'temporal-v2-test',
        adapterVersion: '1',
        profile: 'fixture',
        files: [],
        completedAt: '2026-08-09T00:00:00.000Z',
      },
      runtime: {
        schemaVersion: 1 as const,
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.path,
        repositorySourcePath: workspace.repository.sourcePath,
        policyHash: HASH,
        policy: {
          engine: 'docker' as const,
          image: { kind: 'prebuilt' as const, reference: 'tasker/workspace:test' },
          workspaceMountPath: '/workspace',
          environment: {},
          bootstrap: [],
          cacheVolumes: [],
          services: [],
        },
        image: 'tasker/workspace:test',
        imageId: 'sha256:test',
        networkName: `tasker-network-${workspace.workspaceId}`,
        volumes: [],
        services: [],
        environment: {},
        initializedVolumes: [],
        completedBootstrap: [],
        status: 'ready' as const,
        preparedAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
      },
      planningSnapshot: {
        artifactId: `planning-snapshot:${input.taskReference}:${input.workflowHash}`,
        checksum: HASH,
      },
    });
  },
  planTaskImplementation: (input) =>
    Promise.resolve({
      status: 'ready' as const,
      commandId: input.commandId,
      transcriptId: `planning-transcript:${input.commandId}`,
      attempt: 1,
      artifactId: `test-plan:${input.taskReference}`,
      evidenceBundle: {
        artifactId: `evidence-bundle:${input.taskReference}:r1:test`,
        checksum: HASH,
        revision: 1,
      },
      requestedStrategy: input.requestedStrategy,
      selectedStrategy:
        input.requestedStrategy === 'ralplan' ? ('ralplan' as const) : ('fast' as const),
      receipt: {
        status: 'completed' as const,
        provider: 'deterministic' as const,
        plannerVersion: 'implementation-planner@2',
        profile: 'deterministic',
        profileSha256: HASH,
        cliVersion: 'temporal-v2-test@1',
        model: 'deterministic',
        effort: 'low' as const,
        serviceTier: null,
        strategy: input.requestedStrategy === 'ralplan' ? ('ralplan' as const) : ('fast' as const),
        sessionId: `temporal-v2-test:${input.commandId}`,
        promptHash: HASH,
        durationMs: 0,
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        hypotheticalApiCostUsd: 0,
      },
    }),
  reviseTaskWorkflowDraft: () => Promise.reject(new Error('Unexpected draft revision')),
  freezeTaskWorkflow: (input) =>
    Promise.resolve({
      ...input,
      schemaVersion: 1 as const,
      receiptId: `workflow-freeze:${input.workflowId}:${input.workflowRunId}`,
      frozenAt: '2026-08-09T00:00:00.000Z',
    }),
  runExecutionBlock: (input) =>
    Promise.resolve({
      status: 'completed' as const,
      summary: `${input.uses} completed`,
      predicateFacts: { 'attempt.succeeded@1': true },
      receiptReference: `block-receipt:${input.workflowId}:${input.nodeId}:${String(input.blockRun)}`,
    }),
  evaluateExecutionPredicate: (input) => Promise.resolve(input.facts[input.reference] ?? false),
} satisfies BootstrapWorkflowActivities & ExecutionWorkflowActivities;
