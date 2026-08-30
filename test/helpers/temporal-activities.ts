import { createHash } from 'node:crypto';

import type { BootstrapWorkflowActivities } from '../../src/kernel/bootstrap-kernel/contracts.js';
import type { ExecutionWorkflowActivities } from '../../src/kernel/execution-kernel/contracts.js';

const HASH = '0'.repeat(64);

export const testTemporalActivities = {
  prepareTaskWorkspace: (input) => {
    const workspaceId = createHash('sha256').update(input.workflowRunId).digest('hex').slice(0, 24);
    const workspace = {
      workspaceId,
      repositoryReference: 'fixture/repository',
      revision: '0'.repeat(40),
      path: `/tasker/worktrees/${workspaceId}`,
    };
    return Promise.resolve({
      workspace,
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
      planningEpisodeId: input.planningEpisodeId,
      commandId: input.commandId,
      transcriptId: `planning-transcript:${input.commandId}`,
      attempt: 1,
      artifactId: `test-plan:${input.taskReference}`,
      workflowOperationId: `${input.commandId}:workflow-candidate:1`,
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
        semanticHash: 'b'.repeat(64),
        compilerVersion: 'semantic-workflow-v1',
        harnessSnapshotHash: 'c'.repeat(64),
        retrospectiveEnabled: true,
        graph: {
          metadata: {
            compilerVersion: 4 as const,
            irVersion: 'workflow-ir-v1' as const,
            workflowId: 'bootstrap-v3-fixture',
            workflowVersion: 1,
            references: {
              predicates: ['review.completed@1'],
              stepTypes: ['fixture.code-review@1', 'fixture.implement@1'],
              waits: [],
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
                kind: 'step' as const,
                id: 'code-review',
                uses: 'fixture.code-review@1',
                activityDelivery: { kind: 'read_only' as const },
                with: {},
              },
              { kind: 'finalize' as const, id: 'accepted', outcome: 'accepted' },
            ],
          },
        } as never,
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
  admitTaskExecution: () =>
    Promise.resolve({
      status: 'completed' as const,
      summary: 'Task admitted for execution',
    }),
  freezeTaskWorkflow: (input) =>
    Promise.resolve({
      ...input,
      schemaVersion: 1 as const,
      receiptId: `workflow-freeze:${input.workflowId}:${input.workflowRunId}`,
      frozenAt: '2026-08-09T00:00:00.000Z',
    }),
  runExecutionBlock: (input) =>
    input.nodeId === 'code-review' && input.waitResolution === null
      ? Promise.resolve({
          status: 'needs_input' as const,
          summary: 'Code review is required by this fixture',
          waitKind: 'code_review@1',
        })
      : Promise.resolve({
          status: 'completed' as const,
          summary: `${input.uses} completed`,
          predicateFacts: input.nodeId === 'code-review' ? { 'review.completed@1': true } : {},
          receiptReference: `block-receipt:${input.workflowId}:${input.nodeId}:${String(input.blockRun)}`,
        }),
  planExecutionContinuation: () =>
    Promise.resolve({
      status: 'needs_input' as const,
      summary: 'No continuation is configured for this test fixture',
      waitKind: 'workflow_change.test-fixture@1',
    }),
  runExecutionRetrospective: (input) =>
    Promise.resolve({
      status: 'ready',
      artifactId: `retrospective:${input.workflowId}:${input.workflowRunId}`,
    }),
} satisfies BootstrapWorkflowActivities & ExecutionWorkflowActivities;
