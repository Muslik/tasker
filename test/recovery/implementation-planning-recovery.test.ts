import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createImplementationPlanningCoordinator,
  createM1WorkflowService,
  EvidenceBundleStore,
  PlanningEvidenceReaderRegistry,
  WorkflowGenerationSubjectSource,
} from '../../src/control-plane/index.js';
import { loadHarnessPack, type LoadedHarnessPack } from '../../src/harness/index.js';
import { openSqliteLedger } from '../../src/ledger/index.js';
import { ImplementationPlanningDecisionSchema } from '../../src/planning/implementation-plan.js';
import { RunPlanningSnapshotSchema } from '../../src/planning/run-planning-snapshot.js';
import {
  DeterministicImplementationPlanner,
  type ImplementationPlanner,
} from '../../src/providers/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { err, ok } from '../../src/shared/outcome.js';
import { recordTestEvidenceBundle } from '../helpers/evidence.js';

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
    recordTestEvidenceBundle(firstLedger.repository, clock, 'avia-13236-short-bug');
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
      recordTestEvidenceBundle(ledger.repository, clock, 'avia-13236-short-bug');
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

  it('deduplicates a completed Temporal planning command after Activity retry', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-plan-command-retry-'));
    const clock = makeAdjustableClock('2026-08-02T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
    try {
      const service = createM1WorkflowService(ledger.repository, clock);
      const generated = service.generate('avia-13236-short-bug');
      if (!generated.ok) throw new Error('Expected workflow generation to succeed');
      recordTestEvidenceBundle(ledger.repository, clock, 'avia-13236-short-bug');
      const fallback = new DeterministicImplementationPlanner();
      let providerCalls = 0;
      const planner: ImplementationPlanner = {
        plan: (request) => {
          providerCalls += 1;
          return fallback.plan(request);
        },
      };
      const coordinator = createImplementationPlanningCoordinator({
        ledger: ledger.repository,
        clock,
        workflows: service,
        subjects: new WorkflowGenerationSubjectSource(directory),
        planner,
      });
      const commandId = 'tasker:avia-13236-short-bug:planning:1';

      const completed = await coordinator.prepare('avia-13236-short-bug', 'fast', null, commandId);
      const retriedCompletion = await coordinator.prepare(
        'avia-13236-short-bug',
        'fast',
        null,
        commandId,
      );

      expect(completed).toEqual(retriedCompletion);
      expect(completed).toMatchObject({
        ok: true,
        value: { status: 'ready', attempt: 1, commandId },
      });
      expect(providerCalls).toBe(1);
    } finally {
      ledger.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('resumes a persisted evidence request after reader failure without rerunning that planner round', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-plan-evidence-recovery-'));
    const clock = makeAdjustableClock('2026-08-02T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
    try {
      const service = createM1WorkflowService(ledger.repository, clock);
      const generated = service.generate('avia-13236-short-bug');
      if (!generated.ok) throw new Error('Expected workflow generation to succeed');
      recordTestEvidenceBundle(ledger.repository, clock, 'avia-13236-short-bug');
      const fallback = new DeterministicImplementationPlanner();
      let plannerCalls = 0;
      const planner: ImplementationPlanner = {
        plan: async (request) => {
          plannerCalls += 1;
          const base = await fallback.plan(request);
          if (!base.ok) return base;
          if (plannerCalls === 1) {
            return ok({
              ...base.value,
              decision: null,
              evidenceRequests: [
                {
                  requestId: 'linked-issue',
                  skill: 'jira',
                  locator: 'AVIA-12045',
                  purpose: 'Confirm the linked issue acceptance criteria.',
                },
              ],
            });
          }
          expect(request.context.evidenceBundle.revision).toBe(2);
          const externalEvidence = request.context.evidenceBundle.entries.find(
            ({ evidenceType }) => evidenceType === 'external_document',
          );
          expect(externalEvidence?.provenance.source).toEqual({
            kind: 'external_system',
            locator: 'jira:AVIA-12045',
          });
          expect(externalEvidence?.provenance.introducedBy.phase).toBe('planning');
          expect(externalEvidence?.content).toEqual({
            key: 'AVIA-12045',
            acceptance: 'keep the current fallback',
          });
          return base;
        },
      };
      let readerCalls = 0;
      const evidenceReaders = new PlanningEvidenceReaderRegistry([
        {
          skill: 'jira',
          credentialEnvironment: ['JIRA_TOKEN'],
          read: (request) => {
            readerCalls += 1;
            if (readerCalls === 1) {
              return Promise.resolve(
                err({
                  kind: 'reader_unavailable' as const,
                  skill: 'jira',
                  message: 'Jira returned HTTP 403; VPN or access may be required',
                  retryable: true,
                }),
              );
            }
            return Promise.resolve(
              ok({
                skill: 'jira',
                locator: request.locator,
                title: 'AVIA-12045: Linked bug',
                observedVersion: '2026-08-02T11:00:00.000Z',
                mediaType: 'application/json',
                content: { key: 'AVIA-12045', acceptance: 'keep the current fallback' },
              }),
            );
          },
        },
      ]);
      const coordinator = createImplementationPlanningCoordinator({
        ledger: ledger.repository,
        clock,
        workflows: service,
        subjects: new WorkflowGenerationSubjectSource(directory),
        planner,
        evidenceReaders,
      });
      const commandId = 'tasker:avia-13236-short-bug:planning:1';

      const interrupted = await coordinator.prepare(
        'avia-13236-short-bug',
        'fast',
        null,
        commandId,
      );
      const pending = coordinator.read('avia-13236-short-bug');
      const resumed = await coordinator.prepare('avia-13236-short-bug', 'fast', null, commandId);

      expect(interrupted).toMatchObject({
        ok: false,
        error: { kind: 'evidence_read', error: { retryable: true } },
      });
      expect(pending).toMatchObject({
        ok: true,
        value: {
          status: 'planning',
          pendingEvidence: { round: 1, requests: [{ requestId: 'linked-issue' }] },
        },
      });
      expect(resumed).toMatchObject({
        ok: true,
        value: {
          status: 'ready',
          evidenceBundle: { revision: 2 },
          evidenceRounds: [{ round: 1, receipt: { usage: { inputTokens: 0 } } }],
        },
      });
      expect(plannerCalls).toBe(2);
      expect(readerCalls).toBe(2);
      expect(
        ledger.repository
          .listEvents('implementation-plan:avia-13236-short-bug')
          .map(({ eventType }) => eventType),
      ).toEqual([
        'ImplementationPlanningStarted',
        'PlanningEvidenceRequested',
        'PlanningEvidenceAppended',
        'ImplementationPlanReady',
      ]);
      expect(coordinator.readActivity('avia-13236-short-bug')).toHaveLength(4);
    } finally {
      ledger.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves planning-added evidence when a later provider call starts a new attempt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-plan-evidence-attempt-'));
    const clock = makeAdjustableClock('2026-08-02T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
    try {
      const service = createM1WorkflowService(ledger.repository, clock);
      const generated = service.generate('avia-13236-short-bug');
      if (!generated.ok) throw new Error('Expected workflow generation to succeed');
      recordTestEvidenceBundle(ledger.repository, clock, 'avia-13236-short-bug');
      const fallback = new DeterministicImplementationPlanner();
      let plannerCalls = 0;
      const coordinator = createImplementationPlanningCoordinator({
        ledger: ledger.repository,
        clock,
        workflows: service,
        subjects: new WorkflowGenerationSubjectSource(directory),
        planner: {
          plan: async (request) => {
            plannerCalls += 1;
            const base = await fallback.plan(request);
            if (!base.ok) return base;
            if (plannerCalls === 1) {
              return ok({
                ...base.value,
                decision: null,
                evidenceRequests: [
                  {
                    requestId: 'linked-issue',
                    skill: 'jira',
                    locator: 'AVIA-12045',
                    purpose: 'Confirm linked scope.',
                  },
                ],
              });
            }
            if (plannerCalls === 2) {
              return err({
                kind: 'provider_failed' as const,
                exitCode: 1,
                message: 'subscription provider disconnected',
                stderr: '',
              });
            }
            expect(request.context.evidenceBundle.revision).toBe(2);
            return base;
          },
        },
        evidenceReaders: new PlanningEvidenceReaderRegistry([
          {
            skill: 'jira',
            credentialEnvironment: ['JIRA_TOKEN'],
            read: (request) =>
              Promise.resolve(
                ok({
                  skill: 'jira',
                  locator: request.locator,
                  title: 'AVIA-12045: Linked scope',
                  observedVersion: '2026-08-02T11:00:00.000Z',
                  mediaType: 'application/json',
                  content: { key: 'AVIA-12045' },
                }),
              ),
          },
        ]),
      });
      const commandId = 'tasker:avia-13236-short-bug:planning:1';

      const failed = await coordinator.prepare('avia-13236-short-bug', 'fast', null, commandId);
      const retried = await coordinator.prepare('avia-13236-short-bug', 'fast', null, commandId);

      expect(failed).toMatchObject({
        ok: true,
        value: { status: 'failed', attempt: 1, evidenceBundle: { revision: 2 } },
      });
      expect(retried).toMatchObject({
        ok: true,
        value: { status: 'ready', attempt: 2, evidenceBundle: { revision: 2 } },
      });
      expect(plannerCalls).toBe(3);
    } finally {
      ledger.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses to plan against a workflow graph that changed after the run started', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-plan-snapshot-mismatch-'));
    const clock = makeAdjustableClock('2026-08-02T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
    try {
      const service = createM1WorkflowService(ledger.repository, clock);
      const generated = service.generate('avia-13236-short-bug');
      if (!generated.ok) throw new Error('Expected workflow generation to succeed');
      recordTestEvidenceBundle(ledger.repository, clock, 'avia-13236-short-bug');
      let providerCalls = 0;
      const coordinator = createImplementationPlanningCoordinator({
        ledger: ledger.repository,
        clock,
        workflows: service,
        subjects: new WorkflowGenerationSubjectSource(directory),
        planner: {
          plan: (request) => {
            providerCalls += 1;
            return new DeterministicImplementationPlanner().plan(request);
          },
        },
      });

      const outcome = await coordinator.prepare(
        'avia-13236-short-bug',
        'fast',
        null,
        'tasker:avia-13236-short-bug:planning:1',
        'workflow-hash-from-another-run',
      );

      expect(outcome).toEqual({
        ok: false,
        error: {
          kind: 'workflow_snapshot_mismatch',
          taskReference: 'avia-13236-short-bug',
          expectedHash: 'workflow-hash-from-another-run',
          actualHash: generated.value.view.workflow.graphHash,
        },
      });
      expect(providerCalls).toBe(0);
    } finally {
      ledger.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the snapshotted planning prompt after the configured harness changes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-plan-harness-snapshot-'));
    const clock = makeAdjustableClock('2026-08-02T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
    try {
      const service = createM1WorkflowService(ledger.repository, clock);
      const generated = service.generate('avia-13236-short-bug');
      if (!generated.ok) throw new Error('Expected workflow generation to succeed');
      recordTestEvidenceBundle(ledger.repository, clock, 'avia-13236-short-bug');
      const workflowHash = generated.value.view.workflow.graphHash;
      if (workflowHash === null) throw new Error('Expected a compiled workflow hash');
      const subjects = new WorkflowGenerationSubjectSource(directory);
      const originalPack = loadHarnessPack(join(process.cwd(), 'harness'));
      const snapshotCoordinator = createImplementationPlanningCoordinator({
        ledger: ledger.repository,
        clock,
        workflows: service,
        subjects,
        planner: new DeterministicImplementationPlanner(),
        harnessPack: originalPack,
      });
      const subject = subjects.resolve('avia-13236-short-bug');
      if (!subject.ok) throw new Error(`Subject failed: ${subject.error.kind}`);
      const snapshot = snapshotCoordinator.createRunSnapshot('avia-13236-short-bug', workflowHash, {
        workspaceId: '0'.repeat(24),
        reference: subject.value.task.repository,
        path: directory,
      });
      if (!snapshot.ok) throw new Error(`Snapshot failed: ${snapshot.error.kind}`);

      const changedContent = `${originalPack.prompts.implementationPlanner.content}\nchanged later`;
      const changedPack: LoadedHarnessPack = {
        ...originalPack,
        steps: originalPack.steps.map((step) =>
          step.reference === 'task.analyze@1' && step.execution.kind === 'agent'
            ? {
                ...step,
                execution: { ...step.execution, skills: ['test-design'] },
              }
            : step,
        ),
        prompts: {
          ...originalPack.prompts,
          implementationPlanner: {
            ...originalPack.prompts.implementationPlanner,
            content: changedContent,
            contentSha256: createHash('sha256').update(changedContent).digest('hex'),
          },
        },
      };
      let observedPrompt: string | null = null;
      let observedSkills: readonly string[] | null = null;
      let observedEvidenceBundle: unknown = null;
      const fallback = new DeterministicImplementationPlanner();
      const coordinator = createImplementationPlanningCoordinator({
        ledger: ledger.repository,
        clock,
        workflows: service,
        subjects,
        harnessPack: changedPack,
        planner: {
          plan: (request) => {
            observedPrompt = request.promptTemplate;
            observedSkills = request.skills;
            observedEvidenceBundle = request.context.evidenceBundle;
            return fallback.plan(request);
          },
        },
      });

      const planned = await coordinator.prepare(
        'avia-13236-short-bug',
        'fast',
        null,
        'tasker:avia-13236-short-bug:planning:1',
        workflowHash,
        snapshot.value,
      );

      expect(planned).toMatchObject({
        ok: true,
        value: { status: 'ready', planningSnapshot: snapshot.value },
      });
      expect(observedPrompt).toBe(originalPack.prompts.implementationPlanner.content);
      expect(observedPrompt).not.toBe(changedContent);
      expect(observedSkills).toEqual(['jira', 'confluence', 'loop']);
      const evidence = new EvidenceBundleStore(ledger.repository, clock).readLatest(
        'avia-13236-short-bug',
      );
      if (!evidence.ok || evidence.value === null) throw new Error('Expected planning evidence');
      expect(observedEvidenceBundle).toEqual(evidence.value.bundle);
      const snapshotArtifact = ledger.repository.readArtifact(snapshot.value.artifactId);
      if (snapshotArtifact === null) throw new Error('Expected planning snapshot artifact');
      expect(RunPlanningSnapshotSchema.parse(snapshotArtifact.payload).evidenceBundle).toEqual(
        evidence.value.reference,
      );
    } finally {
      ledger.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates a distinct immutable snapshot for each managed workspace', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-plan-workspace-snapshot-'));
    const clock = makeAdjustableClock('2026-08-02T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
    try {
      const service = createM1WorkflowService(ledger.repository, clock);
      const generated = service.generate('avia-13236-short-bug');
      if (!generated.ok) throw new Error('Expected workflow generation to succeed');
      recordTestEvidenceBundle(ledger.repository, clock, 'avia-13236-short-bug');
      const workflowHash = generated.value.view.workflow.graphHash;
      if (workflowHash === null) throw new Error('Expected a compiled workflow hash');
      const subjects = new WorkflowGenerationSubjectSource(directory);
      const subject = subjects.resolve('avia-13236-short-bug');
      if (!subject.ok) throw new Error(`Subject failed: ${subject.error.kind}`);
      const coordinator = createImplementationPlanningCoordinator({
        ledger: ledger.repository,
        clock,
        workflows: service,
        subjects,
        planner: new DeterministicImplementationPlanner(),
      });

      const first = coordinator.createRunSnapshot('avia-13236-short-bug', workflowHash, {
        workspaceId: '0'.repeat(24),
        reference: subject.value.task.repository,
        path: join(directory, 'worktree-1'),
      });
      const second = coordinator.createRunSnapshot('avia-13236-short-bug', workflowHash, {
        workspaceId: '1'.repeat(24),
        reference: subject.value.task.repository,
        path: join(directory, 'worktree-2'),
      });

      if (!first.ok || !second.ok) throw new Error('Expected both snapshots to succeed');
      expect(second.value.artifactId).not.toBe(first.value.artifactId);
      const secondArtifact = ledger.repository.readArtifact(second.value.artifactId);
      if (secondArtifact === null) throw new Error('Expected second snapshot artifact');
      expect(RunPlanningSnapshotSchema.parse(secondArtifact.payload).repository).toEqual({
        workspaceId: '1'.repeat(24),
        reference: subject.value.task.repository,
        path: join(directory, 'worktree-2'),
      });
    } finally {
      ledger.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('restores a persisted clarification decision without rerunning the provider', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-plan-question-recovery-'));
    const databasePath = join(directory, 'ledger.sqlite');
    const clock = makeAdjustableClock('2026-08-02T12:00:00.000Z');
    const firstLedger = openSqliteLedger({ filename: databasePath, clock });
    const firstService = createM1WorkflowService(firstLedger.repository, clock);
    const subjects = new WorkflowGenerationSubjectSource(directory);
    const generated = firstService.generate('avia-13236-short-bug');
    if (!generated.ok) throw new Error('Expected workflow generation to succeed');
    recordTestEvidenceBundle(firstLedger.repository, clock, 'avia-13236-short-bug');
    const fallback = new DeterministicImplementationPlanner();
    const questioningPlanner: ImplementationPlanner = {
      plan: async (request) => {
        const result = await fallback.plan(request);
        return result.ok
          ? ok({
              ...result.value,
              decision: ImplementationPlanningDecisionSchema.parse({
                status: 'needs_clarification',
                questions: [
                  {
                    id: 'target-browser',
                    question: 'Which browser must the reproduction cover?',
                    reason: 'The expected evidence depends on this choice.',
                  },
                ],
              }),
            })
          : result;
      },
    };
    const firstCoordinator = createImplementationPlanningCoordinator({
      ledger: firstLedger.repository,
      clock,
      workflows: firstService,
      subjects,
      planner: questioningPlanner,
    });
    const planned = await firstCoordinator.prepare('avia-13236-short-bug', 'fast');
    if (!planned.ok || planned.value.status !== 'needs_clarification') {
      throw new Error('Expected planning to require clarification');
    }
    firstLedger.close();

    let providerCalls = 0;
    const providerThatMustNotRun: ImplementationPlanner = {
      plan: () => {
        providerCalls += 1;
        return Promise.reject(new Error('Provider must not run while restoring a wait'));
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

      const restoredPlanning = restartedCoordinator.read('avia-13236-short-bug');

      expect(restoredPlanning).toMatchObject({
        ok: true,
        value: { status: 'needs_clarification', attempt: 1 },
      });
      expect(providerCalls).toBe(0);
    } finally {
      restartedLedger.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
