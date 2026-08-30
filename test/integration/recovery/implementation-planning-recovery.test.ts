import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EvidenceBundleStore } from '../../../src/server/evidence-bundle.js';
import {
  createImplementationPlanningCoordinator,
  type ImplementationPlanningCoordinator,
} from '../../../src/server/planning-coordinator.js';
import { ImplementationPlanningStore } from '../../../src/server/planning-episodes.js';
import { createOperatorWorkflowService } from '../../../src/server/operator-service.js';
import { openSqliteLedger, type SqliteLedger } from '../../../src/store/index.js';
import {
  LedgerAgentInvocationRecorder,
  planningAgentInvocationId,
} from '../../../src/steps/agent-invocation.js';
import {
  ImplementationPlanningDecisionSchema,
  WorkflowGenerationSubjectSource,
  type EvidenceBundleReference,
  type PlanningSnapshotReference,
  type WorkflowGenerationSubjectRunStore,
} from '../../../src/planning/index.js';
import { type ImplementationPlanner } from '../../../src/agents/index.js';
import { makeAdjustableClock, type Clock } from '../../../src/shared/clock.js';
import { err, ok } from '../../../src/shared/outcome.js';
import { recordTestEvidenceBundle } from '../../helpers/evidence.js';
import {
  makeTestGenerationSubjectSource,
  makeTestImplementationPlanner,
} from '../../support/planning.js';

