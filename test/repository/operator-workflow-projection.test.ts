import { afterEach, describe, expect, it } from 'vitest';

import { BlockReceiptSchema } from '../../src/blocks/contracts.js';
import { createOperatorWorkflowProjection } from '../../src/control-plane/operator-workflow-projection.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { planWorkflowProposal } from '../../src/planning/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { ok } from '../../src/shared/outcome.js';
import { TaskRunLifecycleSchema } from '../../src/temporal/public-state.js';
import { CompiledWorkflowSchema } from '../../src/workflow/schema.js';
import { makeWorkflowProposal } from '../support/planning.js';

const resources: SqliteLedger[] = [];

const waitingLifecycleFor = (
  reference: 'code.implement@1' | 'jira.start-work@1',
  activityDelivery: 'workspace_reconciled' | 'remote_reconciled',
  waitKind: string,
) => {
  const graph = CompiledWorkflowSchema.parse({
    metadata: {
      compilerVersion: 4,
      irVersion: 'workflow-ir-v1',
      workflowId: 'waiting-workflow',
      workflowVersion: 1,
      references: { predicates: [], stepTypes: [reference], waits: [] },
    },
    root: {
      kind: 'step',
      id: 'active-step',
      uses: reference,
      activityDelivery: { kind: activityDelivery },
      with: {
        objective: 'Continue the task',
        repository: 'onetwotrip/front-avia',
        taskId: 'AVIA-1',
      },
    },
  });
  const workflowHash = 'a'.repeat(64);
  return TaskRunLifecycleSchema.parse({
    bootstrap: {
      runtime: 'bootstrap',
      schemaVersion: 3,
      taskReference: 'AVIA-1',
      workflowId: 'bootstrap-workflow',
      runId: 'bootstrap-run',
      workflowHash,
      settings: { planReview: 'automatic', planningStrategy: 'fast' },
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
      nodeStates: { 'active-step': 'waiting' },
      blockRuns: { 'active-step': 1 },
      loopIterations: {},
      status: 'waiting',
      currentNodeId: 'active-step',
      wait: { nodeId: 'active-step', waitKind, reason: 'Action is required' },
      outcome: null,
    },
  });
};

afterEach(() => {
  for (const ledger of resources.splice(0)) ledger.close();
});

