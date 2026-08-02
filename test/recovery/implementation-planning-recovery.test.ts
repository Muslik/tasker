import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createImplementationPlanningCoordinator,
  createM1WorkflowService,
  WorkflowGenerationSubjectSource,
} from '../../src/control-plane/index.js';
import { openSqliteLedger } from '../../src/ledger/index.js';
import {
  DeterministicImplementationPlanner,
  type ImplementationPlanner,
} from '../../src/providers/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { err } from '../../src/shared/outcome.js';

describe('implementation planning recovery', () => {
  it('restores a ready plan and artifact after restart without calling the provider again', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-plan-recovery-'));
    const databasePath = join(directory, 'ledger.sqlite');
    const clock = makeAdjustableClock('2026-08-02T12:00:00.000Z');
    const firstLedger = openSqliteLedger({ filename: databasePath, clock });
    const firstService = createM1WorkflowService(firstLedger.repository, clock);
    const subjects = new WorkflowGenerationSubjectSource(directory);
    const generated = firstService.generate('avia-13236-short-bug');
    if (!generated.ok) throw new Error('Expected workflow generation to succeed');
    const firstCoordinator = createImplementationPlanningCoordinator({
      ledger: firstLedger.repository,
      clock,
      workflows: firstService,
      subjects,
      planner: new DeterministicImplementationPlanner(),
    });

    const planned = await firstCoordinator.prepare('avia-13236-short-bug', 'fast');
    if (!planned.ok || planned.value.status !== 'ready') {
      throw new Error('Expected the first plan to be ready');
    }
    expect(firstLedger.repository.readArtifact(planned.value.artifactId)).not.toBeNull();
    firstLedger.close();

    let calls = 0;
    const providerThatMustNotRun: ImplementationPlanner = {
      plan: () => {
        calls += 1;
        return Promise.reject(new Error('Provider must not run while restoring a ready plan'));
      },
    };
    const restartedLedger = openSqliteLedger({ filename: databasePath, clock });
    try {
      const restartedService = createM1WorkflowService(restartedLedger.repository, clock);
      const restartedCoordinator = createImplementationPlanningCoordinator({
        ledger: restartedLedger.repository,
        clock,
        workflows: restartedService,
        subjects,
        planner: providerThatMustNotRun,
      });

      const restored = await restartedCoordinator.prepare('avia-13236-short-bug', 'fast');

      expect(restored).toEqual(planned);
      expect(calls).toBe(0);
    } finally {
      restartedLedger.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retries only failed planning while preserving the accepted workflow', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-plan-retry-'));
    const clock = makeAdjustableClock('2026-08-02T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
    try {
      const service = createM1WorkflowService(ledger.repository, clock);
      const subjects = new WorkflowGenerationSubjectSource(directory);
      const generated = service.generate('avia-13236-short-bug');
      if (!generated.ok) throw new Error('Expected workflow generation to succeed');
      const graphHash = generated.value.view.workflow.graphHash;
      let calls = 0;
      const fallback = new DeterministicImplementationPlanner();
      const failsOnce: ImplementationPlanner = {
        plan: (request) => {
          calls += 1;
          return calls === 1
            ? Promise.resolve(
                err({
                  kind: 'provider_failed' as const,
                  exitCode: 1,
                  message: 'VPN access is unavailable',
                  stderr: '403',
                }),
              )
            : fallback.plan(request);
        },
      };
      const coordinator = createImplementationPlanningCoordinator({
        ledger: ledger.repository,
        clock,
        workflows: service,
        subjects,
        planner: failsOnce,
      });

      const failed = await coordinator.prepare('avia-13236-short-bug', 'fast');
      const retried = await coordinator.prepare('avia-13236-short-bug', 'fast');
      const restoredWorkflow = service.read('avia-13236-short-bug');

      expect(failed).toMatchObject({
        ok: true,
        value: { status: 'failed', attempt: 1, failure: { kind: 'provider_failed' } },
      });
      expect(retried).toMatchObject({ ok: true, value: { status: 'ready', attempt: 2 } });
      expect(restoredWorkflow).toMatchObject({
        ok: true,
        value: { view: { workflow: { graphHash } } },
      });
      expect(calls).toBe(2);
    } finally {
      ledger.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
