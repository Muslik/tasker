import { describe, expect, it } from 'vitest';

import { CompletedRunLifecycleReader } from '../../src/control-plane/completed-run-lifecycle.js';
import { RetrospectiveReportSchema } from '../../src/retrospective/index.js';
import { ok } from '../../src/shared/outcome.js';
import { WorkflowFreezeReceiptSchema } from '../../src/temporal/index.js';
import { CompiledWorkflowSchema } from '../../src/workflow/index.js';
import type { RunPlanningSnapshot } from '../../src/planning/index.js';

describe('completed run lifecycle', () => {
  it('reconstructs a read-only completed projection from durable ledger indexes', () => {
    const hash = 'a'.repeat(64);
    const graph = CompiledWorkflowSchema.parse({
      metadata: {
        compilerVersion: 4,
        irVersion: 'workflow-ir-v1',
        workflowId: 'delivery',
        workflowVersion: 1,
        references: {
          predicates: [],
          stepTypes: ['implement.change@1'],
          waits: [],
        },
      },
      root: {
        kind: 'sequence',
        id: 'root',
        children: [
          {
            kind: 'step',
            id: 'implement-change',
            uses: 'implement.change@1',
            activityDelivery: { kind: 'workspace_reconciled' },
            with: {},
          },
          { kind: 'finalize', id: 'finished', outcome: 'accepted' },
        ],
      },
    });
    const report = RetrospectiveReportSchema.parse({
      schemaVersion: 1,
      taskReference: 'jira:TEST-1',
      workflowId: 'tasker:execution:v2:jira:TEST-1:bootstrap-run',
      workflowRunId: 'execution-run',
      outcome: 'accepted',
      metrics: {
        attempts: 1,
        blockedAttempts: 0,
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        durationMs: 1,
        estimatedCostUsd: 0,
        byStep: [],
      },
      findings: [],
      proposals: [],
      generatedAt: '2026-08-25T00:00:00.000Z',
    });
    const freeze = WorkflowFreezeReceiptSchema.parse({
      schemaVersion: 1,
      receiptId: 'workflow-freeze:tasker:v3:jira:TEST-1:bootstrap-run',
      taskReference: 'jira:TEST-1',
      workflowId: 'tasker:v3:jira:TEST-1',
      workflowRunId: 'bootstrap-run',
      workflowHash: hash,
      semanticHash: hash,
      compilerVersion: 'test',
      harnessSnapshotHash: hash,
      planningAttempt: 1,
      planningArtifactId: 'plan',
      planningSnapshot: { artifactId: 'snapshot', checksum: hash },
      evidenceBundle: { artifactId: 'evidence', checksum: hash, revision: 1 },
      approval: { kind: 'operator_approved' },
      frozenAt: '2026-08-25T00:00:00.000Z',
    });
    const reader = new CompletedRunLifecycleReader(
      { readLatestRun: () => ok({ report, blockRuns: { 'implement-change': 2 } }) },
      { readLatest: () => ok(freeze) },
      {
        readRunSnapshot: () =>
          ok({ kind: 'execution', workflow: { graph } } as unknown as RunPlanningSnapshot),
      },
    );

    const lifecycle = reader.read('jira:TEST-1');

    expect(lifecycle).toMatchObject({
      ok: true,
      value: {
        bootstrap: { status: 'completed', runId: 'bootstrap-run' },
        execution: {
          status: 'completed',
          runId: 'execution-run',
          blockRuns: { 'implement-change': 2 },
          nodeStates: { 'implement-change': 'succeeded', finished: 'succeeded' },
        },
      },
    });
  });
});
