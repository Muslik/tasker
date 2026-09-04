import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteLedger, type SqliteLedger } from '../store/index.js';
import { makeAdjustableClock } from '../shared/clock.js';
import { PlanReviewStore } from './plan-review.js';
import { RetrospectiveStore } from './report.js';

describe('retrospective report', () => {
  let ledger: SqliteLedger | undefined;

  afterEach(() => ledger?.close());

  it('counts operator effort from indexed stream events and review documents', () => {
    const clock = makeAdjustableClock('2026-08-31T00:00:00.000Z');
    ledger = openSqliteLedger({ filename: ':memory:', clock });
    ledger.repository.appendStreamEvent({
      taskReference: 'jira:FC-1',
      eventType: 'OperatorWaitResolved',
      payload: { waitKind: 'operator_guidance@1', resolution: { guidance: 'Fix path' } },
    });
    ledger.repository.appendStreamEvent({
      taskReference: 'jira:FC-1',
      eventType: 'OperatorDocumentReviewSubmitted',
      payload: {
        resolution: {
          decision: 'request_changes',
          guidance: 'Tighten it',
          annotations: [{ quote: 'x', note: 'y' }],
        },
      },
    });
    ledger.repository.appendStreamEvent({
      taskReference: 'jira:FC-1',
      eventType: 'OperatorRestarted',
      payload: {},
    });
    const reviews = new PlanReviewStore(ledger.repository, clock);
    reviews.submit('episode', 'jira:FC-1', {
      expectedRunId: 'bootstrap-run',
      reviewId: 'review-1',
      planArtifactId: 'plan-1',
      planAttempt: 1,
      decision: 'request_changes',
      guidance: 'Clarify the boundary',
      annotations: [
        {
          quote: 'scope',
          note: 'too broad',
        },
      ],
    });
    const report = new RetrospectiveStore(ledger.repository, clock).generate({
      taskReference: 'jira:FC-1',
      workflowId: 'workflow',
      workflowRunId: 'run',
      outcome: 'completed',
    });
    expect(report).toMatchObject({
      ok: true,
      value: {
        schemaVersion: 2,
        metrics: {
          effort: {
            waitResolutions: { count: 1, kinds: { 'operator_guidance@1': 1 } },
            guidance: {
              count: 3,
              totalChars: 'Fix path'.length + 'Tighten it'.length + 'Clarify the boundary'.length,
            },
            planReviews: { rounds: 1, annotations: 1 },
            documentReviews: { rounds: 1, annotations: 1 },
            restarts: 1,
          },
        },
      },
    });
  });

  it('keeps analyzer failures out of the deterministic report and supports manual proposal status', () => {
    const clock = makeAdjustableClock('2026-08-31T00:00:00.000Z');
    ledger = openSqliteLedger({ filename: ':memory:', clock });
    const store = new RetrospectiveStore(ledger.repository, clock);
    const report = store.generate(
      {
        taskReference: 'jira:FC-2',
        workflowId: 'workflow',
        workflowRunId: 'run',
        outcome: 'completed',
      },
      {
        findings: [],
        proposals: [
          {
            id: 'p1',
            target: 'automation_script',
            title: 'Check paths',
            rationale: 'Paths repeat',
            generalityRationale: 'Useful in most future tasks',
            harnessFile: 'workspace/bin/check-paths',
            status: 'proposed',
          },
        ],
      },
    );
    expect(report.ok).toBe(true);
    const updated = store.setProposalStatus('workflow', 'run', 'p1', 'approved');
    expect(updated).toMatchObject({
      ok: true,
      value: { proposals: [{ id: 'p1', status: 'approved' }] },
    });
    expect(store.patterns()).toMatchObject({
      ok: true,
      value: { proposals: [{ target: 'automation_script', count: 1 }] },
    });
  });

  it('caps the analyzer digest without including transcript content', () => {
    const clock = makeAdjustableClock('2026-08-31T00:00:00.000Z');
    ledger = openSqliteLedger({ filename: ':memory:', clock });
    for (let index = 0; index < 20; index += 1) {
      ledger.repository.appendStreamEvent({
        taskReference: 'jira:FC-3',
        eventType: 'OperatorWaitResolved',
        payload: {
          waitKind: 'operator_guidance@1',
          resolution: { guidance: 'g'.repeat(10_000) },
        },
      });
    }
    const digest = new RetrospectiveStore(ledger.repository, clock).buildAnalyzerDigest(
      { taskReference: 'jira:FC-3', workflowId: 'workflow', workflowRunId: 'run' },
      [{ reference: 'implement.change@1', promptFile: 'steps/implement-change/prompt.md' }],
    );
    expect(Buffer.byteLength(digest, 'utf8')).toBeLessThanOrEqual(60_000);
    expect(digest).not.toContain('"stdout":');
  });
});
