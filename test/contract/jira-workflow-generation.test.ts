import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  CodexWorkflowGenerator,
  createM1WorkflowService,
  WorkflowGenerationSubjectSource,
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
import { makeJiraSnapshot } from '../helpers/jira.js';
import { makeRepositoryCatalog } from '../helpers/repositories.js';

const resources: { readonly directory: string; readonly ledger: SqliteLedger }[] = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.ledger.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe('Jira workflow generation', () => {
  it('gives the analyzer the complete Jira snapshot and managed checkout before persisting its graph', async () => {
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
    const requests: Parameters<WorkflowAnalyzer['analyze']>[0][] = [];
    const analyzer: WorkflowAnalyzer = {
      analyze: (request) => {
        requests.push(request);
        return Promise.resolve(
          ok({
            output: WorkflowAnalyzerOutputSchema.parse({
              assemblyDecisions: proposal.value.assemblyDecisions,
              source: proposal.value.source,
              verificationPlan: proposal.value.verificationPlan,
            }),
            receipt: WorkflowAnalyzerReceiptSchema.parse({
              status: 'completed',
              provider: 'codex_cli',
              analyzerVersion: 'codex-cli@1',
              cliVersion: 'codex-cli test',
              model: 'gpt-5.4',
              serviceTier: 'fast',
              sessionId: 'jira-workflow-session',
              promptHash: 'a'.repeat(64),
              durationMs: 1234,
              usage: {
                inputTokens: 1000,
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
    const generator = new CodexWorkflowGenerator(
      service,
      new WorkflowGenerationSubjectSource(directory, jiraService),
      analyzer,
    );

    const generated = await generator.generate('jira:AVIA-13235');

    expect(generated).toMatchObject({
      ok: true,
      value: {
        status: 'ready',
        view: { fixture: { id: 'jira:AVIA-13235' }, workflow: { status: 'valid' } },
      },
    });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (request === undefined) throw new Error('Expected one analyzer request');
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
    expect(request.repositoryPath).toBe('/work/front-avia');
    expect(evidence.origin).toBe('jira');
    expect(evidence.issue.issueKey).toBe('AVIA-13235');
    expect(evidence.issue.attachments.map((attachment) => attachment.filename)).toContain(
      'seatmap-legspace-arrow.mp4',
    );
    expect(evidence.issue.comments.map((comment) => comment.id)).toContain('1094745');
    expect(evidence.repository.reference).toBe('onetwotrip/front-avia');
    const planner = z
      .object({
        contracts: z.object({
          steps: z.array(
            z.object({
              reference: z.string(),
              inputSchema: z.object({ required: z.array(z.string()) }).loose(),
            }),
          ),
        }),
      })
      .parse(request.plannerContext);
    expect(
      planner.contracts.steps.find((contract) => contract.reference === 'verify.visual@1')
        ?.inputSchema.required,
    ).toEqual(['profile', 'taskId']);
    expect(
      ledger.repository.listEvents('workflow:jira:AVIA-13235').map((event) => event.eventType),
    ).toEqual(['WorkflowAnalyzed', 'WorkflowPlanned']);
    expect(
      ledger.repository.listEvents('intake:jira:AVIA-13235').map((event) => event.eventType),
    ).toEqual(['JiraIntakeRequested', 'JiraRepositoryBound']);
  });
});
