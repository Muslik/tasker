import { describe, expect, it } from 'vitest';

import {
  createImplementationPlanningCoordinator,
  createOperatorWorkflowService,
  EvidenceBundleStore,
} from '../../src/server/index.js';
import { loadHarnessPack } from '../../src/harness/index.js';
import { openSqliteLedger } from '../../src/store/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { recordTestEvidenceBundle } from '../helpers/evidence.js';
import {
  makeTestGenerationSubjectSource,
  makeTestImplementationPlanner,
} from '../support/planning.js';

const TASK_REFERENCE = 'avia-13236-short-bug';
const PLANNING_EPISODE_ID = 'tasker:test:validation-missing';

describe('implementation planning assembly', () => {
  it('fails once with the missing project validation profiles', async () => {
    const clock = makeAdjustableClock('2026-08-30T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const pack = loadHarnessPack();
      const project = pack.projects.find(
        ({ repository }) => repository === 'onetwotrip/front-avia',
      );
      if (project === undefined) {
        throw new Error('Expected the front-avia validation fixture');
      }
      const harnessPack = {
        ...pack,
        projects: pack.projects.map((candidate) =>
          candidate.repository === project.repository
            ? {
                ...candidate,
                processCommands: {},
              }
            : candidate,
        ),
      };
      const workflows = createOperatorWorkflowService(ledger.repository, clock);
      const evidenceBundles = new EvidenceBundleStore(ledger.repository, clock);
      recordTestEvidenceBundle(ledger.repository, clock, TASK_REFERENCE);
      const evidence = evidenceBundles.readLatest(`test:${TASK_REFERENCE}`);
      if (!evidence.ok || evidence.value === null) throw new Error('Missing planning evidence');
      const fallback = makeTestImplementationPlanner();
      let plannerCalls = 0;
      const coordinator = createImplementationPlanningCoordinator({
        ledger: ledger.repository,
        clock,
        workflows,
        subjects: makeTestGenerationSubjectSource(process.cwd()),
        evidenceBundles,
        planner: {
          plan: (request) => {
            plannerCalls += 1;
            return fallback.plan(request);
          },
        },
        harnessPack,
      });
      const snapshot = coordinator.createPlanningContextSnapshot(TASK_REFERENCE, 'run-planning', {
        workspaceId: 'a'.repeat(24),
        reference: project.repository,
        path: process.cwd(),
      });
      if (!snapshot.ok) throw new Error(`Planning context failed: ${snapshot.error.kind}`);

      const result = await coordinator.prepare(
        TASK_REFERENCE,
        'fast',
        'tasker:test:validation-missing:planning',
        PLANNING_EPISODE_ID,
        snapshot.value.reference,
        evidence.value.reference,
      );

      expect(result).toMatchObject({
        ok: true,
        value: {
          status: 'failed',
          validationRevision: 0,
          failure: {
            kind: 'project_validation_missing',
            retryable: false,
            repositoryReference: 'onetwotrip/front-avia',
            expectedKeys: ['validation.targeted@1', 'validation.full@1', 'validation.build@1'],
            missingKeys: ['validation.targeted@1', 'validation.full@1', 'validation.build@1'],
            message:
              'Project onetwotrip/front-avia must declare validation.targeted@1, validation.full@1, validation.build@1; missing validation.targeted@1, validation.full@1, validation.build@1.',
          },
        },
      });
      expect(plannerCalls).toBe(1);
    } finally {
      ledger.close();
    }
  });
});
