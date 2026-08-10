import { afterEach, describe, expect, it } from 'vitest';

import { BlockReceiptSchema } from '../../src/blocks/contracts.js';
import { createM1WorkflowService } from '../../src/control-plane/m1-service.js';
import { createOperatorWorkflowProjection } from '../../src/control-plane/operator-workflow-projection.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { ok } from '../../src/shared/outcome.js';
import { TaskRunLifecycleSchema } from '../../src/temporal/public-state.js';
import { CompiledWorkflowSchema } from '../../src/workflow/schema.js';

const resources: SqliteLedger[] = [];

afterEach(() => {
  for (const ledger of resources.splice(0)) ledger.close();
});

describe('operator workflow projection', () => {
  it('joins execution attempts with immutable receipt evidence', () => {
    const clock = makeAdjustableClock('2026-08-10T00:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    resources.push(ledger);
    const generated = createM1WorkflowService(ledger.repository, clock).generate(
      'avia-13236-short-bug',
    );
    if (!generated.ok || generated.value.view.workflow.graphHash === null) {
      throw new Error('Expected a compiled workflow fixture');
    }

    const graph = CompiledWorkflowSchema.parse(generated.value.view.workflow.graph);
    const workflowHash = generated.value.view.workflow.graphHash;
    const lifecycle = TaskRunLifecycleSchema.parse({
      bootstrap: {
        runtime: 'bootstrap',
        schemaVersion: 3,
        taskReference: 'avia-13236-short-bug',
        workflowId: 'bootstrap-workflow',
        runId: 'bootstrap-run',
        workflowHash,
        settings: {
          planReview: 'automatic',
          planningStrategy: 'fast',
          executionStart: 'automatic',
        },
        phase: 'execution',
        workspaceContext: null,
        context: null,
        draft: {
          workflowHash,
          graph,
          planningSnapshot: { artifactId: 'planning-snapshot', checksum: 'a'.repeat(64) },
          evidenceBundle: {
            artifactId: 'evidence-bundle',
            checksum: 'b'.repeat(64),
            revision: 1,
          },
        },
        planning: null,
        freezeReceipt: null,
        executionWorkflowId: 'execution-workflow',
        nodeStates: {
          workspace: 'succeeded',
          context: 'succeeded',
          investigation: 'skipped',
          planning: 'succeeded',
          plan_review: 'skipped',
          freeze: 'succeeded',
          execution_start: 'succeeded',
        },
        attempts: { workspace: 1, context: 1, planning: 1, freeze: 1 },
        status: 'completed',
        currentNodeId: null,
        wait: null,
        outcome: 'execution_started',
      },
      execution: {
        runtime: 'execution',
        schemaVersion: 2,
        taskReference: 'avia-13236-short-bug',
        workflowId: 'execution-workflow',
        runId: 'execution-run',
        workflowHash,
        nodeStates: {
          'initialize-ai-assistance': 'succeeded',
          'record-accepted-plan': 'running',
        },
        blockRuns: { 'initialize-ai-assistance': 1 },
        loopIterations: {},
        status: 'running',
        currentNodeId: 'record-accepted-plan',
        wait: null,
        outcome: null,
      },
    });
    const receipt = BlockReceiptSchema.parse({
      schemaVersion: 2,
      receiptId: 'block-receipt:execution-workflow:execution-run:initialize-ai-assistance:run-1',
      blockReference: 'ai.assistance.initialize@1',
      blockDefinitionHash: 'block-definition-hash',
      taskReference: 'avia-13236-short-bug',
      workflowId: 'execution-workflow',
      workflowRunId: 'execution-run',
      workflowHash,
      nodeId: 'initialize-ai-assistance',
      blockRun: 1,
      claim: {
        status: 'candidate_complete',
        summary: 'AI assistance initialized',
        output: null,
        evidenceReferences: ['effect:ai-assistance'],
      },
      verdict: { status: 'accepted', evidenceReferences: ['effect:ai-assistance'] },
      evidence: [
        {
          kind: 'effect',
          reference: 'effect:ai-assistance',
          reconciled: true,
          remoteIdentity: 'branch-artifacts',
        },
      ],
      transcriptReference: 'transcript:initialize',
      usageReference: 'usage:initialize',
      completedAt: '2026-08-10T00:01:00.000Z',
    });

    const projection = createOperatorWorkflowProjection('avia-13236-short-bug', lifecycle, {
      read: (receiptId) => ok(receiptId === receipt.receiptId ? receipt : null),
    });
    const preparation = projection.stages.find(({ key }) => key === 'execution:preparation:1');

    expect(projection.activeRuntime).toBe('execution');
    expect(preparation?.status).toBe('running');
    expect(preparation?.nodes[0]?.details).toMatchObject({
      kind: 'block',
      attempts: 1,
      receipts: [
        {
          verdict: 'accepted',
          summary: 'AI assistance initialized',
          evidence: [{ kind: 'effect', reconciled: true, remoteIdentity: 'branch-artifacts' }],
        },
      ],
    });
  });
});
