import { afterEach, describe, expect, it } from 'vitest';

import { LedgerExecutionActivityReader } from '../../src/control-plane/execution-activity.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { systemClock } from '../../src/shared/clock.js';
import { TemporalTaskStepTraceStore } from '../../src/temporal/activities/block-execution.js';

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
      stepReference: 'ci.observe@1',
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
      stepReference: 'code.implement@1',
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
      stepReference: 'ci.observe@1',
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
      status: 'running',
      currentNodeId: 'implement-fix',
      wait: null,
      outcome: null,
    });

    expect(transcript).toMatchObject({ operationId, totalBytes: 24, truncated: false });
  });
});
