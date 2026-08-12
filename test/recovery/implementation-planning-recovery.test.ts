import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createImplementationPlanningCoordinator,
  createM1WorkflowService,
  EvidenceBundleStore,
  type ImplementationPlanningCoordinator,
  WorkflowGenerationSubjectSource,
} from '../../src/control-plane/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import {
  ImplementationPlanningDecisionSchema,
  type EvidenceBundleReference,
  type PlanningSnapshotReference,
} from '../../src/planning/index.js';
import {
  DeterministicImplementationPlanner,
  type ImplementationPlanner,
} from '../../src/providers/index.js';
import { makeAdjustableClock, type Clock } from '../../src/shared/clock.js';
import { err, ok } from '../../src/shared/outcome.js';
import { recordTestEvidenceBundle } from '../helpers/evidence.js';

const TASK_REFERENCE = 'avia-13236-short-bug';
const REPOSITORY = 'onetwotrip/front-avia';

interface PlanningFixture {
  readonly coordinator: ImplementationPlanningCoordinator;
  readonly evidence: EvidenceBundleReference;
  readonly snapshot: PlanningSnapshotReference;
}

const planningFixture = (
  ledger: SqliteLedger,
  clock: Clock,
  directory: string,
  planner: ImplementationPlanner,
  subjects: WorkflowGenerationSubjectSource = new WorkflowGenerationSubjectSource(directory),
): PlanningFixture => {
  const workflows = createM1WorkflowService(ledger.repository, clock);
  const evidenceBundles = new EvidenceBundleStore(ledger.repository, clock);
  recordTestEvidenceBundle(ledger.repository, clock, TASK_REFERENCE);
  const evidence = evidenceBundles.readLatest(TASK_REFERENCE);
  if (!evidence.ok || evidence.value === null) throw new Error('Missing planning evidence');
  const coordinator = createImplementationPlanningCoordinator({
    ledger: ledger.repository,
    clock,
    workflows,
    subjects,
    evidenceBundles,
    planner,
  });
  const snapshot = coordinator.createPlanningContextSnapshot(TASK_REFERENCE, {
    workspaceId: 'a'.repeat(24),
    reference: REPOSITORY,
    path: directory,
  });
  if (!snapshot.ok) throw new Error(`Planning context failed: ${snapshot.error.kind}`);
  return {
    coordinator,
    evidence: evidence.value.reference,
    snapshot: snapshot.value.reference,
  };
};

class InterruptibleSubjectSource extends WorkflowGenerationSubjectSource {
  public available = true;

  public override resolve(
    taskReference: string,
  ): ReturnType<WorkflowGenerationSubjectSource['resolve']> {
    return this.available
      ? super.resolve(taskReference)
      : err({ kind: 'task_not_found', taskReference });
  }
}

