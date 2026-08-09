import { describe, expect, it } from 'vitest';

import {
  createImplementationPlanningCoordinator,
  createM1WorkflowService,
  WorkflowDraftRevisionCoordinator,
  WorkflowGenerationSubjectSource,
  type WorkflowAnalyzer,
  type WorkflowContextDiscovery,
} from '../../src/control-plane/index.js';
import { openSqliteLedger } from '../../src/ledger/index.js';
import {
  analyzeTaskFixture,
  findTaskFixture,
  WorkflowAnalyzerOutputSchema,
} from '../../src/planning/index.js';
import {
  DeterministicImplementationPlanner,
  WorkflowAnalyzerReceiptSchema,
} from '../../src/providers/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { ok } from '../../src/shared/outcome.js';
import { WorkflowSourceSchema } from '../../src/workflow/index.js';
import { makeEvidenceBundle, recordTestEvidenceBundle } from '../helpers/evidence.js';
import { makeRepositoryCatalog } from '../helpers/repositories.js';

describe('workflow draft revision', () => {
  it('returns the persisted revision when Temporal redelivers the same operation', async () => {
    const taskReference = 'avia-12536-feature-review';
    const operationId = `tasker:${taskReference}:draft-revision:1`;
    const fixture = findTaskFixture(taskReference);
    if (fixture === undefined) throw new Error('Missing feature fixture');
    const proposal = analyzeTaskFixture(fixture);
    if (!proposal.ok) throw new Error('Expected valid shared-component proposal');
    const source = WorkflowSourceSchema.parse(proposal.value.source);
    if (source.root.kind !== 'sequence') throw new Error('Expected sequence workflow source');
    const revisedSource = WorkflowSourceSchema.parse({
      ...source,
      root: {
        ...source.root,
        children: source.root.children.map((node) =>
          node.kind === 'bounded_loop' && node.body.kind === 'sequence'
            ? {
                ...node,
                body: {
                  ...node.body,
                  children: node.body.children.map((child) =>
                    child.kind === 'step' && child.uses === 'code.implement@1'
                      ? {
                          ...child,
                          with: {
                            objective: 'Implement the planner-confirmed shared component change.',
                            repository: 'twiket/ui-kit',
                            taskId: fixture.taskId,
                          },
                        }
                      : child,
                  ),
                },
              }
            : node,
        ),
      },
    });
    const clock = makeAdjustableClock('2026-08-05T00:00:00.000Z');
    const ledger = openSqliteLedger({ filename: ':memory:', clock });
    try {
      const workflows = createM1WorkflowService(ledger.repository, clock);
      const initial = workflows.generateTask(fixture);
      if (!initial.ok || initial.value.status !== 'ready') {
        throw new Error('Expected initial workflow draft');
      }
      recordTestEvidenceBundle(ledger.repository, clock, taskReference);
      let analyzerCalls = 0;
      const analyzer: WorkflowAnalyzer = {
        analyze: () => {
          analyzerCalls += 1;
          return Promise.resolve(
            ok({
              output: WorkflowAnalyzerOutputSchema.parse({
                assemblyDecisions: proposal.value.assemblyDecisions,
                source: revisedSource,
                verificationPlan: proposal.value.verificationPlan,
              }),
              receipt: WorkflowAnalyzerReceiptSchema.parse({
                status: 'completed',
                provider: 'codex_cli',
                analyzerVersion: 'workflow-analyzer@2',
                profile: 'test-analyzer',
                profileSha256: 'b'.repeat(64),
                cliVersion: 'codex-cli test',
                model: 'gpt-5.6-terra',
                effort: 'medium',
                serviceTier: 'fast',
                sessionId: `draft-revision-${String(analyzerCalls)}`,
                promptHash: 'a'.repeat(64),
                durationMs: 100,
                usage: {
                  inputTokens: 100,
                  cachedInputTokens: 0,
                  outputTokens: 20,
                  reasoningOutputTokens: 5,
                },
                hypotheticalApiCostUsd: null,
              }),
              stderr: '',
            }),
          );
        },
      };
      const discoveries: string[] = [];
      const contextDiscovery: WorkflowContextDiscovery = {
        discover: (input) => {
          discoveries.push(input.repositoryReference);
          return Promise.resolve(ok({ bundle: makeEvidenceBundle(taskReference) }));
        },
      };
      const coordinator = new WorkflowDraftRevisionCoordinator(
        workflows,
        new WorkflowGenerationSubjectSource('/fixture-repository'),
        analyzer,
        contextDiscovery,
        makeRepositoryCatalog(),
      );
      const request = {
        reason: 'Planning confirmed work in the shared component repository.',
        discoveredRepositories: ['twiket/ui-kit'],
        requiredCapabilities: ['workspace.write'],
        evidence: ['planner:shared-component-boundary'],
      };

      const first = await coordinator.revise({
        taskReference,
        expectedWorkflowHash: initial.value.view.workflow.graphHash ?? '',
        request,
        operationId,
      });
      const redelivered = await coordinator.revise({
        taskReference,
        expectedWorkflowHash: initial.value.view.workflow.graphHash ?? '',
        request,
        operationId,
      });

      expect(first).toMatchObject({ ok: true });
      expect(redelivered).toEqual(first);
      if (!first.ok) throw new Error('Expected revised workflow draft');
      expect(first.value.workflowHash).not.toBe(initial.value.view.workflow.graphHash);
      expect(analyzerCalls).toBe(1);
      expect(discoveries).toEqual(['onetwotrip/front-avia', 'twiket/ui-kit']);
      expect(workflows.readPlanningOperation(taskReference, operationId)).toMatchObject({
        ok: true,
        value: { status: 'ready' },
      });
      expect(
        ledger.repository
          .listEvents(`intake:${taskReference}`)
          .filter((event) => event.eventType === 'WorkflowPlanned'),
      ).toHaveLength(2);
      expect(ledger.repository.readArtifact(`graph:${taskReference}:attempt-2`)).not.toBeNull();

      const subjects = new WorkflowGenerationSubjectSource('/fixture-repository');
      const planning = createImplementationPlanningCoordinator({
        ledger: ledger.repository,
        clock,
        workflows,
        subjects,
        planner: new DeterministicImplementationPlanner(),
      });
      const snapshot = planning.createRunSnapshot(taskReference, first.value.workflowHash, {
        workspaceId: '0'.repeat(24),
        reference: fixture.repository,
        path: '/fixture-worktree',
      });
      if (!snapshot.ok) throw new Error(`Planning snapshot failed: ${snapshot.error.kind}`);
      const replanned = await planning.prepare(
        taskReference,
        'fast',
        'Verify the recompiled draft.',
        `tasker:${taskReference}:planning:2`,
        first.value.workflowHash,
        snapshot.value,
      );
      expect(replanned).toMatchObject({
        ok: true,
        value: {
          status: 'ready',
          planningSnapshot: snapshot.value,
        },
      });
    } finally {
      ledger.close();
    }
  });
});
