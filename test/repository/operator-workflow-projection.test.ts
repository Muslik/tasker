import { afterEach, describe, expect, it } from 'vitest';

import { BlockReceiptSchema } from '../../src/blocks/contracts.js';
import { LedgerAgentInvocationReader } from '../../src/control-plane/agent-invocation-reader.js';
import { createOperatorWorkflowProjection } from '../../src/control-plane/operator-workflow-projection.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { LedgerAgentInvocationRecorder } from '../../src/observability/agent-invocation.js';
import { planWorkflowProposal } from '../../src/planning/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { ok } from '../../src/shared/outcome.js';
import { TaskRunLifecycleSchema } from '../../src/temporal/public-state.js';
import { CompiledWorkflowSchema } from '../../src/workflow/schema.js';
import { makeWorkflowProposal } from '../support/planning.js';

const resources: SqliteLedger[] = [];
const draftProvenance = {
  semanticHash: 'd'.repeat(64),
  compilerVersion: 'semantic-workflow-v1',
  harnessSnapshotHash: 'e'.repeat(64),
  retrospectiveEnabled: true,
} as const;

const waitingLifecycleFor = (
  reference: 'deliver.pull-request@1' | 'implement.change@1' | 'verify.acceptance@1',
  activityDelivery: 'read_only' | 'workspace_reconciled' | 'remote_reconciled',
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
        ...draftProvenance,
        workflowHash,
        graph,
        planningSnapshot: { artifactId: 'planning-snapshot', checksum: 'b'.repeat(64) },
        evidenceBundle: { artifactId: 'evidence-bundle', checksum: 'c'.repeat(64), revision: 1 },
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
      workflowHash,
      nodeStates: { 'active-step': 'waiting' },
      blockRuns: { 'active-step': 1 },
      loopIterations: {},
      continuations: [],
      retrospective: 'disabled',
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
  it('projects the active bootstrap planner transcript before the planner returns', () => {
    const operationId = 'bootstrap-workflow:bootstrap-run:planning:1';
    const lifecycle = TaskRunLifecycleSchema.parse({
      bootstrap: {
        runtime: 'bootstrap',
        schemaVersion: 3,
        taskReference: 'AVIA-1',
        workflowId: 'bootstrap-workflow',
        runId: 'bootstrap-run',
        workflowHash: null,
        settings: { planReview: 'required', planningStrategy: 'fast' },
        phase: 'planning',
        workspaceContext: null,
        context: null,
        draft: null,
        planning: null,
        activeTranscriptOperationId: operationId,
        freezeReceipt: null,
        executionWorkflowId: null,
        nodeStates: { workspace: 'succeeded', planning: 'running' },
        attempts: { planning: 1 },
        status: 'running',
        currentNodeId: 'planning',
        wait: null,
        outcome: null,
      },
      execution: null,
    });

    const projection = createOperatorWorkflowProjection(
      'AVIA-1',
      lifecycle,
      { read: () => ok(null) },
      () => null,
      () => null,
      (activeOperationId) => ({
        transcriptId: `planning-transcript:${activeOperationId}`,
        operationId: activeOperationId,
        chunks: [],
        totalBytes: 42,
        truncated: false,
      }),
    );

    expect(projection.current).toMatchObject({
      status: 'running',
      nodeId: 'planning',
      transcript: { operationId, totalBytes: 42 },
    });
  });

  it('uses a started planning invocation to expose the current attempt before completion', () => {
    const clock = makeAdjustableClock('2026-08-09T00:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    resources.push(ledger);
    const invocations = new LedgerAgentInvocationReader(ledger.repository);
    new LedgerAgentInvocationRecorder(ledger.repository, clock).start({
      invocationId: 'agent-invocation:planning-running',
      taskReference: 'AVIA-1',
      references: {
        kind: 'planning',
        planningEpisodeId: 'bootstrap-workflow:bootstrap-run:planning',
        planningAttempt: 1,
        invocationNumber: 1,
        operationId: 'bootstrap-workflow:bootstrap-run:planning:1',
        transcriptId: 'planning-transcript:bootstrap-workflow:bootstrap-run:planning:1',
        outputArtifactIds: [],
        receiptArtifactId: null,
      },
      startedAt: '2026-08-09T00:00:15.000Z',
    });
    const operationId = 'bootstrap-workflow:bootstrap-run:planning:1';
    const lifecycle = TaskRunLifecycleSchema.parse({
      bootstrap: {
        runtime: 'bootstrap',
        schemaVersion: 3,
        taskReference: 'AVIA-1',
        workflowId: 'bootstrap-workflow',
        runId: 'bootstrap-run',
        workflowHash: null,
        settings: { planReview: 'required', planningStrategy: 'fast' },
        phase: 'planning',
        workspaceContext: null,
        context: null,
        draft: null,
        planning: {
          status: 'blocked',
          planningEpisodeId: 'bootstrap-workflow:bootstrap-run:planning',
          commandId: operationId,
          attempt: 1,
          evidenceBundle: { artifactId: 'evidence', checksum: 'a'.repeat(64), revision: 1 },
          requestedStrategy: 'fast',
          selectedStrategy: 'fast',
          transcriptId: null,
          failure: {
            kind: 'provider_failed',
            message: 'still running in provider logs',
            retryable: true,
          },
          validationFeedback: [],
          validationRevision: 0,
        },
        activeTranscriptOperationId: operationId,
        freezeReceipt: null,
        executionWorkflowId: null,
        nodeStates: { workspace: 'succeeded', planning: 'running' },
        attempts: { planning: 1 },
        status: 'running',
        currentNodeId: 'planning',
        wait: null,
        outcome: null,
      },
      execution: null,
    });

    const projection = createOperatorWorkflowProjection(
      'AVIA-1',
      lifecycle,
      { read: () => ok(null) },
      () => null,
      () => null,
      () => null,
      undefined,
      {
        readLatestExecutionInvocation: (input) => invocations.readLatestExecutionInvocation(input),
        readLatestPlanningInvocation: (input) => invocations.readLatestPlanningInvocation(input),
      },
    );

    expect(projection.current).toMatchObject({ status: 'running' });
    expect(projection.currentAttempt).toEqual({
      latestInvocationId: 'agent-invocation:planning-running',
      nodeId: 'planning',
      blockRun: 1,
      startedAt: '2026-08-09T00:00:15.000Z',
      waitingSince: null,
    });
  });

  it('classifies an integration failure as an external prerequisite', () => {
    const projection = createOperatorWorkflowProjection(
      'AVIA-1',
      waitingLifecycleFor(
        'deliver.pull-request@1',
        'remote_reconciled',
        'deliver.pull-request@1.invalid_request@1',
      ),
      { read: () => ok(null) },
    );

    expect(projection.current).toMatchObject({
      status: 'waiting',
      intervention: { kind: 'external_prerequisite' },
    });
  });

  it('uses the latest finished execution invocation for waiting timing', () => {
    const clock = makeAdjustableClock('2026-08-09T00:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    resources.push(ledger);
    const recorder = new LedgerAgentInvocationRecorder(ledger.repository, clock);
    const invocations = new LedgerAgentInvocationReader(ledger.repository);
    recorder.start({
      invocationId: 'agent-invocation:deliver-1',
      taskReference: 'AVIA-1',
      references: {
        kind: 'execution',
        workflowId: 'execution-workflow',
        runId: 'execution-run',
        nodeId: 'active-step',
        blockRun: 1,
        providerAttempt: 1,
        transcriptId: 'execution-transcript:1',
        outputArtifactIds: [],
        receiptArtifactId: 'receipt:1',
      },
      startedAt: '2026-08-09T00:01:00.000Z',
    });
    recorder.finish({
      schemaVersion: 1,
      invocationId: 'agent-invocation:deliver-1',
      taskReference: 'AVIA-1',
      prompt: 'Deliver the task',
      promptBytes: 256,
      provider: 'codex',
      profile: 'delivery',
      profileSha256: 'd'.repeat(64),
      model: 'gpt-5.4',
      effort: 'high',
      serviceTier: 'fast',
      argv: ['codex'],
      skills: ['deliver-pr'],
      inputEvidenceArtifactIds: [],
      startedAt: '2026-08-09T00:01:00.000Z',
      finishedAt: '2026-08-09T00:01:20.000Z',
      durationMs: 20_000,
      status: 'waiting',
      exitStatus: { kind: 'timed_out' },
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 3,
        reasoningOutputTokens: 1,
      },
      cost: { source: 'unrated' },
      references: {
        kind: 'execution',
        workflowId: 'execution-workflow',
        runId: 'execution-run',
        nodeId: 'active-step',
        blockRun: 1,
        providerAttempt: 1,
        transcriptId: 'execution-transcript:1',
        outputArtifactIds: [],
        receiptArtifactId: 'receipt:1',
      },
    });

    const projection = createOperatorWorkflowProjection(
      'AVIA-1',
      waitingLifecycleFor(
        'deliver.pull-request@1',
        'remote_reconciled',
        'deliver.pull-request@1.invalid_request@1',
      ),
      { read: () => ok(null) },
      () => null,
      () => null,
      () => null,
      undefined,
      {
        readLatestExecutionInvocation: (input) => invocations.readLatestExecutionInvocation(input),
        readLatestPlanningInvocation: (input) => invocations.readLatestPlanningInvocation(input),
      },
    );

    expect(projection.current).toMatchObject({ status: 'waiting' });
    expect(projection.currentAttempt).toEqual({
      latestInvocationId: 'agent-invocation:deliver-1',
      nodeId: 'active-step',
      blockRun: 1,
      startedAt: '2026-08-09T00:01:00.000Z',
      waitingSince: '2026-08-09T00:01:20.000Z',
    });
  });

  it('classifies an agent failure as operator guidance', () => {
    const projection = createOperatorWorkflowProjection(
      'AVIA-1',
      waitingLifecycleFor(
        'implement.change@1',
        'workspace_reconciled',
        'implement.change@1.blocked@1',
      ),
      { read: () => ok(null) },
    );

    expect(projection.current).toMatchObject({
      status: 'waiting',
      intervention: { kind: 'operator_guidance' },
    });
  });

  it('classifies an exhausted agent contract retry without requesting guidance', () => {
    const projection = createOperatorWorkflowProjection(
      'AVIA-1',
      waitingLifecycleFor(
        'verify.acceptance@1',
        'read_only',
        'verify.acceptance@1.activity-failed@1',
      ),
      { read: () => ok(null) },
    );

    expect(projection.current).toMatchObject({
      status: 'waiting',
      intervention: { kind: 'retry_step' },
    });
  });

  it('projects an awaiting continuation as a reviewable suffix in the same workflow', () => {
    const base = waitingLifecycleFor(
      'deliver.pull-request@1',
      'remote_reconciled',
      'workflow_change.review@1',
    );
    if (base.execution === null) throw new Error('Execution fixture is missing');
    const continuationGraph = CompiledWorkflowSchema.parse({
      metadata: {
        compilerVersion: 4,
        irVersion: 'workflow-ir-v1',
        workflowId: 'execution-run:continuation-1',
        workflowVersion: 1,
        references: {
          predicates: ['verification.accepted@1'],
          stepTypes: ['implement.change@1', 'verify.acceptance@1'],
          waits: [],
        },
      },
      root: {
        kind: 'sequence',
        id: 'continuation-1--delivery',
        children: [
          {
            kind: 'step',
            id: 'continuation-1--implement',
            uses: 'implement.change@1',
            activityDelivery: { kind: 'workspace_reconciled' },
            with: { objective: 'Address CI finding', repository: 'front-avia', taskId: 'AVIA-1' },
          },
          { kind: 'finalize', id: 'continuation-1--finished', outcome: 'continued' },
        ],
      },
    });
    const lifecycle = TaskRunLifecycleSchema.parse({
      ...base,
      execution: {
        ...base.execution,
        continuations: [
          {
            continuationId: 'execution-run:continuation-1',
            attempt: 1,
            parentNodeId: 'active-step',
            requestReference: 'artifact:workflow-change',
            reason: 'CI exposed a task-caused change',
            evidenceBundle: {
              artifactId: 'evidence:continuation-1',
              checksum: 'f'.repeat(64),
              revision: 1,
            },
            transcriptOperationId: 'execution-run:continuation-1:planner',
            analyzerReceiptReference: 'receipt:continuation-1',
            usage: {
              provider: 'codex',
              profile: 'test',
              profileSha256: 'f'.repeat(64),
              model: 'test-model',
              effort: 'low',
              serviceTier: 'fast',
              sessionId: 'session-1',
              durationMs: 10,
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              reasoningOutputTokens: 0,
              apiCost: { source: 'unrated' },
            },
            semanticHash: 'd'.repeat(64),
            workflowHash: 'e'.repeat(64),
            graph: continuationGraph,
            status: 'awaiting_review',
          },
        ],
      },
    });

    const projection = createOperatorWorkflowProjection(
      'AVIA-1',
      lifecycle,
      { read: () => ok(null) },
      () => null,
      () => null,
      (operationId) => ({
        transcriptId: `planning-transcript:${operationId}`,
        operationId,
        chunks: [],
        totalBytes: 0,
        truncated: false,
      }),
    );

    expect(projection.current).toMatchObject({
      status: 'waiting',
      waitKind: 'workflow_change.review@1',
      intervention: { kind: 'typed_resolution' },
      transcript: {
        operationId: 'execution-run:continuation-1:planner',
      },
    });
    expect(projection.continuations).toEqual([
      expect.objectContaining({
        continuationId: 'execution-run:continuation-1',
        reason: 'CI exposed a task-caused change',
        status: 'awaiting_review',
      }),
    ]);
    const continuationStage = projection.stages.find(({ key }) =>
      key.startsWith('continuation:execution-run:continuation-1:'),
    );
    expect(continuationStage).toMatchObject({ label: 'Development' });
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
          ...draftProvenance,
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
        activeTranscriptOperationId: null,
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
        nodeStates: { 'implement-change': 'succeeded' },
        blockRuns: { 'implement-change': 1 },
        loopIterations: {},
        continuations: [],
        retrospective: 'disabled',
        status: 'running',
        currentNodeId: graph.root.id,
        wait: null,
        outcome: null,
      },
    });
    const receipt = BlockReceiptSchema.parse({
      schemaVersion: 7,
      receiptId: 'block-receipt:execution-workflow:execution-run:implement-change:run-1',
      blockReference: 'implement.change@1',
      blockDefinitionHash: 'block-definition-hash',
      taskReference: 'avia-13236-short-bug',
      workflowId: 'execution-workflow',
      workflowRunId: 'execution-run',
      workflowHash,
      nodeId: 'implement-change',
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
    const implementation = projection.stages.find(({ id }) => id === 'development');

    expect(projection.activeRuntime).toBe('execution');
    expect(implementation?.steps).toHaveLength(1);
    expect(implementation?.steps[0]).toMatchObject({
      kind: 'agent',
      reference: 'implement.change@1',
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
          stepTypes: ['implement.change@1', 'verify.acceptance@1'],
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
            uses: 'implement.change@1',
            activityDelivery: { kind: 'workspace_reconciled' },
            with: { objective: 'Fix', repository: 'front-avia', taskId: 'AVIA-1' },
          },
          {
            kind: 'step',
            id: 'validate-fix',
            uses: 'verify.acceptance@1',
            activityDelivery: { kind: 'read_only' },
            with: { objective: 'Verify', repository: 'front-avia', taskId: 'AVIA-1' },
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
          ...draftProvenance,
          workflowHash,
          graph,
          planningSnapshot: { artifactId: 'planning-snapshot', checksum: 'b'.repeat(64) },
          evidenceBundle: { artifactId: 'evidence-bundle', checksum: 'c'.repeat(64), revision: 1 },
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
        workflowHash,
        nodeStates: { 'implement-fix': 'running' },
        blockRuns: { 'implement-fix': 1 },
        loopIterations: {},
        continuations: [],
        retrospective: 'disabled',
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
      reference: 'implement.change@1',
      status: 'running',
      blockRun: 1,
      transcript: { operationId: 'implement-fix' },
    });
    expect(executionStages.map(({ label }) => label)).toEqual(['Development', 'Review']);
    expect(executionStages.map(({ steps }) => steps.length)).toEqual([1, 0]);
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
          predicates: ['verification.accepted@1'],
          stepTypes: ['implement.change@1', 'verify.acceptance@1'],
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
            uses: 'implement.change@1',
            activityDelivery: { kind: 'workspace_reconciled' },
            with: { objective: 'Fix the defect', repository: 'front-avia', taskId: 'AVIA-1' },
          },
          {
            kind: 'step',
            id: 'validate-fix',
            uses: 'verify.acceptance@1',
            activityDelivery: { kind: 'read_only' },
            with: { objective: 'Verify', repository: 'front-avia', taskId: 'AVIA-1' },
          },
          {
            kind: 'bounded_loop',
            id: 'repair-validation',
            maxAttempts: 3,
            until: 'verification.accepted@1',
            checkBefore: true,
            exhaustedWait: 'operator_guidance@1',
            body: {
              kind: 'sequence',
              id: 'repair-validation-body',
              children: [
                {
                  kind: 'step',
                  id: 'repair-code',
                  uses: 'implement.change@1',
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
                  uses: 'verify.acceptance@1',
                  activityDelivery: { kind: 'read_only' },
                  with: { objective: 'Verify', repository: 'front-avia', taskId: 'AVIA-1' },
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
          ...draftProvenance,
          workflowHash,
          graph,
          planningSnapshot: { artifactId: 'planning-snapshot', checksum: 'b'.repeat(64) },
          evidenceBundle: { artifactId: 'evidence-bundle', checksum: 'c'.repeat(64), revision: 1 },
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
        continuations: [],
        retrospective: 'disabled',
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

    expect(executionStages.map(({ label }) => label)).toEqual(['Development']);
    expect(executionStages[0]).toMatchObject({
      key: 'execution:development:1',
      status: 'running',
      steps: [
        {
          kind: 'agent',
          reference: 'implement.change@1',
          status: 'succeeded',
        },
        {
          kind: 'agent',
          reference: 'verify.acceptance@1',
          status: 'succeeded',
        },
        {
          kind: 'agent',
          reference: 'implement.change@1',
          status: 'running',
        },
      ],
    });
    expect(executionStages[0]?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'agent', reference: 'verify.acceptance@1' }),
      ]),
    );
    expect(JSON.stringify(executionStages)).not.toContain('repair-validation-body');
  });
});
