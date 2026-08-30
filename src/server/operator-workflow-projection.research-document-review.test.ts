import { describe, expect, it, vi } from 'vitest';

vi.mock('../harness/index.js', () => ({
  processExecutionPlanFor: () => null,
}));

vi.mock('../planning/index.js', () => ({
  getHarnessStepDefinition: () => ({
    block: {
      stage: { id: 'research', label: 'Research' },
      executor: { kind: 'agent', profile: 'research', skills: [] },
    },
  }),
}));

import { CompiledWorkflowSchema } from '../graph/schema.js';
import { ok } from '../shared/outcome.js';
import { TaskRunLifecycleSchema } from '../steps/public-state.js';
import { createOperatorWorkflowProjection } from './operator-workflow-projection.js';

describe('operator workflow projection research wait', () => {
  it('classifies research document review as a typed resolution wait', () => {
    const graph = CompiledWorkflowSchema.parse({
      metadata: {
        compilerVersion: 4,
        irVersion: 'workflow-ir-v1',
        workflowId: 'waiting-workflow',
        workflowVersion: 1,
        references: { predicates: [], stepTypes: ['research.draft@1'], waits: [] },
      },
      root: {
        kind: 'step',
        id: 'document-review',
        uses: 'research.draft@1',
        activityDelivery: { kind: 'remote_reconciled' },
        with: {
          objective: 'Draft the research report',
          repository: 'front-avia',
          taskId: 'AVIA-1',
        },
      },
    });
    const lifecycle = TaskRunLifecycleSchema.parse({
      bootstrap: {
        runtime: 'bootstrap',
        schemaVersion: 3,
        taskReference: 'AVIA-1',
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
          retrospectiveEnabled: false,
          workflowHash: 'a'.repeat(64),
          graph,
          planningSnapshot: { artifactId: 'planning-snapshot', checksum: 'd'.repeat(64) },
          evidenceBundle: {
            artifactId: 'evidence-bundle',
            checksum: 'e'.repeat(64),
            revision: 1,
          },
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
        taskReference: 'AVIA-1',
        workflowId: 'execution-workflow',
        runId: 'execution-run',
        workflowHash: 'a'.repeat(64),
        nodeStates: { 'document-review': 'waiting' },
        blockRuns: { 'document-review': 1 },
        loopIterations: {},
        continuations: [],
        retrospective: 'disabled',
        status: 'waiting',
        currentNodeId: 'document-review',
        wait: {
          nodeId: 'document-review',
          waitKind: 'research.document-review@1',
          reason: 'Review the draft document',
        },
        outcome: null,
      },
    });

    const projection = createOperatorWorkflowProjection('AVIA-1', lifecycle, {
      read: () => ok(null),
    });

    expect(projection.current).toMatchObject({
      status: 'waiting',
      waitKind: 'research.document-review@1',
      intervention: { kind: 'typed_resolution', waitKind: 'research.document-review@1' },
    });
  });
});