describe('operator workflow projection', () => {
  it('classifies an integration failure as an external prerequisite', () => {
    const projection = createOperatorWorkflowProjection(
      'AVIA-1',
      waitingLifecycleFor(
        'jira.start-work@1',
        'remote_reconciled',
        'jira.start-work@1.invalid_request@1',
      ),
      { read: () => ok(null) },
    );

    expect(projection.current).toMatchObject({
      status: 'waiting',
      intervention: { kind: 'external_prerequisite' },
    });
  });

  it('classifies an agent failure as operator guidance', () => {
    const projection = createOperatorWorkflowProjection(
      'AVIA-1',
      waitingLifecycleFor('code.implement@1', 'workspace_reconciled', 'code.implement@1.blocked@1'),
      { read: () => ok(null) },
    );

    expect(projection.current).toMatchObject({
      status: 'waiting',
      intervention: { kind: 'operator_guidance' },
    });
  });

  it('shows one operator step for one executed agent block and hides internal mechanics', () => {
    const clock = makeAdjustableClock('2026-08-10T00:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    resources.push(ledger);
    const generated = planWorkflowProposal(makeWorkflowProposal());
    if (!generated.ok)
      throw new Error(`Expected compiled workflow: ${JSON.stringify(generated.error)}`);
    const graph = generated.value.compiled.graph;
    const workflowHash = generated.value.compiled.hash;
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
        nodeStates: { 'implement-fix': 'succeeded' },
        blockRuns: { 'implement-fix': 1 },
        loopIterations: {},
        status: 'running',
        currentNodeId: graph.root.id,
        wait: null,
        outcome: null,
      },
    });
    const receipt = BlockReceiptSchema.parse({
      schemaVersion: 4,
      receiptId: 'block-receipt:execution-workflow:execution-run:implement-fix:run-1',
      blockReference: 'code.implement@1',
      blockDefinitionHash: 'block-definition-hash',
      taskReference: 'avia-13236-short-bug',
      workflowId: 'execution-workflow',
      workflowRunId: 'execution-run',
      workflowHash,
      nodeId: 'implement-fix',
      blockRun: 1,
      claim: {
        status: 'candidate_complete',
        summary: 'Change implemented',
        output: null,
        evidenceReferences: ['workspace:diff'],
      },
      verdict: { status: 'accepted', evidenceReferences: ['workspace:diff'] },
      predicateFacts: {},
      evidence: [
        {
          kind: 'workspace_mutation',
          reference: 'workspace:diff',
          changed: true,
          fingerprint: 'diff-fingerprint',
        },
      ],
      transcriptReference: 'transcript:implement',
      usageReference: 'usage:implement',
      usage: {
        provider: 'codex',
        profile: 'implementation',
        profileSha256: 'e'.repeat(64),
        model: 'gpt-5.6-sol',
        effort: 'high',
        serviceTier: 'fast',
        sessionId: 'session-1',
        durationMs: 60_000,
        inputTokens: 1_000,
        cachedInputTokens: 500,
        outputTokens: 200,
        reasoningOutputTokens: 50,
        apiCost: { source: 'provider_reported', amountUsd: 0.2 },
      },
      completedAt: '2026-08-10T00:01:00.000Z',
    });

    const projection = createOperatorWorkflowProjection('avia-13236-short-bug', lifecycle, {
      read: (receiptId) => ok(receiptId === receipt.receiptId ? receipt : null),
    });
    const implementation = projection.stages.find(({ id }) => id === 'implementation');

    expect(projection.activeRuntime).toBe('execution');
    expect(implementation?.steps).toHaveLength(1);
    expect(implementation?.steps[0]).toMatchObject({
      kind: 'agent',
      reference: 'code.implement@1',
      attempts: 1,
      receipts: [
        {
          verdict: 'accepted',
          summary: 'Change implemented',
          evidence: [{ kind: 'workspace_mutation', changed: true }],
        },
      ],
    });
    expect(JSON.stringify(projection)).not.toContain('initialize-ai-assistance');
    expect(JSON.stringify(projection)).not.toContain('bounded_loop');
  });

  it('keeps future phases compact until their configurable work starts', () => {
    const graph = CompiledWorkflowSchema.parse({
      metadata: {
        compilerVersion: 4,
        irVersion: 'workflow-ir-v1',
        workflowId: 'future-steps',
        workflowVersion: 1,
        references: {
          predicates: [],
          stepTypes: ['code.implement@1', 'validate.targeted@1'],
          waits: ['code_review@1'],
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
            with: { objective: 'Fix', repository: 'front-avia', taskId: 'AVIA-1' },
          },
          {
            kind: 'step',
            id: 'validate-fix',
            uses: 'validate.targeted@1',
            activityDelivery: { kind: 'single_attempt' },
            with: { profile: 'targeted', taskId: 'AVIA-1' },
          },
          { kind: 'wait', id: 'review', for: 'code_review@1' },
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
        nodeStates: { 'implement-fix': 'running' },
        blockRuns: { 'implement-fix': 1 },
        loopIterations: {},
        status: 'running',
        currentNodeId: 'implement-fix',
        wait: null,
        outcome: null,
      },
    });

    const projection = createOperatorWorkflowProjection(
      'AVIA-1',
      lifecycle,
      { read: () => ok(null) },
      () => null,
      () => ({
        transcriptId: 'task-step-transcript:implement-fix',
        operationId: 'implement-fix',
        chunks: [],
        totalBytes: 0,
        truncated: false,
      }),
    );
    const executionStages = projection.stages.filter(({ key }) => key.startsWith('execution:'));

    expect(projection.current).toMatchObject({
      runtime: 'execution',
      nodeId: 'implement-fix',
      reference: 'code.implement@1',
      status: 'running',
      blockRun: 1,
      transcript: { operationId: 'implement-fix' },
    });
    expect(executionStages.map(({ label }) => label)).toEqual(['Implement', 'Validate', 'Review']);
    expect(executionStages.map(({ steps }) => steps.length)).toEqual([1, 0, 0]);
  });

  it('keeps repair loops visible inside their surrounding operator phase', () => {
    const clock = makeAdjustableClock('2026-08-10T00:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    resources.push(ledger);
    const graph = CompiledWorkflowSchema.parse({
      metadata: {
        compilerVersion: 4,
        irVersion: 'workflow-ir-v1',
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
        nodeStates: {
          'implement-fix': 'succeeded',
          'validate-fix': 'succeeded',
          'repair-validation': 'running',
          'repair-validation-body': 'running',
          'repair-code': 'running',
        },
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
    expect(executionStages[0]).toMatchObject({
      key: 'execution:implementation:1',
      status: 'running',
      steps: [
        {
          kind: 'agent',
          reference: 'code.implement@1',
          status: 'succeeded',
        },
        {
          kind: 'agent',
          reference: 'code.repair@1',
          status: 'running',
        },
      ],
    });
    expect(executionStages[1]).toMatchObject({
      key: 'execution:verification:2',
      status: 'succeeded',
      steps: [
        {
          kind: 'process',
          reference: 'validate.targeted@1',
          status: 'succeeded',
        },
      ],
    });
    expect(JSON.stringify(executionStages)).not.toContain('repair-validation-body');
  });
});
