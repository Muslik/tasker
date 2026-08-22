import { afterEach, describe, expect, it } from 'vitest';

import { LedgerExecutionActivityReader } from '../../src/control-plane/execution-activity.js';
import { BlockReceiptSchema, blockReceiptId } from '../../src/blocks/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { systemClock } from '../../src/shared/clock.js';
import { TemporalTaskStepTraceStore } from '../../src/temporal/activities/block-execution.js';
import { JsonValueSchema } from '../../src/workflow/schema.js';

describe('execution activity', () => {
  let ledger: SqliteLedger | null = null;

  afterEach(() => {
    ledger?.close();
    ledger = null;
  });

  it('surfaces one useful linked entry for a terminal Jenkins observation', () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    traces.persistOutputArtifact({
      operationId: 'tasker:jira:AVIA-12329:observe-ci:attempt-1',
      workflowId: 'tasker:jira:AVIA-12329',
      workflowRunId: 'run-1',
      nodeId: 'observe-ci',
      stepReference: 'deliver.pull-request@1',
      stepAttempt: 1,
      runner: 'integration',
      command: 'jenkins.build@1',
      args: [],
      cwd: '/tmp/worktree',
      exitCode: 0,
      status: 'completed',
      stdout: '',
      stderr: '',
      details: {
        output: {
          externalId: '73',
          status: 'passed',
          provider: 'jenkins',
          build: { url: 'https://jenkins.example/job/front-avia/73/' },
        },
      },
      result: {
        status: 'completed',
        summary: 'Jenkins build #73 passed for abcdef123456',
        artifactIds: [],
        transcriptId: null,
      },
    });
    traces.persistOutputArtifact({
      operationId: 'tasker:jira:AVIA-12329:implement:attempt-1',
      workflowId: 'tasker:jira:AVIA-12329',
      workflowRunId: 'run-1',
      nodeId: 'implement',
      stepReference: 'implement.change@1',
      stepAttempt: 1,
      runner: 'agent',
      command: 'codex',
      args: [],
      cwd: '/tmp/worktree',
      exitCode: 0,
      status: 'completed',
      stdout: '',
      stderr: '',
      details: {},
      result: {
        status: 'completed',
        summary: 'Implementation completed',
        artifactIds: [],
        transcriptId: null,
      },
    });
    expect(
      new LedgerExecutionActivityReader(ledger.repository).readActivity('tasker:jira:AVIA-12329'),
    ).toEqual([
      expect.objectContaining({
        source: 'tool',
        level: 'info',
        title: 'Jenkins build #73 passed for abcdef123456',
        externalUrl: 'https://jenkins.example/job/front-avia/73/',
      }),
    ]);
  });

  it('shows a blocked CI verdict without inventing a successful result', () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    traces.persistOutputArtifact({
      operationId: 'tasker:jira:AVIA-12045:observe-ci:attempt-1',
      workflowId: 'tasker:jira:AVIA-12045',
      workflowRunId: 'run-1',
      nodeId: 'observe-ci',
      stepReference: 'deliver.pull-request@1',
      stepAttempt: 1,
      runner: 'integration',
      command: 'jenkins.build@1',
      args: [],
      cwd: '/tmp/worktree',
      exitCode: null,
      status: 'blocked',
      stdout: '',
      stderr: '',
      details: {
        kind: 'verification',
        details: {
          status: 'likely_caused_by_change',
          build: { url: 'https://jenkins.example/job/front-avia/74/' },
        },
      },
      result: {
        status: 'blocked',
        summary: 'Jenkins build #74 requires attention: likely caused by change',
        waitKind: 'ci.observe.1.blocked@1',
        artifactIds: [],
        transcriptId: null,
      },
    });

    const entries = new LedgerExecutionActivityReader(ledger.repository).readActivity(
      'tasker:jira:AVIA-12045',
    );
    expect(entries).toEqual([
      expect.objectContaining({
        level: 'warning',
        title: 'Jenkins build #74 requires attention: likely caused by change',
        externalUrl: 'https://jenkins.example/job/front-avia/74/',
      }),
    ]);
    expect(entries[0]?.detail).toContain('completed work preserved');
  });

  it('reads the persisted transcript for the exact active Temporal block run', () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const operationId = 'tasker:jira:AVIA-12045:execution-run:implement-fix:attempt-2';
    traces.append(operationId, 1, 'stdout', '{"type":"turn.started"}\n');

    const transcript = new LedgerExecutionActivityReader(ledger.repository).readCurrentTranscript({
      runtime: 'execution',
      schemaVersion: 2,
      taskReference: 'jira:AVIA-12045',
      workflowId: 'tasker:jira:AVIA-12045',
      runId: 'execution-run',
      workflowHash: 'a'.repeat(64),
      nodeStates: { 'implement-fix': 'running' },
      blockRuns: { 'implement-fix': 2 },
      loopIterations: {},
      continuations: [],
      status: 'running',
      currentNodeId: 'implement-fix',
      wait: null,
      outcome: null,
    });

    expect(transcript).toMatchObject({ operationId, totalBytes: 24, truncated: false });
  });

  it('reads a completed attempt with full output and registered evidence after execution advances', () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const traces = new TemporalTaskStepTraceStore(ledger.repository, systemClock);
    const workflowId = 'tasker:jira:AVIA-12045';
    const runId = 'execution-run';
    const nodeId = 'implement-fix';
    const operationId = `${workflowId}:${runId}:${nodeId}:attempt-1`;
    const evidenceId = `task-step-evidence:${'a'.repeat(64)}`;
    ledger.repository.transact({
      artifacts: [
        {
          artifactId: evidenceId,
          artifactKind: 'task_step_evidence',
          storageUri: 'file:///tmp/tasker-artifacts/after.png',
          payload: {
            schemaVersion: 1,
            operationId,
            relativePath: 'after.png',
            contentSha256: 'b'.repeat(64),
            byteLength: 42,
            mimeType: 'image/png',
            recordedAt: '2026-08-22T00:00:00.000Z',
          },
          metadata: {},
        },
      ],
    });
    traces.append(operationId, 1, 'stdout', '{"type":"turn.started"}\n');
    traces.persistOutputArtifact({
      operationId,
      workflowId,
      workflowRunId: runId,
      nodeId,
      stepReference: 'implement.change@1',
      stepAttempt: 1,
      runner: 'agent',
      command: 'codex',
      args: [],
      cwd: '/tmp/worktree',
      exitCode: 0,
      status: 'completed',
      stdout: 'full provider output',
      stderr: '',
      details: { output: { summary: 'Implemented' } },
      result: {
        status: 'completed',
        summary: 'Implemented',
        artifactIds: [evidenceId],
        transcriptId: `task-step-transcript:${operationId}`,
      },
    });
    const receiptId = blockReceiptId({
      workflowId,
      workflowRunId: runId,
      nodeId,
      blockRun: 1,
    });
    ledger.repository.transact({
      artifacts: [
        {
          artifactId: receiptId,
          artifactKind: 'block_receipt',
          storageUri: `ledger://artifacts/${receiptId}`,
          payload: JsonValueSchema.parse(
            BlockReceiptSchema.parse({
              schemaVersion: 5,
              receiptId,
              blockReference: 'implement.change@1',
              blockDefinitionHash: 'definition-hash',
              taskReference: 'jira:AVIA-12045',
              workflowId,
              workflowRunId: runId,
              workflowHash: 'a'.repeat(64),
              nodeId,
              blockRun: 1,
              claim: {
                status: 'candidate_complete',
                summary: 'Implemented',
                output: { summary: 'Implemented' },
                evidenceReferences: ['workspace-change'],
              },
              verdict: { status: 'accepted', evidenceReferences: ['workspace-change'] },
              predicateFacts: {},
              evidence: [
                {
                  kind: 'workspace_mutation',
                  reference: 'workspace-change',
                  changed: true,
                  fingerprint: 'c'.repeat(64),
                  trackedDiffSha256: 'd'.repeat(64),
                  changedPaths: [{ status: ' M', path: 'src/TripInfo.scss' }],
                  changedPathsTruncated: false,
                },
              ],
              transcriptReference: `task-step-transcript:${operationId}`,
              usageReference: null,
              usage: null,
              completedAt: '2026-08-22T00:00:00.000Z',
            }),
          ),
          metadata: {},
        },
      ],
    });
    const execution = {
      runtime: 'execution' as const,
      schemaVersion: 2 as const,
      taskReference: 'jira:AVIA-12045',
      workflowId,
      runId,
      workflowHash: 'a'.repeat(64),
      nodeStates: { [nodeId]: 'succeeded' as const, review: 'running' as const },
      blockRuns: { [nodeId]: 1, review: 1 },
      loopIterations: {},
      continuations: [],
      status: 'running' as const,
      currentNodeId: 'review',
      wait: null,
      outcome: null,
    };

    const attempt = new LedgerExecutionActivityReader(ledger.repository).readAttempt(
      execution,
      nodeId,
      1,
    );

    expect(attempt).toMatchObject({
      nodeId,
      blockRun: 1,
      transcript: { operationId, totalBytes: 24 },
      output: { command: 'codex', stdout: 'full provider output', status: 'completed' },
      evidence: [
        {
          artifactId: evidenceId,
          relativePath: 'after.png',
          mimeType: 'image/png',
        },
      ],
      workspaceChanges: {
        changed: true,
        trackedDiffSha256: 'd'.repeat(64),
        paths: [{ status: ' M', path: 'src/TripInfo.scss' }],
        truncated: false,
      },
    });
  });
});
