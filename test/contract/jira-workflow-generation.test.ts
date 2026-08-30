import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BootstrapContextAssembler,
  ContextDiscoveryService,
  createImplementationPlanningCoordinator,
  createOperatorWorkflowService,
  EvidenceBundleStore,
  ImplementationPlanningStore,
  PersistedGenerationSubjectRunStore,
} from '../../src/control-plane/index.js';
import type { JiraIssuePort } from '../../src/integrations/index.js';
import {
  createJiraIssueService,
  JiraWorkflowGenerationSubjectResolver,
} from '../../src/integrations/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { WorkflowGenerationSubjectSource } from '../../src/planning/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { ok } from '../../src/shared/outcome.js';
import { SemanticWorkflowSourceSchema, type SemanticNodeSource } from '../../src/workflow/index.js';
import { makeJiraSnapshot } from '../helpers/jira.js';
import { makeRepositoryCatalog } from '../helpers/repositories.js';
import { makeReadyPlanningDecision, makeTestImplementationPlanner } from '../support/planning.js';

const resources: { readonly directory: string; readonly ledger: SqliteLedger }[] = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.ledger.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

const collectStepIds = (node: SemanticNodeSource): readonly string[] => {
  switch (node.kind) {
    case 'step':
      return [node.id];
    case 'sequence':
      return node.children.flatMap(collectStepIds);
    case 'bounded_loop':
      return collectStepIds(node.body);
  }
};

describe('Jira bootstrap context assembly', () => {
  it('persists task evidence and an immutable planning context without creating a workflow graph', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-jira-context-'));
    const clock = makeAdjustableClock('2026-08-02T00:00:00.000Z');
    const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
    resources.push({ directory, ledger });
    const jiraPort: JiraIssuePort = {
      fetchIssue: vi.fn(() => Promise.resolve(ok(makeJiraSnapshot()))),
      fetchAttachment: vi.fn(),
    };
    const jiraService = createJiraIssueService(ledger.repository, clock, jiraPort, {
      repositoryCatalog: makeRepositoryCatalog(),
    });
    const synced = await jiraService.sync('AVIA-13235', 'front-avia');
    expect(synced.ok).toBe(true);

    const workspacePath = join(directory, 'managed-worktree');
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(join(workspacePath, 'README.md'), '# Managed task worktree\n', 'utf8');

    const taskReference = 'jira:AVIA-13235';
    const workflows = createOperatorWorkflowService(ledger.repository, clock);
    const subjects = new WorkflowGenerationSubjectSource(
      [new JiraWorkflowGenerationSubjectResolver(jiraService)],
      new PersistedGenerationSubjectRunStore(workflows),
    );
    const evidenceBundles = new EvidenceBundleStore(ledger.repository, clock);
    const planning = createImplementationPlanningCoordinator({
      ledger: ledger.repository,
      clock,
      workflows,
      subjects,
      evidenceBundles,
      planner: makeTestImplementationPlanner(),
    });
    const assembler = new BootstrapContextAssembler(
      subjects,
      new ContextDiscoveryService(evidenceBundles, clock),
      planning,
    );

    const assembled = await assembler.assemble({
      taskReference,
      workflowRunId: 'run-1',
      operationId: 'bootstrap:context:1',
      workspace: {
        workspaceId: 'a'.repeat(24),
        repositoryReference: 'onetwotrip/front-avia',
        revision: 'b'.repeat(40),
        path: workspacePath,
      },
    });

    expect(assembled.ok).toBe(true);
    if (!assembled.ok) throw new Error(`Expected planning context: ${assembled.error.kind}`);
    expect(workflows.readPlanningOperation(taskReference, 'bootstrap:context:1')).toEqual(ok(null));
    expect(workflows.listStreamEventsAfter(0)).toEqual([]);

    const snapshot = new ImplementationPlanningStore(ledger.repository, clock).readRunSnapshot(
      assembled.value.planningSnapshot,
    );
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error(`Expected planning snapshot: ${snapshot.error.kind}`);
    expect(snapshot.value).toMatchObject({
      schemaVersion: 10,
      kind: 'planning_context',
      taskReference,
      repository: { path: workspacePath, reference: 'onetwotrip/front-avia' },
    });
    expect('workflow' in snapshot.value).toBe(false);
    expect(
      snapshot.value.harness.steps.find(({ reference }) => reference === 'runtime.observe@1')?.block
        .availableDuring,
    ).toEqual(['bootstrap_investigation']);

    const decision = makeReadyPlanningDecision();
    if (decision.status !== 'ready') throw new Error('Expected ready planning decision fixture');
    expect(decision).toMatchObject({
      status: 'ready',
      executionStrategy: 'simple',
      archetype: 'deliver-pr',
      segments: [],
      verification: {
        profile: 'targeted',
        checks: ['reproduction evidence', 'targeted tests for changed behavior'],
      },
    });
    expect('workflow' in decision).toBe(false);
    expect('followUps' in decision).toBe(false);
    expect('graph' in decision).toBe(false);
    expect('topology' in decision).toBe(false);
    expect(decision.plan.acceptanceCriteria[0]?.verification[0]?.workflowStepIds).toEqual([
      'verify-change',
    ]);

    const planned = await planning.prepare(
      taskReference,
      'fast',
      'tasker:v3:jira:AVIA-13235:run-1:planning',
      'tasker:v3:jira:AVIA-13235:run-1:planning-episode',
      assembled.value.planningSnapshot,
      assembled.value.evidenceBundle,
    );
    expect(planned).toMatchObject({ ok: true, value: { status: 'ready' } });
    if (!planned.ok || planned.value.status !== 'ready') {
      throw new Error('Expected ready implementation plan');
    }

    const plannedWorkflow = workflows.readPlanningOperation(
      taskReference,
      planned.value.workflowOperationId,
    );
    if (!plannedWorkflow.ok || plannedWorkflow.value?.status !== 'ready') {
      throw new Error('Expected stored planning workflow');
    }
    expect(plannedWorkflow.value.view.workflow.graphHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(plannedWorkflow.value.view.workflow.semanticHash).toMatch(/^[a-f0-9]{64}$/u);
    const semanticSource = SemanticWorkflowSourceSchema.parse(
      plannedWorkflow.value.view.workflow.semanticSource,
    );
    expect(collectStepIds(semanticSource.root)).toContain('verify-change');

    const evidence = evidenceBundles.readMaterialized(assembled.value.evidenceBundle);
    expect(evidence.ok).toBe(true);
    if (!evidence.ok) throw new Error(`Expected evidence bundle: ${evidence.error.kind}`);
    expect(evidence.value.bundle.entries.map(({ evidenceType }) => evidenceType)).toEqual(
      expect.arrayContaining(['task_snapshot', 'harness_context', 'repository_inventory']),
    );
    const taskSnapshot = evidence.value.bundle.entries.find(
      ({ evidenceType }) => evidenceType === 'task_snapshot',
    );
    const persistedTaskSnapshot = JSON.stringify(taskSnapshot?.content);
    expect(persistedTaskSnapshot).toContain('"origin":"jira"');
    expect(persistedTaskSnapshot).toContain('"issueKey":"AVIA-13235"');
    expect(persistedTaskSnapshot).toContain('"filename":"seatmap-legspace-arrow.mp4"');
    expect(persistedTaskSnapshot).toContain('"id":"1094745"');
  });
});