const withPlanningFixture = async (
  prefix: string,
  run: (input: {
    readonly directory: string;
    readonly databasePath: string;
    readonly clock: Clock;
    readonly ledger: SqliteLedger;
  }) => Promise<void>,
): Promise<void> => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const databasePath = join(directory, 'ledger.sqlite');
  const clock = makeAdjustableClock('2026-08-02T12:00:00.000Z');
  const ledger = openSqliteLedger({ filename: databasePath, clock });
  try {
    await run({ directory, databasePath, clock, ledger });
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

describe('implementation planning recovery', () => {
  it('restores the accepted plan and planner-created workflow without rerunning the provider', async () => {
    await withPlanningFixture(
      'tasker-plan-recovery-',
      async ({ directory, databasePath, clock, ledger }) => {
        const first = planningFixture(
          ledger,
          clock,
          directory,
          new DeterministicImplementationPlanner(),
        );
        const commandId = 'tasker:test:planning:1';
        const planned = await first.coordinator.prepare(
          TASK_REFERENCE,
          'fast',
          commandId,
          first.snapshot,
          first.evidence,
        );
        expect(planned).toMatchObject({
          ok: true,
          value: { status: 'ready', commandId, validationRevision: 0 },
        });
        if (!planned.ok || planned.value.status !== 'ready') {
          throw new Error('Expected a ready plan');
        }
        const firstDraft = first.coordinator.draftFor(planned.value);
        expect(firstDraft).toMatchObject({
          ok: true,
          value: { workflowHash: planned.value.workflowHash },
        });

        let calls = 0;
        const restartedLedger = openSqliteLedger({ filename: databasePath, clock });
        try {
          const restarted = createImplementationPlanningCoordinator({
            ledger: restartedLedger.repository,
            clock,
            workflows: createM1WorkflowService(restartedLedger.repository, clock),
            subjects: new WorkflowGenerationSubjectSource(directory),
            planner: {
              plan: () => {
                calls += 1;
                return Promise.reject(new Error('Provider must not rerun'));
              },
            },
          });
          const restored = await restarted.prepare(
            TASK_REFERENCE,
            'fast',
            commandId,
            first.snapshot,
            first.evidence,
          );
          expect(restored).toEqual(planned);
          expect(calls).toBe(0);
        } finally {
          restartedLedger.close();
        }
      },
    );
  });

  it('retries a failed provider command without creating a provisional workflow', async () => {
    await withPlanningFixture('tasker-plan-retry-', async ({ directory, clock, ledger }) => {
      const fallback = new DeterministicImplementationPlanner();
      let calls = 0;
      const planner: ImplementationPlanner = {
        plan: (request) => {
          calls += 1;
          return calls === 1
            ? Promise.resolve(
                ok({
                  decision: null,
                  evidenceRequests: [],
                  stderr: '403',
                  receipt: {
                    status: 'completed',
                    provider: 'deterministic',
                    plannerVersion: 'implementation-planner@3',
                    profile: 'deterministic',
                    profileSha256: '0'.repeat(64),
                    cliVersion: 'deterministic@1',
                    model: 'deterministic',
                    effort: 'low',
                    serviceTier: null,
                    strategy: request.strategy,
                    sessionId: 'failed-once',
                    promptHash: '0'.repeat(64),
                    durationMs: 0,
                    usage: {
                      inputTokens: 0,
                      cachedInputTokens: 0,
                      outputTokens: 0,
                      reasoningOutputTokens: 0,
                    },
                    hypotheticalApiCostUsd: 0,
                  },
                }),
              )
            : fallback.plan(request);
        },
      };
      const fixture = planningFixture(ledger, clock, directory, planner);
      const commandId = 'tasker:test:planning:retry';

      const failed = await fixture.coordinator.prepare(
        TASK_REFERENCE,
        'fast',
        commandId,
        fixture.snapshot,
        fixture.evidence,
      );
      expect(failed).toMatchObject({
        ok: true,
        value: {
          status: 'failed',
          failure: { kind: 'invalid_planner_output', retryable: false },
        },
      });
      expect(createM1WorkflowService(ledger.repository, clock).read(TASK_REFERENCE)).toEqual(
        ok(null),
      );

      const retried = await fixture.coordinator.prepare(
        TASK_REFERENCE,
        'fast',
        commandId,
        fixture.snapshot,
        fixture.evidence,
      );
      expect(retried).toMatchObject({ ok: true, value: { status: 'ready', attempt: 2 } });
      expect(calls).toBe(2);
    });
  });

  it('deduplicates a completed Temporal planning command', async () => {
    await withPlanningFixture('tasker-plan-idempotent-', async ({ directory, clock, ledger }) => {
      const fallback = new DeterministicImplementationPlanner();
      let calls = 0;
      const fixture = planningFixture(ledger, clock, directory, {
        plan: (request) => {
          calls += 1;
          return fallback.plan(request);
        },
      });
      const commandId = 'tasker:test:planning:idempotent';
      const first = await fixture.coordinator.prepare(
        TASK_REFERENCE,
        'fast',
        commandId,
        fixture.snapshot,
        fixture.evidence,
      );
      const second = await fixture.coordinator.prepare(
        TASK_REFERENCE,
        'fast',
        commandId,
        fixture.snapshot,
        fixture.evidence,
      );

      expect(second).toEqual(first);
      expect(calls).toBe(1);
    });
  });

  it('resumes snapshot materialization from the validated candidate without rerunning the planner', async () => {
    await withPlanningFixture(
      'tasker-plan-materialization-recovery-',
      async ({ directory, clock, ledger }) => {
        const fallback = new DeterministicImplementationPlanner();
        const subjects = new InterruptibleSubjectSource(directory);
        let calls = 0;
        const fixture = planningFixture(
          ledger,
          clock,
          directory,
          {
            plan: (request) => {
              calls += 1;
              return fallback.plan(request);
            },
          },
          subjects,
        );
        const commandId = 'tasker:test:planning:materialization-recovery';

        subjects.available = false;
        const interrupted = await fixture.coordinator.prepare(
          TASK_REFERENCE,
          'fast',
          commandId,
          fixture.snapshot,
          fixture.evidence,
        );

        expect(interrupted).toMatchObject({ ok: false, error: { kind: 'subject' } });
        const checkpoint = fixture.coordinator.read(TASK_REFERENCE);
        if (!checkpoint.ok || checkpoint.value?.status !== 'planning') {
          throw new Error('Validated planning candidate was not checkpointed');
        }
        expect(checkpoint.value.validatedCandidate?.workflowHash).toMatch(/^[a-f0-9]{64}$/u);
        expect(calls).toBe(1);

        subjects.available = true;
        const resumed = await fixture.coordinator.prepare(
          TASK_REFERENCE,
          'fast',
          commandId,
          fixture.snapshot,
          fixture.evidence,
        );

        expect(resumed).toMatchObject({ ok: true, value: { status: 'ready', attempt: 1 } });
        expect(calls).toBe(1);
        expect(
          ledger.repository
            .listEvents(`implementation-plan:${TASK_REFERENCE}`)
            .map(({ eventType }) => eventType),
        ).toContain('ImplementationWorkflowCandidateValidated');
      },
    );
  });

  it('persists blocking questions and resumes the same task from typed operator answers', async () => {
    await withPlanningFixture('tasker-plan-questions-', async ({ directory, clock, ledger }) => {
      const fallback = new DeterministicImplementationPlanner();
      let calls = 0;
      let observedGuidance: string | null = null;
      const fixture = planningFixture(ledger, clock, directory, {
        plan: async (request) => {
          calls += 1;
          const base = await fallback.plan(request);
          if (!base.ok) return base;
          if (calls === 1) {
            return ok({
              ...base.value,
              decision: ImplementationPlanningDecisionSchema.parse({
                status: 'needs_clarification',
                questions: [
                  {
                    id: 'target-scenario',
                    question: 'Which payment scenario must reproduce the bug?',
                    reason: 'The task evidence names multiple variants.',
                  },
                ],
              }),
            });
          }
          observedGuidance = request.context.operatorGuidance;
          return base;
        },
      });
      const waiting = await fixture.coordinator.prepare(
        TASK_REFERENCE,
        'fast',
        'tasker:test:planning:questions:1',
        fixture.snapshot,
        fixture.evidence,
      );
      expect(waiting).toMatchObject({
        ok: true,
        value: {
          status: 'needs_clarification',
          decision: { questions: [{ id: 'target-scenario' }] },
        },
      });

      const resumed = await fixture.coordinator.answer(
        TASK_REFERENCE,
        [{ questionId: 'target-scenario', answer: 'Use the card payment scenario.' }],
        'tasker:test:planning:questions:2',
        fixture.snapshot,
        fixture.evidence,
      );
      expect(resumed).toMatchObject({ ok: true, value: { status: 'ready', attempt: 2 } });
      expect(observedGuidance).toContain('Use the card payment scenario.');
      expect(calls).toBe(2);
    });
  });

  it('accepts only registered pre-plan investigation blocks', async () => {
    await withPlanningFixture(
      'tasker-plan-investigation-',
      async ({ directory, clock, ledger }) => {
        const fallback = new DeterministicImplementationPlanner();
        const fixture = planningFixture(ledger, clock, directory, {
          plan: async (request) => {
            const base = await fallback.plan(request);
            if (!base.ok) return base;
            return ok({
              ...base.value,
              decision: ImplementationPlanningDecisionSchema.parse({
                status: 'investigation_required',
                request: {
                  reason: 'The reported bug must be grounded before implementation planning.',
                  steps: [
                    {
                      id: 'investigate-reported-bug',
                      uses: 'bug.investigate@1',
                      with: {
                        objective: 'Reproduce the reported behavior.',
                        repository: REPOSITORY,
                        taskId: 'AVIA-13236',
                      },
                    },
                  ],
                },
              }),
            });
          },
        });

        const result = await fixture.coordinator.prepare(
          TASK_REFERENCE,
          'fast',
          'tasker:test:planning:investigation',
          fixture.snapshot,
          fixture.evidence,
        );
        expect(result).toMatchObject({
          ok: true,
          value: {
            status: 'investigation_required',
            decision: { request: { steps: [{ uses: 'bug.investigate@1' }] } },
          },
        });
      },
    );
  });

  it('feeds deterministic validator errors and the rejected candidate back to the planner', async () => {
    await withPlanningFixture(
      'tasker-plan-validator-loop-',
      async ({ directory, clock, ledger }) => {
        const fallback = new DeterministicImplementationPlanner();
        let calls = 0;
        let feedback: readonly string[] = [];
        let previousStatus: string | null = null;
        const fixture = planningFixture(ledger, clock, directory, {
          plan: async (request) => {
            calls += 1;
            const base = await fallback.plan(request);
            if (!base.ok || base.value.decision?.status !== 'ready') return base;
            if (calls === 1) {
              const source = base.value.decision.workflow.source;
              if (source.root.kind !== 'sequence') throw new Error('Expected sequence fixture');
              return ok({
                ...base.value,
                decision: {
                  ...base.value.decision,
                  workflow: {
                    ...base.value.decision.workflow,
                    source: {
                      ...source,
                      root: {
                        ...source.root,
                        children: [
                          {
                            kind: 'step',
                            id: 'unknown-step',
                            uses: 'unknown.step@1',
                            with: {},
                          },
                          ...source.root.children,
                        ],
                      },
                    },
                  },
                },
              });
            }
            feedback = request.context.validationFeedback;
            previousStatus = request.context.previousDecision?.status ?? null;
            return base;
          },
        });

        const result = await fixture.coordinator.prepare(
          TASK_REFERENCE,
          'fast',
          'tasker:test:planning:validator-loop',
          fixture.snapshot,
          fixture.evidence,
        );
        expect(result).toMatchObject({
          ok: true,
          value: { status: 'ready', validationRevision: 1 },
        });
        expect(feedback.join('\n')).toContain('unknown.step@1');
        expect(previousStatus).toBe('ready');
        expect(calls).toBe(2);
        expect(
          ledger.repository
            .listEvents(`implementation-plan:${TASK_REFERENCE}`)
            .map(({ eventType }) => eventType),
        ).toContain('ImplementationWorkflowCandidateRejected');
        expect(fixture.coordinator.readActivity(TASK_REFERENCE)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              level: 'info',
              title: 'Workflow candidate corrected',
            }),
          ]),
        );
      },
    );
  });

  it('preserves the rejected candidate and validator feedback for an operator-guided revision', async () => {
    await withPlanningFixture(
      'tasker-plan-validator-guided-revision-',
      async ({ directory, clock, ledger }) => {
        const fallback = new DeterministicImplementationPlanner();
        const firstCommand = 'tasker:test:planning:validator-exhausted';
        const revisionCommand = 'tasker:test:planning:validator-guided-revision';
        let inheritedFeedback: readonly string[] = [];
        let inheritedDecision: string | null = null;
        const fixture = planningFixture(ledger, clock, directory, {
          plan: async (request) => {
            const base = await fallback.plan(request);
            if (!base.ok || base.value.decision?.status !== 'ready') return base;
            if (request.operationId === firstCommand) {
              const source = base.value.decision.workflow.source;
              if (source.root.kind !== 'sequence') throw new Error('Expected sequence fixture');
              return ok({
                ...base.value,
                decision: {
                  ...base.value.decision,
                  workflow: {
                    ...base.value.decision.workflow,
                    source: {
                      ...source,
                      root: {
                        ...source.root,
                        children: [
                          {
                            kind: 'step',
                            id: 'unknown-step',
                            uses: 'unknown.step@1',
                            with: {},
                          },
                          ...source.root.children,
                        ],
                      },
                    },
                  },
                },
              });
            }
            inheritedFeedback = request.context.validationFeedback;
            inheritedDecision = request.context.previousDecision?.status ?? null;
            return base;
          },
        });

        const failed = await fixture.coordinator.prepare(
          TASK_REFERENCE,
          'fast',
          firstCommand,
          fixture.snapshot,
          fixture.evidence,
        );
        expect(failed).toMatchObject({
          ok: true,
          value: {
            status: 'failed',
            validationRevision: 2,
            failure: { kind: 'invalid_planner_output', retryable: false },
          },
        });

        const revised = await fixture.coordinator.prepare(
          TASK_REFERENCE,
          'fast',
          revisionCommand,
          fixture.snapshot,
          fixture.evidence,
          'Correct the rejected graph using the deterministic feedback.',
        );

        expect(revised).toMatchObject({ ok: true, value: { status: 'ready', attempt: 2 } });
        expect(inheritedFeedback.join('\n')).toContain('unknown.step@1');
        expect(inheritedFeedback.filter((issue) => issue.includes('unknown.step@1'))).toHaveLength(
          1,
        );
        expect(inheritedDecision).toBe('ready');
      },
    );
  });

  it('returns missing acceptance-verification steps to the planner as candidate feedback', async () => {
    await withPlanningFixture(
      'tasker-plan-acceptance-link-loop-',
      async ({ directory, clock, ledger }) => {
        const fallback = new DeterministicImplementationPlanner();
        let calls = 0;
        let feedback: readonly string[] = [];
        const fixture = planningFixture(ledger, clock, directory, {
          plan: async (request) => {
            calls += 1;
            const base = await fallback.plan(request);
            if (!base.ok || base.value.decision?.status !== 'ready') return base;
            if (calls === 1) {
              const [criterion, ...remainingCriteria] = base.value.decision.plan.acceptanceCriteria;
              if (criterion === undefined) throw new Error('Expected acceptance criterion');
              const [verification, ...remainingVerifications] = criterion.verification;
              if (verification === undefined) throw new Error('Expected acceptance verification');
              return ok({
                ...base.value,
                decision: {
                  ...base.value.decision,
                  plan: {
                    ...base.value.decision.plan,
                    acceptanceCriteria: [
                      {
                        ...criterion,
                        verification: [
                          { ...verification, workflowStepIds: ['missing-verification-step'] },
                          ...remainingVerifications,
                        ],
                      },
                      ...remainingCriteria,
                    ],
                  },
                },
              });
            }
            feedback = request.context.validationFeedback;
            return base;
          },
        });

        const result = await fixture.coordinator.prepare(
          TASK_REFERENCE,
          'fast',
          'tasker:test:planning:acceptance-link-loop',
          fixture.snapshot,
          fixture.evidence,
        );

        expect(result).toMatchObject({
          ok: true,
          value: { status: 'ready', validationRevision: 1 },
        });
        expect(feedback).toContain(
          'Acceptance criterion requested-behavior references missing workflow step missing-verification-step.',
        );
        expect(calls).toBe(2);
      },
    );
  });
});
