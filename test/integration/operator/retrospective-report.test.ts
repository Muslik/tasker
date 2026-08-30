import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteLedger, type SqliteLedger } from '../../../src/store/index.js';
import { RetrospectiveStore } from '../../../src/server/report.js';
import { makeAdjustableClock } from '../../../src/shared/clock.js';

describe('execution retrospective', () => {
  let ledger: SqliteLedger;

  afterEach(() => {
    ledger.close();
  });

  it('summarizes repeated costly attempts and persists one idempotent report', () => {
    const clock = makeAdjustableClock('2026-08-30T00:00:00.000Z');
    ledger = openSqliteLedger({ filename: ':memory:', clock });
    const taskReference = 'jira:AVIA-1';
    const workflowId = 'tasker:execution:v2:jira:AVIA-1:bootstrap-run';
    const workflowRunId = 'execution-run';
    const record = (attempt: number, status: 'blocked' | 'completed', inputTokens: number) =>
      ledger.repository.insertArtifact({
        artifactId: `task-step-output:${workflowId}:${workflowRunId}:verify:${String(attempt)}`,
        artifactKind: 'task_step_output',
        taskReference,
        storageUri: `ledger://artifacts/task-step-output:${workflowId}:${workflowRunId}:verify:${String(attempt)}`,
        payload: {
          schemaVersion: 4,
          operationId: `${workflowId}:${workflowRunId}:verify:attempt-${String(attempt)}`,
          workflowId,
          workflowRunId,
          nodeId: 'verify',
          stepReference: 'verify.acceptance@1',
          stepAttempt: attempt,
          runner: 'agent',
          command: 'codex',
          args: [],
          cwd: '/tmp/worktree',
          exitCode: status === 'completed' ? 0 : null,
          status,
          stdout: '',
          stderr: '',
          details: {},
          usage: {
            provider: 'codex',
            profile: 'verification',
            profileSha256: 'a'.repeat(64),
            model: 'gpt-5.6-terra',
            effort: 'medium',
            serviceTier: 'fast',
            sessionId: `session-${String(attempt)}`,
            durationMs: 1_000,
            inputTokens,
            cachedInputTokens: Math.floor(inputTokens / 2),
            outputTokens: 100,
            reasoningOutputTokens: 10,
            apiCost: {
              source: 'price_table',
              amountUsd: inputTokens / 1_000_000,
              pricingVersion: 'test',
            },
          },
          result:
            status === 'blocked'
              ? {
                  status,
                  summary: status,
                  artifactIds: [],
                  transcriptId: null,
                  waitKind: 'verify.blocked@1',
                  category: 'infrastructure',
                  retryable: true,
                }
              : { status, summary: status, artifactIds: [], transcriptId: null },
          recordedAt: '2026-08-30T00:00:00.000Z',
        },
      });
    expect(record(1, 'blocked', 100_000)).toBe(true);
    expect(record(2, 'completed', 200_000)).toBe(true);
    const retrospectives = new RetrospectiveStore(ledger.repository, clock);

    const first = retrospectives.generate({
      taskReference,
      workflowId,
      workflowRunId,
      outcome: 'accepted',
    });
    const repeated = retrospectives.generate({
      taskReference,
      workflowId,
      workflowRunId,
      outcome: 'accepted',
    });

    expect(first).toMatchObject({
      ok: true,
      value: {
        metrics: { attempts: 2, blockedAttempts: 1, inputTokens: 300_000 },
        findings: [
          { kind: 'cost', title: 'verify.acceptance@1 dominated measured token usage' },
          { kind: 'recovery' },
        ],
        proposals: [
          { id: 'compact-repeated-step-context', status: 'proposed' },
          { id: 'harden-recovery-prerequisites', status: 'proposed' },
        ],
      },
    });
    expect(repeated).toEqual(first);
    expect(retrospectives.readLatest(taskReference)).toEqual(first);
    expect(retrospectives.readLatestRun(taskReference)).toMatchObject({
      ok: true,
      value: { blockRuns: { verify: 2 } },
    });
  });
});
