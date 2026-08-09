import type { BootstrapWorkflowActivities } from '../../src/temporal/bootstrap-kernel/contracts.js';
import type { ExecutionWorkflowActivities } from '../../src/temporal/execution-kernel/contracts.js';

const HASH = '0'.repeat(64);

export const testTemporalActivities = {
  prepareTaskWorkspace: (input) => {
    const workspace = {
      schemaVersion: 1 as const,
      workspaceId: '0'.repeat(24),
      taskReference: input.taskReference,
      workflowId: input.workflowId,
      workflowRunId: input.workflowRunId,
      repository: {
        reference: 'fixture/repository',
        sourcePath: '/tasker/repositories/fixture',
        baseCommit: '0'.repeat(40),
      },
      runnerId: 'temporal-test',
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
        adapterId: 'temporal-test',
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
    });
  },
  assembleTaskPlanningContext: (input) =>
    Promise.resolve({
      contextHash: HASH,
      planningSnapshot: {
        artifactId: `planning-snapshot:${input.taskReference}:context`,
        checksum: HASH,
      },
      evidenceBundle: {
        artifactId: `evidence-bundle:${input.taskReference}:r1:test`,
        checksum: HASH,
        revision: 1,
      },
    }),
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
      draft: {
        workflowHash: 'a'.repeat(64),
        graph: {
          metadata: {
            compilerVersion: 4 as const,
            irVersion: 'm2' as const,
            workflowId: 'bootstrap-v3-fixture',
            workflowVersion: 1,
            references: {
              predicates: ['review.completed@1'],
              stepTypes: ['fixture.implement@1'],
              waits: ['code_review@1'],
            },
          },
          root: {
            kind: 'sequence' as const,
            id: 'delivery',
            children: [
              {
                kind: 'step' as const,
                id: 'implement',
                uses: 'fixture.implement@1',
                activityDelivery: { kind: 'workspace_reconciled' as const },
                with: {},
              },
              {
                kind: 'wait' as const,
                id: 'code-review',
                for: 'code_review@1',
                resolutionMapping: {
                  discriminator: 'decision',
                  cases: { approved: { 'review.completed@1': true } },
                },
              },
              { kind: 'finalize' as const, id: 'accepted', outcome: 'accepted' },
            ],
          },
        },
        planningSnapshot: {
          artifactId: `planning-snapshot:${input.taskReference}:execution`,
          checksum: HASH,
        },
        evidenceBundle: {
          artifactId: `evidence-bundle:${input.taskReference}:r1:test`,
          checksum: HASH,
          revision: 1,
        },
      },
      receipt: {
        status: 'completed' as const,
        provider: 'deterministic' as const,
        plannerVersion: 'implementation-planner@2',
        profile: 'deterministic',
        profileSha256: HASH,
        cliVersion: 'temporal-test@1',
        model: 'deterministic',
        effort: 'low' as const,
        serviceTier: null,
        strategy: input.requestedStrategy === 'ralplan' ? ('ralplan' as const) : ('fast' as const),
        sessionId: `temporal-test:${input.commandId}`,
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
  runBootstrapInvestigation: (input) =>
    Promise.resolve({
      status: 'completed' as const,
      summary: `${input.step.uses} completed`,
      evidenceBundle: {
        artifactId: `evidence-bundle:${input.taskReference}:r2:investigation`,
        checksum: HASH,
        revision: 2,
      },
    }),
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