const TASK_REFERENCE = 'avia-13236-short-bug';
const REPOSITORY = 'onetwotrip/front-avia';
const PLANNING_EPISODE_ID = 'tasker:test:planning';
const EVIDENCE_SCOPE_ID = `test:${TASK_REFERENCE}`;

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
  subjects: WorkflowGenerationSubjectSource = makeTestGenerationSubjectSource(directory),
): PlanningFixture => {
  const workflows = createOperatorWorkflowService(ledger.repository, clock);
  const evidenceBundles = new EvidenceBundleStore(ledger.repository, clock);
  recordTestEvidenceBundle(ledger.repository, clock, TASK_REFERENCE);
  const evidence = evidenceBundles.readLatest(EVIDENCE_SCOPE_ID);
  if (!evidence.ok || evidence.value === null) throw new Error('Missing planning evidence');
  const coordinator = createImplementationPlanningCoordinator({
    ledger: ledger.repository,
    clock,
    workflows,
    subjects,
    evidenceBundles,
    planner,
  });
  const snapshot = coordinator.createPlanningContextSnapshot(TASK_REFERENCE, 'run-planning', {
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
    workflowRunId: string,
  ): ReturnType<WorkflowGenerationSubjectSource['resolve']> {
    return this.available
      ? super.resolve(taskReference, workflowRunId)
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
  it('never supplies a plan from another run of the same task as previousDecision', async () => {
    await withPlanningFixture(
      'tasker-plan-run-isolation-',
      async ({ directory, clock, ledger }) => {
        const fallback = makeTestImplementationPlanner();
        const previousDecisions: unknown[] = [];
        const fixture = planningFixture(ledger, clock, directory, {
          plan: (request) => {
            previousDecisions.push(request.context.previousDecision);
            return fallback.plan(request);
          },
        });

        const first = await fixture.coordinator.prepare(
          TASK_REFERENCE,
          'fast',
          'tasker:v3:jira:AVIA-12045:run-a:planning:1',
          'tasker:v3:jira:AVIA-12045:run-a:planning',
          fixture.snapshot,
          fixture.evidence,
        );
        const second = await fixture.coordinator.prepare(
          TASK_REFERENCE,
          'fast',
          'tasker:v3:jira:AVIA-12045:run-b:planning:1',
          'tasker:v3:jira:AVIA-12045:run-b:planning',
          fixture.snapshot,
          fixture.evidence,
        );

        expect(first).toMatchObject({ ok: true, value: { status: 'ready', attempt: 1 } });
        expect(second).toMatchObject({ ok: true, value: { status: 'ready', attempt: 1 } });
        expect(previousDecisions).toEqual([null, null]);
      },
    );
  });

  it('restores the accepted plan and planner-created workflow without rerunning the provider', async () => {
    await withPlanningFixture(
      'tasker-plan-recovery-',
      async ({ directory, databasePath, clock, ledger }) => {
        const first = planningFixture(ledger, clock, directory, makeTestImplementationPlanner());
        const commandId = 'tasker:test:planning:1';
        const planned = await first.coordinator.prepare(
          TASK_REFERENCE,
          'fast',
          commandId,
          PLANNING_EPISODE_ID,
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
        const executionSnapshot = first.coordinator.readRunSnapshot(
          planned.value.executionSnapshot,
        );
        expect(executionSnapshot.ok).toBe(true);
        if (!executionSnapshot.ok || executionSnapshot.value.kind !== 'execution') {
          throw new Error('Expected an execution snapshot');
        }
        expect(executionSnapshot.value.executionStrategy).toBe('simple');
        expect(
          executionSnapshot.value.harness.steps.find(
            ({ reference }) => reference === 'implement.change@1',
          )?.executionProfile,
        ).toMatchObject({ model: 'gpt-5.6-luna', effort: 'medium' });
        expect(
          executionSnapshot.value.harness.steps.find(
            ({ reference }) => reference === 'review.change@1',
          )?.executionProfile,
        ).toMatchObject({ model: 'sonnet', effort: 'high' });
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
            workflows: createOperatorWorkflowService(restartedLedger.repository, clock),
            subjects: makeTestGenerationSubjectSource(directory),
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
            PLANNING_EPISODE_ID,
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
      const fallback = makeTestImplementationPlanner();
      let calls = 0;
      const planner: ImplementationPlanner = {
        plan: (request) => {
          calls += 1;
          return calls === 1
            ? Promise.resolve(
                ok({
                  decision: null,
                  evidenceRequests: [],
                  receipt: {
                    status: 'completed',
                    provider: 'codex_cli',
                    plannerVersion: 'implementation-planner@4',
                    profile: 'test-planner',
                    profileSha256: '0'.repeat(64),
                    cliVersion: 'test@1',
                    model: 'test-model',
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
                    apiCost: { source: 'provider_reported', amountUsd: 0 },
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
        PLANNING_EPISODE_ID,
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
      expect(
        createOperatorWorkflowService(ledger.repository, clock).readPlanningOperation(
          TASK_REFERENCE,
          `${PLANNING_EPISODE_ID}:workflow-candidate:1`,
        ),
      ).toEqual(ok(null));

      const retried = await fixture.coordinator.prepare(
        TASK_REFERENCE,
        'fast',
        commandId,
        PLANNING_EPISODE_ID,
        fixture.snapshot,
        fixture.evidence,
      );
      expect(retried).toMatchObject({ ok: true, value: { status: 'ready', attempt: 2 } });
      expect(calls).toBe(2);
    });
  });

  it('deduplicates a completed Temporal planning command', async () => {
    await withPlanningFixture('tasker-plan-idempotent-', async ({ directory, clock, ledger }) => {
      const fallback = makeTestImplementationPlanner();
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
        PLANNING_EPISODE_ID,
        fixture.snapshot,
        fixture.evidence,
      );
      const second = await fixture.coordinator.prepare(
        TASK_REFERENCE,
        'fast',
        commandId,
        PLANNING_EPISODE_ID,
        fixture.snapshot,
        fixture.evidence,
      );

      expect(second).toEqual(first);
      expect(calls).toBe(1);
    });
  });

  it('materializes the execution snapshot without rereading the mutable task source', async () => {
    await withPlanningFixture(
      'tasker-plan-materialization-recovery-',
      async ({ directory, clock, ledger }) => {
        const fallback = makeTestImplementationPlanner();
        const stableSubjects = makeTestGenerationSubjectSource(directory);
        const runStore: WorkflowGenerationSubjectRunStore = {
          readRunGenerationSubject: () => ok(null),
          captureRunGenerationSubject: (_taskReference, _workflowRunId, subject) => ok(subject),
        };
        const subjects = new InterruptibleSubjectSource(
          [
            {
              resolve: (taskReference) => stableSubjects.resolve(taskReference, 'stable-source'),
            },
          ],
          runStore,
        );
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
        const prepared = await fixture.coordinator.prepare(
          TASK_REFERENCE,
          'fast',
          commandId,
          PLANNING_EPISODE_ID,
          fixture.snapshot,
          fixture.evidence,
        );

        expect(prepared).toMatchObject({ ok: true, value: { status: 'ready', attempt: 1 } });
        expect(calls).toBe(1);
        expect(fixture.coordinator.readActivity(PLANNING_EPISODE_ID)).toEqual(
          expect.arrayContaining([expect.objectContaining({ title: 'Implementation planning' })]),
        );
      },
    );
  });

  it('persists blocking questions and resumes the same task from typed operator answers', async () => {
    await withPlanningFixture('tasker-plan-questions-', async ({ directory, clock, ledger }) => {
      const fallback = makeTestImplementationPlanner();
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
        PLANNING_EPISODE_ID,
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
        PLANNING_EPISODE_ID,
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
        const fallback = makeTestImplementationPlanner();
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
                      uses: 'runtime.observe@1',
                      with: {
                        objective: 'Reproduce the reported behavior.',
                        repository: REPOSITORY,
                        taskId: 'AVIA-13236',
                        claim: 'The reported behavior is observable in the prepared application.',
                        scenario: 'Repeat the bounded reproduction steps from the task.',
                        requestedEvidence: ['video'],
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
          PLANNING_EPISODE_ID,
          fixture.snapshot,
          fixture.evidence,
        );
        expect(result).toMatchObject({
          ok: true,
          value: {
            status: 'investigation_required',
            decision: { request: { steps: [{ uses: 'runtime.observe@1' }] } },
          },
        });
      },
    );
  });

  it('feeds deterministic slot errors and the rejected candidate back to the planner', async () => {
    await withPlanningFixture(
      'tasker-plan-validator-loop-',
      async ({ directory, clock, ledger }) => {
        const fallback = makeTestImplementationPlanner();
        let calls = 0;
        let feedback: readonly string[] = [];
        let previousStatus: string | null = null;
        const fixture = planningFixture(ledger, clock, directory, {
          plan: async (request) => {
            calls += 1;
            const base = await fallback.plan(request);
            if (!base.ok || base.value.decision?.status !== 'ready') return base;
            if (calls === 1) {
              if (base.value.decision.archetype !== 'deliver-pr') {
                throw new Error('Expected deliver-pr decision fixture');
              }
              return ok({
                ...base.value,
                decision: {
                  ...base.value.decision,
                  segments: ['translations'],
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
          PLANNING_EPISODE_ID,
          fixture.snapshot,
          fixture.evidence,
        );
        expect(result).toMatchObject({
          ok: true,
          value: { status: 'ready', validationRevision: 1 },
        });
        expect(feedback).toContain(
          'Segment translations is unavailable in the frozen block catalog.',
        );
        expect(previousStatus).toBe('ready');
        expect(calls).toBe(2);
        expect(fixture.coordinator.readActivity(PLANNING_EPISODE_ID)).toEqual(
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

  it('assigns stable invocation ordinals and passes planning inputs back through the validation loop', async () => {
    await withPlanningFixture(
      'tasker-plan-invocation-loop-',
      async ({ directory, clock, ledger }) => {
        const fallback = makeTestImplementationPlanner();
        const invocations: Array<{
          readonly invocationNumber: number;
          readonly inputEvidenceArtifactIds: readonly string[];
        }> = [];
        const fixture = planningFixture(ledger, clock, directory, {
          plan: async (request) => {
            invocations.push({
              invocationNumber: request.invocationNumber,
              inputEvidenceArtifactIds: request.inputEvidenceArtifactIds,
            });
            const base = await fallback.plan(request);
            if (!base.ok || invocations.length !== 1) {
              return base;
            }
            return err({
              kind: 'invalid_planner_output',
              issues: [
                'decision.segments.0: Invalid option: expected one of "dependency_await"|"translations"',
              ],
              receipt: base.value.receipt,
            });
          },
        });

        const result = await fixture.coordinator.prepare(
          TASK_REFERENCE,
          'fast',
          'tasker:test:planning:invocation-loop',
          PLANNING_EPISODE_ID,
          fixture.snapshot,
          fixture.evidence,
        );

        expect(result).toMatchObject({
          ok: true,
          value: { status: 'ready', validationRevision: 1 },
        });
        expect(invocations).toEqual([
          {
            invocationNumber: 1,
            inputEvidenceArtifactIds: [fixture.snapshot.artifactId, fixture.evidence.artifactId],
          },
          {
            invocationNumber: 2,
            inputEvidenceArtifactIds: [fixture.snapshot.artifactId, fixture.evidence.artifactId],
          },
        ]);
      },
    );
  });

  it('advances the invocation ordinal after an interrupted provider run', async () => {
    await withPlanningFixture('tasker-plan-invocation-retry-', ({ clock, ledger }) => {
      const recorder = new LedgerAgentInvocationRecorder(ledger.repository, clock);
      const invocationId = planningAgentInvocationId(PLANNING_EPISODE_ID, 1, 1);
      const references = {
        kind: 'planning' as const,
        planningEpisodeId: PLANNING_EPISODE_ID,
        planningAttempt: 1,
        invocationNumber: 1,
        operationId: 'interrupted-command',
        transcriptId: 'planning-transcript:interrupted-command',
        outputArtifactIds: [],
        receiptArtifactId: null,
      };
      recorder.start({
        invocationId,
        taskReference: TASK_REFERENCE,
        references,
        startedAt: clock.now(),
      });
      const store = new ImplementationPlanningStore(ledger.repository, clock);

      expect(store.nextAgentInvocationNumber(PLANNING_EPISODE_ID, 1)).toBe(2);
      return Promise.resolve();
    });
  });

  it('preserves the rejected candidate and validator feedback for an operator-guided revision', async () => {
    await withPlanningFixture(
      'tasker-plan-validator-guided-revision-',
      async ({ directory, clock, ledger }) => {
        const fallback = makeTestImplementationPlanner();
        const firstCommand = 'tasker:test:planning:validator-exhausted';
        const revisionCommand = 'tasker:test:planning:validator-guided-revision';
        let inheritedFeedback: readonly string[] = [];
        let inheritedDecision: string | null = null;
        const fixture = planningFixture(ledger, clock, directory, {
          plan: async (request) => {
            const base = await fallback.plan(request);
            if (!base.ok) return base;
            if (request.operationId === firstCommand) {
              return err({
                kind: 'invalid_planner_output',
                issues: [
                  'decision.segments.0: Invalid option: expected one of "dependency_await"|"translations"',
                ],
                receipt: base.value.receipt,
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
          PLANNING_EPISODE_ID,
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
          PLANNING_EPISODE_ID,
          fixture.snapshot,
          fixture.evidence,
          'Correct the rejected graph using the deterministic feedback.',
        );

        expect(revised).toMatchObject({ ok: true, value: { status: 'ready', attempt: 2 } });
        expect(inheritedFeedback).toContain(
          'decision.segments.0: Invalid option: expected one of "dependency_await"|"translations"',
        );
        expect(
          inheritedFeedback.filter((issue) => issue.includes('decision.segments.0')),
        ).toHaveLength(1);
        expect(inheritedDecision).toBeNull();
      },
    );
  });

  it('returns missing acceptance-verification steps to the planner as candidate feedback', async () => {
    await withPlanningFixture(
      'tasker-plan-acceptance-link-loop-',
      async ({ directory, clock, ledger }) => {
        const fallback = makeTestImplementationPlanner();
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
          PLANNING_EPISODE_ID,
          fixture.snapshot,
          fixture.evidence,
        );

        expect(result).toMatchObject({
          ok: true,
          value: { status: 'ready', validationRevision: 1 },
        });
        expect(feedback).toContain(
          'Acceptance criterion reported-behavior-fixed references missing workflow step missing-verification-step.',
        );
        expect(calls).toBe(2);
      },
    );
  });
});
