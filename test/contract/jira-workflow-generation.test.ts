import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  ContextDiscoveryService,
  createM1WorkflowService,
  EvidenceBundleStore,
  WorkflowGenerationSubjectSource,
  WorkflowDraftAssembler,
  type WorkflowAnalyzer,
} from '../../src/control-plane/index.js';
import type { JiraIssuePort } from '../../src/integrations/index.js';
import { createJiraIssueService } from '../../src/integrations/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import {
  analyzeTaskFixture,
  TaskFixtureSchema,
  WorkflowAnalyzerOutputSchema,
} from '../../src/planning/index.js';
import { WorkflowAnalyzerReceiptSchema } from '../../src/providers/index.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { ok } from '../../src/shared/outcome.js';
import { WorkflowSourceSchema } from '../../src/workflow/index.js';
import { makeJiraSnapshot } from '../helpers/jira.js';
import { makeRepositoryCatalog } from '../helpers/repositories.js';

const resources: { readonly directory: string; readonly ledger: SqliteLedger }[] = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.ledger.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe('Jira workflow draft assembly', () => {
  it('analyzes the managed worktree inside durable bootstrap before persisting its graph', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-jira-workflow-'));
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

    const task = TaskFixtureSchema.parse({
      origin: 'jira',
      fixtureId: 'jira:AVIA-13235',
      taskId: 'AVIA-13235',
      title: 'Seat map uses the wrong color for the leg-space arrow',
      description:
        'h3. Environment\nWeb and mobile\n\nh3. Steps\n# Open seat selection\n# Find an exit-row seat\n\nh3. Expected result\nThe arrow matches the seat back.',
      repository: 'onetwotrip/front-avia',
      translationIntent: 'none',
      family: 'short_bugfix',
      reproduction: 'required',
      verification: 'targeted',
      expected: 'accepted',
      proposalVariant: 'valid',
    });
    const proposal = analyzeTaskFixture(task);
    if (!proposal.ok) throw new Error('Expected a valid analyzer fixture');
    const validSource = WorkflowSourceSchema.parse(proposal.value.source);
    if (validSource.root.kind !== 'sequence') {
      throw new Error('Expected a sequence workflow');
    }
    expect(validSource.root.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'step', uses: 'jira.start-work@1' }),
        expect.objectContaining({ kind: 'step', uses: 'jira.review-ready@1' }),
      ]),
    );
    const invalidSource = WorkflowSourceSchema.parse({
      ...validSource,
      root: {
        ...validSource.root,
        children: validSource.root.children.map((node) =>
          node.kind === 'bounded_loop' && node.body.kind === 'sequence'
            ? {
                ...node,
                body: {
                  ...node.body,
                  children: node.body.children.map((child) =>
                    child.kind === 'step' && child.id === 'verify-targeted'
                      ? { ...child, with: { taskId: 'AVIA-13235' } }
                      : child,
                  ),
                },
              }
            : node,
        ),
      },
    });
    const requests: Parameters<WorkflowAnalyzer['analyze']>[0][] = [];
    const analyzer: WorkflowAnalyzer = {
      analyze: (request) => {
        requests.push(request);
        const attempt = requests.length;
        return Promise.resolve(
          ok({
            output: WorkflowAnalyzerOutputSchema.parse({
              assemblyDecisions: proposal.value.assemblyDecisions,
              source: attempt === 1 ? invalidSource : validSource,
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
              sessionId: `jira-workflow-session-${String(attempt)}`,
              promptHash: String(attempt).repeat(64),
              durationMs: 1234,
              usage: {
                inputTokens: attempt * 1000,
                cachedInputTokens: 500,
                outputTokens: 200,
                reasoningOutputTokens: 50,
              },
              hypotheticalApiCostUsd: null,
            }),
            stderr: '',
          }),
        );
      },
    };
    const service = createM1WorkflowService(ledger.repository, clock);
    const workspacePath = join(directory, 'managed-worktree');
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(join(workspacePath, 'README.md'), '# Managed task worktree\n', 'utf8');
    const generator = new WorkflowDraftAssembler(
      service,
      new WorkflowGenerationSubjectSource(directory, jiraService),
      analyzer,
      new ContextDiscoveryService(new EvidenceBundleStore(ledger.repository, clock), clock),
      new EvidenceBundleStore(ledger.repository, clock),
      {
        createRunSnapshot: (taskReference, workflowHash) =>
          ok({
            artifactId: `planning-snapshot:${taskReference}:${workflowHash}`,
            checksum: 'f'.repeat(64),
          }),
      },
    );

    const workspace = {
      schemaVersion: 1 as const,
      workspaceId: 'a'.repeat(24),
      taskReference: 'jira:AVIA-13235',
      workflowId: 'tasker:v3:jira:AVIA-13235',
      workflowRunId: 'run-1',
      repository: {
        reference: 'onetwotrip/front-avia',
        sourcePath: '/managed/repositories/front-avia',
        baseCommit: 'b'.repeat(40),
      },
      runnerId: 'test',
      path: workspacePath,
      branch: 'tasker/avia-13235',
      preparedAt: '2026-08-02T00:00:00.000Z',
    };
    const rejected = await generator.assemble({
      taskReference: 'jira:AVIA-13235',
      operationId: 'draft:1',
      workspace,
    });
    const generated = await generator.assemble({
      taskReference: 'jira:AVIA-13235',
      operationId: 'draft:2',
      workspace,
    });

    expect(rejected).toMatchObject({ ok: false, error: { kind: 'workflow_rejected' } });
    expect(generated.ok).toBe(true);
    if (!generated.ok) throw new Error(`Expected accepted draft: ${generated.error.kind}`);
    expect(generated.value.workflowHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(generated.value.graph.metadata.workflowId).toBeTruthy();
    expect(requests).toHaveLength(2);
    const request = requests[1];
    if (request === undefined) throw new Error('Expected a retry analyzer request');
    const evidence = z
      .object({
        origin: z.literal('jira'),
        issue: z
          .object({
            issueKey: z.string(),
            attachments: z.array(z.object({ filename: z.string() }).loose()),
            comments: z.array(z.object({ id: z.string() }).loose()),
          })
          .loose(),
        repository: z.object({ reference: z.string() }).loose(),
      })
      .loose()
      .parse(request.taskSnapshot);
    expect(request.repositoryPath).toBe(workspacePath);
    expect(evidence.origin).toBe('jira');
    expect(evidence.issue.issueKey).toBe('AVIA-13235');
    expect(evidence.issue.attachments.map((attachment) => attachment.filename)).toContain(
      'seatmap-legspace-arrow.mp4',
    );
    expect(evidence.issue.comments.map((comment) => comment.id)).toContain('1094745');
    expect(evidence.repository.reference).toBe('onetwotrip/front-avia');
    const persistedEvidence = new EvidenceBundleStore(ledger.repository, clock).readLatest(
      'jira:AVIA-13235',
    );
    if (!persistedEvidence.ok || persistedEvidence.value === null) {
      throw new Error('Expected persisted analyzer evidence');
    }
    expect(request.evidenceBundle).toEqual(persistedEvidence.value.bundle);
    const planner = z
      .object({
        buildingBlocks: z.object({
          steps: z.array(
            z.object({
              reference: z.string(),
              inputSchema: z.object({ required: z.array(z.string()) }).loose(),
            }),
          ),
        }),
        obligations: z.array(z.object({ id: z.string() }).loose()),
      })
      .parse(request.plannerContext);
    expect(
      planner.buildingBlocks.steps.find((contract) => contract.reference === 'verify.visual@1')
        ?.inputSchema.required,
    ).toEqual(['profile', 'taskId']);
    expect(planner.obligations.map(({ id }) => id)).toContain('pr-requires-ci-and-review');
    expect(
      ledger.repository.listEvents('workflow:jira:AVIA-13235').map((event) => event.eventType),
    ).toEqual(['WorkflowAnalyzed', 'WorkflowRejected', 'WorkflowAnalyzed', 'WorkflowPlanned']);
    expect(ledger.repository.readArtifact('validator:jira:AVIA-13235')).not.toBeNull();
    expect(ledger.repository.readArtifact('graph:jira:AVIA-13235:attempt-2')).not.toBeNull();
    expect(
      ledger.repository.listEvents('intake:jira:AVIA-13235').map((event) => event.eventType),
    ).toEqual(['JiraIntakeRequested', 'JiraRepositoryBound']);
    const activity = service.readActivity('jira:AVIA-13235');
    expect(activity.ok).toBe(true);
    if (!activity.ok) throw new Error('Expected regenerated workflow activity');
    expect(
      activity.value.entries
        .filter((entry) => entry.title === 'Task and repository analyzed')
        .map((entry) => entry.detail),
    ).toEqual([
      'Codex completed read-only analysis in 1234 ms using 1200 measured tokens.',
      'Codex completed read-only analysis in 1234 ms using 2200 measured tokens.',
    ]);
  });
});
