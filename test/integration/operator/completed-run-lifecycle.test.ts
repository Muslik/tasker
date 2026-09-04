import { describe, expect, it } from 'vitest';

import { CompletedRunLifecycleReader } from '../../../src/server/completed-run-lifecycle.js';
import { ImplementationPlanningStore } from '../../../src/server/planning-episodes.js';
import { createOperatorWorkflowProjection } from '../../../src/server/operator-workflow-projection.js';
import { openSqliteLedger } from '../../../src/store/index.js';
import { RetrospectiveReportSchema } from '../../../src/server/index.js';
import { makeAdjustableClock } from '../../../src/shared/clock.js';
import { ok } from '../../../src/shared/outcome.js';
import { WorkflowFreezeReceiptSchema } from '../../../src/kernel/index.js';
import { CompiledWorkflowSchema, JsonValueSchema } from '../../../src/graph/index.js';

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

describe('completed run lifecycle', () => {
  it('reconstructs a read-only completed projection from durable ledger indexes', () => {
    const hash = 'a'.repeat(64);
    const report = RetrospectiveReportSchema.parse({
      schemaVersion: 2,
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
        effort: {
          waitResolutions: { count: 0, kinds: {} },
          guidance: { count: 0, totalChars: 0 },
          planReviews: { rounds: 0, annotations: 0 },
          documentReviews: { rounds: 0, annotations: 0 },
          restarts: 0,
        },
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
      settings: {
        planReview: 'required',
        planningStrategy: 'ralplan',
        trackerStatusUpdates: 'enabled',
        branchName: 'tasker/TEST-1/recovery',
        operatorBrief: 'Preserve the evidence trail.',
      },
      frozenAt: '2026-08-25T00:00:00.000Z',
    });
    const reader = new CompletedRunLifecycleReader(
      { readLatestRun: () => ok({ report, blockRuns: { 'implement-change': 2 } }) },
      { readLatest: () => ok(freeze) },
      {
        readArchivedExecutionGraph: () => ok(graph),
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
          settings: { operatorBrief: 'Preserve the evidence trail.' },
        },
      },
    });
    if (!lifecycle.ok || lifecycle.value === null) throw new Error('Expected completed lifecycle');
    const projection = createOperatorWorkflowProjection('jira:TEST-1', lifecycle.value, {
      read: () => ok(null),
    });
    expect(projection.stages.at(-1)).toMatchObject({
      id: 'retrospective',
      status: 'succeeded',
    });
  });

  it('reads an archived graph without validating removed harness fields', () => {
    const clock = makeAdjustableClock('2026-08-25T00:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    const artifactId = 'planning-snapshot:jira:TEST-1:archive';
    const persisted = ledger.repository.transact({
      artifacts: [
        {
          artifactId,
          artifactKind: 'planning_run_snapshot',
          storageUri: `ledger://artifacts/${artifactId}`,
          payload: JsonValueSchema.parse({
            schemaVersion: 9,
            kind: 'execution',
            workflow: { graph },
            harness: { company: { globalPackageRules: [] } },
          }),
          metadata: {},
          createdAt: clock.now(),
        },
      ],
      timestamp: clock.now(),
    });
    expect(persisted.ok).toBe(true);
    const artifact = ledger.repository.readArtifact(artifactId);
    if (artifact === null) throw new Error('Expected archived planning snapshot');
    const planning = new ImplementationPlanningStore(ledger.repository, clock);

    const result = planning.readArchivedExecutionGraph({
      artifactId,
      checksum: artifact.checksum,
    });

    expect(result).toEqual({ ok: true, value: graph });
    ledger.close();
  });
});
