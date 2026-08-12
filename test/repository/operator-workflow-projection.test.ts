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
      schemaVersion: 3,
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
      predicateFacts: {},
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

  it('keeps repair loops visible inside their surrounding operator phase', () => {
    const clock = makeAdjustableClock('2026-08-10T00:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    resources.push(ledger);
    const graph = CompiledWorkflowSchema.parse({
      metadata: {
        compilerVersion: 4,
        irVersion: 'm2',
        workflowId: 'workflow-with-repair-loop',
        workflowVersion: 1,
        references: {
          predicates: ['validation.passed@1'],
          stepTypes: ['code.implement@1', 'code.repair@1', 'validate.targeted@1'],
          waits: ['operator_guidance@1'],
        },
      },
      root: {
        kind: 'sequence',
        id: 'delivery',
        children: [
          {
            kind: 'step',
            id: 'implement-fix',
            uses: 'code.implement@1',
            activityDelivery: { kind: 'workspace_reconciled' },
            with: { objective: 'Fix the defect', repository: 'front-avia', taskId: 'AVIA-1' },
          },
          {
            kind: 'step',
            id: 'validate-fix',
            uses: 'validate.targeted@1',
            activityDelivery: { kind: 'single_attempt' },
            with: { profile: 'targeted', taskId: 'AVIA-1' },
          },
          {
            kind: 'bounded_loop',
            id: 'repair-validation',
            maxAttempts: 3,
            until: 'validation.passed@1',
            checkBefore: true,
            exhaustedWait: 'operator_guidance@1',
            body: {
              kind: 'sequence',
              id: 'repair-validation-body',
              children: [
                {
                  kind: 'step',
                  id: 'repair-code',
                  uses: 'code.repair@1',
                  activityDelivery: { kind: 'workspace_reconciled' },
                  with: {
                    objective: 'Repair validation failure',
                    repository: 'front-avia',
                    taskId: 'AVIA-1',
                  },
                },
                {
                  kind: 'step',
                  id: 'revalidate-fix',
                  uses: 'validate.targeted@1',
                  activityDelivery: { kind: 'single_attempt' },
                  with: { profile: 'targeted', taskId: 'AVIA-1' },
                },
              ],
            },
          },
          {
            kind: 'step',
            id: 'confirm-validation',
            uses: 'validate.targeted@1',
            activityDelivery: { kind: 'single_attempt' },
            with: { profile: 'targeted', taskId: 'AVIA-1' },
          },
        ],
      },
    });
    const workflowHash = 'a'.repeat(64);
    const lifecycle = TaskRunLifecycleSchema.parse({
      bootstrap: {
        runtime: 'bootstrap',
        schemaVersion: 3,
        taskReference: 'AVIA-1',
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
          planningSnapshot: { artifactId: 'planning-snapshot', checksum: 'b'.repeat(64) },
          evidenceBundle: { artifactId: 'evidence-bundle', checksum: 'c'.repeat(64), revision: 1 },
        },
        planning: null,
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
        workflowHash,
        nodeStates: {},
        blockRuns: {},
        loopIterations: { 'repair-validation': 1 },
        status: 'running',
        currentNodeId: 'repair-code',
        wait: null,
        outcome: null,
      },
    });

    const projection = createOperatorWorkflowProjection('AVIA-1', lifecycle, {
      read: () => ok(null),
    });
    const executionStages = projection.stages.filter(({ key }) => key.startsWith('execution:'));

    expect(executionStages.map(({ label }) => label)).toEqual(['Implement', 'Validate']);
    expect(executionStages[1]).toMatchObject({
      key: 'execution:verification:2',
      presentation: { kind: 'phase' },
      nodes: [
        { id: 'validate-fix' },
        {
          id: 'repair-validation',
          details: {
            kind: 'loop',
            completedIterations: 1,
            maxAttempts: 3,
            until: 'validation.passed@1',
          },
        },
        { id: 'confirm-validation' },
      ],
    });
  });
});
