import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PlanReviewStore,
  planReviewResolution,
  type PlanReviewCommand,
} from '../../src/control-plane/plan-review.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';

const resources: SqliteLedger[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const ledger of resources.splice(0)) ledger.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

const changeRequest = {
  decision: 'request_changes',
  reviewId: 'review-1',
  planArtifactId: 'implementation-plan:task:attempt-1',
  planAttempt: 1,
  guidance: 'Keep the change bounded.',
  annotations: [
    {
      id: 'annotation-1',
      anchor: 'implementation-plan:task:attempt-1',
      quote: 'Run the full suite',
      startOffset: 120,
      endOffset: 138,
      comment: 'Use the targeted payment checks instead.',
    },
  ],
} as const satisfies PlanReviewCommand;

describe('native plan review', () => {
  it('turns structured annotations into deterministic planner guidance', () => {
    expect(planReviewResolution(changeRequest)).toEqual({
      decision: 'request_changes',
      guidance:
        'Keep the change bounded.\n\nAnnotation 1 (implementation-plan:task:attempt-1)\n> Run the full suite\n\nUse the targeted payment checks instead.',
    });
  });

  it('rejects feedback that would be truncated at the planner boundary', () => {
    expect(() =>
      planReviewResolution({
        ...changeRequest,
        guidance: 'g'.repeat(9_900),
        annotations: [
          {
            ...changeRequest.annotations[0],
            comment: 'c'.repeat(500),
          },
        ],
      }),
    ).toThrow();
  });

  it('keeps applied review rounds append-only and idempotent', () => {
    const clock = makeAdjustableClock('2026-08-12T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    resources.push(ledger);
    const store = new PlanReviewStore(ledger.repository, clock);

    expect(store.submit('jira:AVIA-12045', changeRequest)).toMatchObject({ ok: true });
    expect(store.submit('jira:AVIA-12045', changeRequest)).toMatchObject({ ok: true });
    clock.advance(1_000);
    expect(store.markApplied('jira:AVIA-12045', changeRequest.reviewId)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(store.markApplied('jira:AVIA-12045', changeRequest.reviewId)).toEqual({
      ok: true,
      value: undefined,
    });

    const history = store.read('jira:AVIA-12045');
    expect(history).toMatchObject({
      ok: true,
      value: [
        {
          reviewId: 'review-1',
          planArtifactId: 'implementation-plan:task:attempt-1',
          decision: 'request_changes',
          status: 'applied',
          annotations: [{ id: 'annotation-1' }],
        },
      ],
    });
    expect(ledger.repository.listEvents('plan-review:jira:AVIA-12045')).toHaveLength(2);
  });

  it('restores review rounds after the ledger is reopened', () => {
    const clock = makeAdjustableClock('2026-08-12T12:00:00.000Z');
    const directory = mkdtempSync(join(tmpdir(), 'tasker-plan-review-'));
    directories.push(directory);
    const filename = join(directory, 'ledger.sqlite');
    const firstLedger = openSqliteLedger({ filename, clock });
    const firstStore = new PlanReviewStore(firstLedger.repository, clock);

    expect(firstStore.submit('jira:AVIA-12045', changeRequest)).toMatchObject({ ok: true });
    expect(firstStore.markApplied('jira:AVIA-12045', changeRequest.reviewId)).toMatchObject({
      ok: true,
    });
    firstLedger.close();

    const restartedLedger = openSqliteLedger({ filename, clock });
    resources.push(restartedLedger);
    const history = new PlanReviewStore(restartedLedger.repository, clock).read('jira:AVIA-12045');

    expect(history).toMatchObject({
      ok: true,
      value: [{ reviewId: 'review-1', status: 'applied', annotations: [{ id: 'annotation-1' }] }],
    });
  });

  it('rejects reusing a review id for different feedback', () => {
    const clock = makeAdjustableClock('2026-08-12T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    resources.push(ledger);
    const store = new PlanReviewStore(ledger.repository, clock);

    expect(store.submit('jira:AVIA-12045', changeRequest)).toMatchObject({ ok: true });
    expect(
      store.submit('jira:AVIA-12045', {
        ...changeRequest,
        guidance: 'A different decision under the same id.',
      }),
    ).toEqual({
      ok: false,
      error: { kind: 'review_conflict', reviewId: 'review-1' },
    });
  });
});
