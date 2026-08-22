import { createHash } from 'node:crypto';

import type { BootstrapWorkflowActivities } from '../../src/temporal/bootstrap-kernel/contracts.js';
import type { ExecutionWorkflowActivities } from '../../src/temporal/execution-kernel/contracts.js';

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
        graph: {
          metadata: {
            compilerVersion: 4 as const,
            irVersion: 'workflow-ir-v1' as const,
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
    Promise.resolve({
      status: 'completed' as const,
      summary: `${input.uses} completed`,
      predicateFacts: {},
      receiptReference: `block-receipt:${input.workflowId}:${input.nodeId}:${String(input.blockRun)}`,
    }),
  evaluateExecutionPredicate: (input) => Promise.resolve(input.facts[input.reference] ?? false),
} satisfies BootstrapWorkflowActivities & ExecutionWorkflowActivities;
