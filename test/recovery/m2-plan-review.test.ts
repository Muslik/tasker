import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createM1WorkflowService } from '../../src/control-plane/m1-service.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { DeterministicStubRunService } from '../../src/runner/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';

const directories: string[] = [];
const ledgers: SqliteLedger[] = [];

const setup = () => {
  const directory = mkdtempSync(join(tmpdir(), 'tasker-m2-plan-review-'));
  directories.push(directory);
  const filename = join(directory, 'ledger.sqlite');
  const clock = makeAdjustableClock('2026-08-02T15:00:00.000Z');
  const ledger = openSqliteLedger({ filename, clock });
  ledgers.push(ledger);
  const workflows = createM1WorkflowService(ledger.repository, clock);
  const generated = workflows.generate('avia-12536-feature-review');
  if (!generated.ok) throw new Error('Could not generate the feature workflow');
  const runner = new DeterministicStubRunService(ledger.repository, workflows, clock);
  const started = runner.start('avia-12536-feature-review');
  if (!started.ok || started.value.status !== 'waiting') {
    throw new Error('Expected the feature workflow to stop for plan review');
  }
  return { clock, filename, ledger, runner, started: started.value };
};

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('M2 plan review', () => {
  it('records operator guidance and requeues only the planning step', () => {
    const runtime = setup();
    const firstPlanReceipt = runtime.started.effects.find(
      (effect) => effect.nodeId === 'analyze-task',
    );

    const revised = runtime.runner.reviewPlan('avia-12536-feature-review', {
      decision: 'request_changes',
      guidance: 'Reproduce the risky itinerary transition before implementation.',
    });

    expect(revised).toMatchObject({
      ok: true,
      value: {
        status: 'queued',
        cursor: 0,
        effects: [firstPlanReceipt],
        nodeStates: { 'analyze-task': 'planned', 'review-plan': 'planned' },
        planRevisionRequests: [
          {
            priorAttempt: 1,
            nextAttempt: 2,
            targetNodeId: 'analyze-task',
            reviewNodeId: 'review-plan',
          },
        ],
      },
    });
    if (!revised.ok) return;
    const guidanceArtifact = runtime.ledger.repository.readArtifact(
      revised.value.planRevisionRequests[0]?.guidanceArtifactId ?? '',
    );
    expect(guidanceArtifact).toMatchObject({
      artifactKind: 'operator_guidance',
      payload: { guidance: 'Reproduce the risky itinerary transition before implementation.' },
    });
  });

  it('reopens review with a new planning attempt after a process restart', () => {
    const runtime = setup();
    const requested = runtime.runner.reviewPlan('avia-12536-feature-review', {
      decision: 'request_changes',
      guidance: 'Use the smallest frontend-only implementation first.',
    });
    if (!requested.ok) throw new Error('Expected plan changes to be accepted');
    ledgers.splice(ledgers.indexOf(runtime.ledger), 1);
    runtime.ledger.close();
    runtime.clock.advance(60_000);
    const reopenedLedger = openSqliteLedger({ filename: runtime.filename, clock: runtime.clock });
    ledgers.push(reopenedLedger);
    const reopenedWorkflows = createM1WorkflowService(reopenedLedger.repository, runtime.clock);
    const reopenedRunner = new DeterministicStubRunService(
      reopenedLedger.repository,
      reopenedWorkflows,
      runtime.clock,
    );

    const replanned = reopenedRunner.start('avia-12536-feature-review');

    expect(replanned).toMatchObject({
      ok: true,
      value: {
        status: 'waiting',
        wait: {
          waitId: 'wait:run:avia-12536-feature-review:review-plan:cycle-2',
          waitKind: 'plan.approved@1',
        },
      },
    });
    if (!replanned.ok) return;
    expect(
      replanned.value.effects
        .filter((effect) => effect.nodeId === 'analyze-task')
        .map((effect) => effect.effectKey),
    ).toEqual([
      'run:avia-12536-feature-review:analyze-task:attempt-1',
      'run:avia-12536-feature-review:analyze-task:attempt-2',
    ]);
  });
});
