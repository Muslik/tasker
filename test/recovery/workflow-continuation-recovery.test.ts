import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createImplementationPlanningCoordinator,
  createM1WorkflowService,
  createWorkflowContinuationCoordinator,
  DeterministicStubRunService,
  WorkflowGenerationSubjectSource,
} from '../../src/control-plane/index.js';
import { openSqliteLedger } from '../../src/ledger/index.js';
import { ImplementationPlanningDecisionSchema } from '../../src/planning/implementation-plan.js';
import {
  DeterministicImplementationPlanner,
  type ImplementationPlanner,
} from '../../src/providers/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { ok } from '../../src/shared/outcome.js';
import { makeRepositoryCatalog } from '../helpers/repositories.js';

describe('workflow continuation recovery', () => {
  it('restores the parent wait and revised immutable candidate after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-continuation-recovery-'));
    const filename = join(directory, 'ledger.sqlite');
    const clock = makeAdjustableClock('2026-08-02T12:00:00.000Z');
    const firstLedger = openSqliteLedger({ filename, clock });
    const firstWorkflows = createM1WorkflowService(firstLedger.repository, clock);
    const subjects = new WorkflowGenerationSubjectSource(directory);
    const generated = firstWorkflows.generate('avia-13236-short-bug');
    if (!generated.ok || generated.value.status !== 'ready') {
      throw new Error('Expected a ready parent workflow');
    }
    const parentGraphHash = generated.value.view.workflow.graphHash;
    const fallback = new DeterministicImplementationPlanner();
    const planner: ImplementationPlanner = {
      plan: async (request) => {
        const result = await fallback.plan(request);
        return result.ok
          ? ok({
              ...result.value,
              decision: ImplementationPlanningDecisionSchema.parse({
                status: 'workflow_change_required',
                request: {
                  reason: 'The affected implementation lives in the shared component.',
                  discoveredRepositories: ['twiket/ui-kit'],
                  requiredCapabilities: ['repository.read'],
                  evidence: ['The dependency resolves to @ott/ui-kit.'],
                },
              }),
            })
          : result;
      },
    };
    const planning = createImplementationPlanningCoordinator({
      ledger: firstLedger.repository,
      clock,
      workflows: firstWorkflows,
      subjects,
      planner,
    });
    const planned = await planning.prepare('avia-13236-short-bug', 'fast');
    if (!planned.ok || planned.value.status !== 'workflow_change_required') {
      throw new Error('Expected a workflow continuation request');
    }
    const firstRunner = new DeterministicStubRunService(
      firstLedger.repository,
      firstWorkflows,
      clock,
    );
    const waiting = firstRunner.openWorkflowContinuation(
      'avia-13236-short-bug',
      { planApproval: 'automatic', planningStrategy: 'fast' },
      { attempt: planned.value.attempt, artifactId: planned.value.artifactId },
    );
    if (!waiting.ok) throw new Error('Expected a durable continuation wait');
    const firstContinuation = createWorkflowContinuationCoordinator({
      ledger: firstLedger.repository,
      clock,
      workflows: firstWorkflows,
      subjects,
      repositories: makeRepositoryCatalog(),
    });
    const proposed = await firstContinuation.proposeFromPlanning(
      'avia-13236-short-bug',
      waiting.value.runId,
      planned.value,
    );
    if (!proposed.ok || proposed.value.status !== 'awaiting_review') {
      throw new Error('Expected a reviewable continuation');
    }
    const firstCandidate = proposed.value.candidate;
    const rejected = firstContinuation.review('avia-13236-short-bug', {
      decision: 'reject',
      continuationId: proposed.value.continuationId,
      guidance: 'Keep the new repository but add a narrower verification step.',
    });
    if (!rejected.ok || rejected.value.status !== 'rejected_by_operator') {
      throw new Error('Expected durable rejection guidance');
    }
    const replanned = await planning.prepare(
      'avia-13236-short-bug',
      'fast',
      rejected.value.guidance,
    );
    if (!replanned.ok || replanned.value.status !== 'workflow_change_required') {
      throw new Error('Expected a revised workflow continuation request');
    }
    const updatedWait = firstRunner.openWorkflowContinuation(
      'avia-13236-short-bug',
      waiting.value.settings,
      { attempt: replanned.value.attempt, artifactId: replanned.value.artifactId },
    );
    if (!updatedWait.ok) throw new Error('Expected the same durable continuation wait');
    const reproposed = await firstContinuation.proposeFromPlanning(
      'avia-13236-short-bug',
      waiting.value.runId,
      replanned.value,
    );
    if (!reproposed.ok || reproposed.value.status !== 'awaiting_review') {
      throw new Error('Expected a revised reviewable continuation');
    }
    const candidate = reproposed.value.candidate;
    firstLedger.close();

    const restartedLedger = openSqliteLedger({ filename, clock });
    try {
      const restartedWorkflows = createM1WorkflowService(restartedLedger.repository, clock);
      const restartedRunner = new DeterministicStubRunService(
        restartedLedger.repository,
        restartedWorkflows,
        clock,
      );
      const restartedContinuation = createWorkflowContinuationCoordinator({
        ledger: restartedLedger.repository,
        clock,
        workflows: restartedWorkflows,
        subjects,
        repositories: makeRepositoryCatalog(),
      });

      const restoredContinuation = restartedContinuation.read('avia-13236-short-bug');
      const restoredRun = restartedRunner.read('avia-13236-short-bug');
      const restoredCandidate = restartedWorkflows.read(candidate.taskReference);
      const restoredParent = restartedWorkflows.read('avia-13236-short-bug');

      expect(restoredContinuation).toEqual(reproposed);
      expect(restoredRun).toMatchObject({
        ok: true,
        value: {
          runId: 'run:avia-13236-short-bug',
          status: 'waiting',
          wait: { waitKind: 'workflow_continuation_review', slotPolicy: 'release' },
          lease: null,
          effects: [],
        },
      });
      expect(restoredCandidate).toMatchObject({
        ok: true,
        value: {
          status: 'ready',
          view: { workflow: { graphHash: candidate.graphHash } },
        },
      });
      expect(restartedWorkflows.read(firstCandidate.taskReference)).toMatchObject({
        ok: true,
        value: {
          status: 'ready',
          view: { workflow: { graphHash: firstCandidate.graphHash } },
        },
      });
      expect(restoredParent).toMatchObject({
        ok: true,
        value: { view: { workflow: { graphHash: parentGraphHash } } },
      });
    } finally {
      restartedLedger.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
