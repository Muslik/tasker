import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PlanReviewStore,
  planReviewResolution,
  type PlanReviewCommand,
} from '../../../src/server/plan-review.js';
import { openSqliteLedger, type SqliteLedger } from '../../../src/store/index.js';
import { makeAdjustableClock } from '../../../src/shared/clock.js';

const resources: SqliteLedger[] = [];
const directories: string[] = [];
const PLANNING_EPISODE_ID = 'tasker:v3:jira:AVIA-12045:run-1:planning';

afterEach(() => {
  for (const ledger of resources.splice(0)) ledger.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

const changeRequest = {
  expectedRunId: 'run-1',
  decision: 'request_changes',
  reviewId: 'review-1',
  planArtifactId: 'implementation-plan:task:attempt-1',
  planAttempt: 1,
  guidance: 'Keep the change bounded.',
  annotations: [
    {
      quote: 'Run the full suite',
      note: 'Use the targeted payment checks instead.',
    },
  ],
} as const satisfies PlanReviewCommand;

describe('native plan review', () => {
  it('turns structured annotations into deterministic planner guidance', () => {
    expect(planReviewResolution(changeRequest)).toEqual({
      decision: 'request_changes',
      guidance:
        'Keep the change bounded.\n\n«Фрагмент: "Run the full suite" — Use the targeted payment checks instead.»',
    });
  });

  it('accepts annotation-only change requests', () => {
    expect(
      planReviewResolution({
        expectedRunId: 'run-1',
        decision: 'request_changes',
        reviewId: 'review-1',
        planArtifactId: 'implementation-plan:task:attempt-1',
        planAttempt: 1,
        annotations: [
          {
            quote: 'Run the full suite',
            note: 'Use the targeted payment checks instead.',
          },
        ],
      }),
    ).toEqual({
      decision: 'request_changes',
      guidance: '«Фрагмент: "Run the full suite" — Use the targeted payment checks instead.»',
    });
  });

  it('keeps applied review rounds append-only and idempotent', () => {
    const clock = makeAdjustableClock('2026-08-12T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    resources.push(ledger);
    const store = new PlanReviewStore(ledger.repository, clock);

    expect(store.submit(PLANNING_EPISODE_ID, 'jira:AVIA-12045', changeRequest)).toMatchObject({
      ok: true,
    });
    expect(store.submit(PLANNING_EPISODE_ID, 'jira:AVIA-12045', changeRequest)).toMatchObject({
      ok: true,
    });
    clock.advance(1_000);
    expect(store.markApplied(PLANNING_EPISODE_ID, changeRequest.reviewId)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(store.markApplied(PLANNING_EPISODE_ID, changeRequest.reviewId)).toEqual({
      ok: true,
      value: undefined,
    });

    const history = store.read(PLANNING_EPISODE_ID);
    expect(history).toMatchObject({
      ok: true,
      value: [
        {
          reviewId: 'review-1',
          planArtifactId: 'implementation-plan:task:attempt-1',
          decision: 'request_changes',
          status: 'applied',
          annotations: [{ quote: 'Run the full suite' }],
        },
      ],
    });
    expect(
      ledger.repository.readDocument('plan_review', `${PLANNING_EPISODE_ID}:review-1`, 1)?.payload,
    ).toMatchObject({
      reviewId: 'review-1',
      status: 'submitted',
      appliedAt: null,
    });
    expect(
      ledger.repository.readDocument('plan_review', `${PLANNING_EPISODE_ID}:review-1`)?.payload,
    ).toMatchObject({
      reviewId: 'review-1',
      status: 'applied',
    });
  });

  it('restores review rounds after the ledger is reopened', () => {
    const clock = makeAdjustableClock('2026-08-12T12:00:00.000Z');
    const directory = mkdtempSync(join(tmpdir(), 'tasker-plan-review-'));
    directories.push(directory);
    const filename = join(directory, 'ledger.sqlite');
    const firstLedger = openSqliteLedger({ filename, clock });
    const firstStore = new PlanReviewStore(firstLedger.repository, clock);

    expect(firstStore.submit(PLANNING_EPISODE_ID, 'jira:AVIA-12045', changeRequest)).toMatchObject({
      ok: true,
    });
    expect(firstStore.markApplied(PLANNING_EPISODE_ID, changeRequest.reviewId)).toMatchObject({
      ok: true,
    });
    firstLedger.close();

    const restartedLedger = openSqliteLedger({ filename, clock });
    resources.push(restartedLedger);
    const history = new PlanReviewStore(restartedLedger.repository, clock).read(
      PLANNING_EPISODE_ID,
    );

    expect(history).toMatchObject({
      ok: true,
      value: [
        {
          reviewId: 'review-1',
          status: 'applied',
          annotations: [{ quote: 'Run the full suite' }],
        },
      ],
    });
  });

  it('rejects reusing a review id for different feedback', () => {
    const clock = makeAdjustableClock('2026-08-12T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    resources.push(ledger);
    const store = new PlanReviewStore(ledger.repository, clock);

    expect(store.submit(PLANNING_EPISODE_ID, 'jira:AVIA-12045', changeRequest)).toMatchObject({
      ok: true,
    });
    expect(
      store.submit(PLANNING_EPISODE_ID, 'jira:AVIA-12045', {
        ...changeRequest,
        guidance: 'A different decision under the same id.',
      }),
    ).toEqual({
      ok: false,
      error: { kind: 'review_conflict', reviewId: 'review-1' },
    });
  });

  it('does not expose review state from another run of the same task', () => {
    const clock = makeAdjustableClock('2026-08-12T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    resources.push(ledger);
    const store = new PlanReviewStore(ledger.repository, clock);
    const nextEpisode = 'tasker:v3:jira:AVIA-12045:run-2:planning';

    expect(store.submit(PLANNING_EPISODE_ID, 'jira:AVIA-12045', changeRequest)).toMatchObject({
      ok: true,
    });

    expect(store.read(nextEpisode)).toEqual({ ok: true, value: [] });
  });
});
