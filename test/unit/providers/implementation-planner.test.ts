import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SubscriptionCliImplementationPlanner,
  type CommandRequest,
  type CommandResult,
  type WorkspaceCommandRunner,
} from '../../../src/providers/index.js';
import { getHarnessPack } from '../../../src/harness/index.js';
import { analyzeTaskFixture, findTaskFixture } from '../../../src/planning/index.js';
import { WorkflowSourceSchema, type WorkflowNodeSource } from '../../../src/workflow/index.js';
import { makeEvidenceBundle } from '../../helpers/evidence.js';
import { TEST_CLAUDE_PROFILE, TEST_CODEX_PROFILE } from '../../helpers/execution-profile.js';

const task = findTaskFixture('avia-13236-short-bug');
if (task === undefined) throw new Error('Missing planner test fixture');
const proposal = analyzeTaskFixture(task);
if (!proposal.ok) throw new Error('Invalid planner test fixture');
const workflowSource = WorkflowSourceSchema.parse(proposal.value.source);
const workflowStepIds: string[] = [];
const collectWorkflowStepIds = (node: WorkflowNodeSource): void => {
  switch (node.kind) {
    case 'step':
      workflowStepIds.push(node.id);
      return;
    case 'sequence':
      node.children.forEach(collectWorkflowStepIds);
      return;
    case 'branch':
      collectWorkflowStepIds(node.then);
      collectWorkflowStepIds(node.otherwise);
      return;
    case 'bounded_loop':
      collectWorkflowStepIds(node.body);
      return;
    case 'wait':
    case 'gate':
    case 'finalize':
      return;
  }
};
collectWorkflowStepIds(workflowSource.root);
const verificationStepId = workflowStepIds[0];
if (verificationStepId === undefined) throw new Error('Planner fixture has no workflow step');

const readyDecision = {
  status: 'ready',
  plan: {
    schemaVersion: 2,
    title: 'Repair the seat marker',
    summary: 'Ground the affected component, make the bounded repair, and verify it.',
    steps: [
      {
        id: 'repair-seat-marker',
        title: 'Repair the seat marker',
        objective: 'Keep the marker color consistent with the seat state.',
        repository: 'onetwotrip/front-avia',
        files: ['src/features/additionalServices/selectSeats'],
        verification: ['Run the targeted seat selection checks.'],
      },
    ],
    assumptions: [],
    risks: [],
    acceptanceCriteria: [
      {
        id: 'marker-color',
        expected: 'The marker uses the expected color.',
        verification: [
          {
            kind: 'automated_test',
            source: 'existing',
            level: 'integration',
            scenario: 'Run the targeted seat selection checks.',
            workflowStepIds: [verificationStepId],
          },
        ],
      },
    ],
  },
  followUps: [],
  workflow: {
    assemblyDecisions: proposal.value.assemblyDecisions,
    source: workflowSource,
    verificationPlan: proposal.value.verificationPlan,
  },
} as const;

const codexJsonl = (finalMessage: string): string =>
  [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-planner-1' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item-1', type: 'agent_message', text: finalMessage },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 1500,
        cached_input_tokens: 900,
        output_tokens: 300,
        reasoning_output_tokens: 50,
      },
    }),
  ].join('\n');

const claudeJsonl = (finalMessage: unknown): string =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    structured_output: finalMessage,
    session_id: 'claude-planner-1',
    usage: {
      input_tokens: 1200,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 400,
      output_tokens: 250,
    },
    total_cost_usd: 0.42,
  });

class RecordingRunner implements WorkspaceCommandRunner {
  public readonly executionEnvironment = 'docker_workspace' as const;
  public readonly requests: CommandRequest[] = [];
  public schema: string | null = null;
  public materializedJiraSkill: string | null = null;
  public materializedJiraHelper = false;

  public constructor(private readonly finalMessage: string) {}

  public run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    if (request.args[0] === '--version') {
      return Promise.resolve({
        status: 'exited',
        exitCode: 0,
        stdout: 'codex-cli 0.120.0\n',
        stderr: '',
        durationMs: 5,
      });
    }
    const schemaIndex = request.args.indexOf('--output-schema');
    const schemaPath = schemaIndex < 0 ? undefined : request.args[schemaIndex + 1];
    this.schema = schemaPath === undefined ? null : readFileSync(schemaPath, 'utf8');
    const skillsRoot = request.env?.TASKER_SKILLS_ROOT;
    if (skillsRoot !== undefined) {
      try {
        this.materializedJiraSkill = readFileSync(join(skillsRoot, 'jira', 'SKILL.md'), 'utf8');
      } catch {
        this.materializedJiraSkill = null;
      }
      this.materializedJiraHelper = existsSync(join(skillsRoot, 'jira-helper'));
    }
    return Promise.resolve({
      status: 'exited',
      exitCode: 0,
      stdout: codexJsonl(this.finalMessage),
      stderr: '',
      durationMs: 1750,
    });
  }
}

class ClaudeRecordingRunner implements WorkspaceCommandRunner {
  public readonly executionEnvironment = 'docker_workspace' as const;
  public readonly requests: CommandRequest[] = [];

  public run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    if (request.args[0] === '--version') {
      return Promise.resolve({
        status: 'exited',
        exitCode: 0,
        stdout: '2.1.224 (Claude Code)\n',
        stderr: '',
        durationMs: 4,
      });
    }
    return Promise.resolve({
      status: 'exited',
      exitCode: 0,
      stdout: claudeJsonl({
        decisionJson: JSON.stringify(readyDecision),
        evidenceRequestsJson: '[]',
      }),
      stderr: '',
      durationMs: 1400,
    });
  }
}

const request = (strategy: 'fast' | 'ralplan') => ({
  operationId: 'tasker:test:planning:1',
  repositoryPath: process.cwd(),
  strategy,
  profile: {
    ...TEST_CODEX_PROFILE,
    name: strategy === 'ralplan' ? 'test-ralplan' : 'test-fast',
    effort: strategy === 'ralplan' ? ('high' as const) : ('low' as const),
  },
  skills: [],
  mediatedSkills: [],
  mediatedCredentialEnvironment: [],
  promptTemplate: '{{strategyInstruction}}\n{{plannerContext}}\n{{repositoryEvidence}}',
  context: {
    task,
    taskSnapshot: { taskId: 'AVIA-13235', summary: 'Repair seat marker color' },
    blocks: getHarnessPack().steps.map(({ block }) => block),
    evidenceBundle: makeEvidenceBundle(),
    repositoryReference: 'onetwotrip/front-avia',
    operatorGuidance: null,
    validationFeedback: [],
    previousDecision: null,
  },
});

describe('Codex CLI implementation planner', () => {
  it('uses a bounded low-reasoning subscription pass for fast planning', async () => {
    const runner = new RecordingRunner(
      JSON.stringify({ decisionJson: JSON.stringify(readyDecision), evidenceRequestsJson: '[]' }),
    );
    const planner = new SubscriptionCliImplementationPlanner(runner);

    const result = await planner.plan(request('fast'));

    expect(result).toMatchObject({
      ok: true,
      value: {
        decision: readyDecision,
        receipt: {
          provider: 'codex_cli',
          strategy: 'fast',
          sessionId: 'thread-planner-1',
          durationMs: 1750,
          usage: { inputTokens: 1500, outputTokens: 300 },
        },
      },
    });
    expect(runner.requests[1]?.args).toEqual(
      expect.arrayContaining([
        '--dangerously-bypass-approvals-and-sandbox',
        '-c',
        'model_reasoning_effort="low"',
      ]),
    );
    expect(runner.requests[1]?.workspaceAccess).toBe('read_only');
    expect(runner.requests[1]?.stdin).toContain('Use one bounded planning pass');
    expect(runner.requests[1]?.stdin).not.toContain('Invoke $ralplan');
    expect(runner.schema).toContain('decisionJson');
    expect(JSON.parse(runner.schema ?? '{}')).toMatchObject({
      required: ['decisionJson', 'evidenceRequestsJson'],
    });
  });

  it('projects the planning block skills into the read-only provider session', async () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), 'tasker-planner-skills-'));
    const skillPath = join(repositoryPath, '.tasker', 'harness', 'skills', 'jira');
    mkdirSync(skillPath, { recursive: true });
    writeFileSync(
      join(skillPath, 'SKILL.md'),
      '---\nname: jira\ndescription: Read Jira evidence.\n---\n',
      'utf8',
    );
    writeFileSync(join(skillPath, 'dependencies.json'), '["jira-helper"]\n', 'utf8');
    const helperPath = join(repositoryPath, '.tasker', 'harness', 'skills', 'jira-helper');
    mkdirSync(helperPath, { recursive: true });
    writeFileSync(
      join(helperPath, 'SKILL.md'),
      '---\nname: jira-helper\ndescription: Direct Jira helper.\n---\n',
      'utf8',
    );
    const runner = new RecordingRunner(
      JSON.stringify({ decisionJson: JSON.stringify(readyDecision), evidenceRequestsJson: '[]' }),
    );
    const planner = new SubscriptionCliImplementationPlanner(runner);

    try {
      const result = await planner.plan({
        ...request('fast'),
        repositoryPath,
        skills: ['jira'],
        mediatedSkills: ['jira'],
        mediatedCredentialEnvironment: ['JIRA_TOKEN'],
      });

      expect(result.ok).toBe(true);
      expect(runner.requests[1]).toMatchObject({ cwd: repositoryPath });
      expect(runner.requests[1]?.args).toEqual(
        expect.arrayContaining([
          '--dangerously-bypass-approvals-and-sandbox',
          '--cd',
          repositoryPath,
        ]),
      );
      expect(runner.requests[1]?.stdin).toContain('Selected read-only skills: jira');
      expect(runner.requests[1]?.env?.TASKER_SKILLS_ROOT).toMatch(/\/skills$/u);
      expect(runner.requests[1]?.env?.TASKER_HARNESS_ENV_FILE).toBe('/dev/null');
      expect(runner.requests[1]?.unsetEnv).toEqual(['JIRA_TOKEN']);
      expect(runner.materializedJiraSkill).toContain('Request read-only jira evidence');
      expect(runner.materializedJiraSkill).not.toContain('Read Jira evidence.');
      expect(runner.materializedJiraHelper).toBe(false);
    } finally {
      rmSync(repositoryPath, { recursive: true, force: true });
    }
  });

  it('returns a typed mediated evidence request without a provisional decision', async () => {
    const evidenceRequests = [
      {
        requestId: 'linked-issue',
        skill: 'jira',
        locator: 'AVIA-12045',
        purpose: 'Confirm the related bug acceptance criteria.',
      },
    ];
    const runner = new RecordingRunner(
      JSON.stringify({
        decisionJson: null,
        evidenceRequestsJson: JSON.stringify(evidenceRequests),
      }),
    );
    const planner = new SubscriptionCliImplementationPlanner(runner);

    const result = await planner.plan(request('fast'));

    expect(result).toMatchObject({
      ok: true,
      value: { decision: null, evidenceRequests },
    });
  });

  it('routes an explicit ralplan request through the consensus prompt with high reasoning', async () => {
    const runner = new RecordingRunner(
      JSON.stringify({ decisionJson: JSON.stringify(readyDecision), evidenceRequestsJson: '[]' }),
    );
    const planner = new SubscriptionCliImplementationPlanner(runner);

    const result = await planner.plan(request('ralplan'));

    expect(result).toMatchObject({ ok: true, value: { receipt: { strategy: 'ralplan' } } });
    expect(runner.requests[1]?.args).toEqual(
      expect.arrayContaining(['-c', 'model_reasoning_effort="high"']),
    );
    expect(runner.requests[1]?.stdin).toContain('Invoke $ralplan non-interactively');
    expect(runner.requests[1]?.stdin).toContain('Planner -> Architect -> Critic');
  });

  it('runs the same planning contract through a selected Claude subscription profile', async () => {
    const runner = new ClaudeRecordingRunner();
    const planner = new SubscriptionCliImplementationPlanner(runner);

    const result = await planner.plan({
      ...request('ralplan'),
      profile: TEST_CLAUDE_PROFILE,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        decision: readyDecision,
        receipt: {
          provider: 'claude_cli',
          profile: 'test-claude',
          model: 'sonnet',
          effort: 'high',
          strategy: 'ralplan',
          sessionId: 'claude-planner-1',
          usage: { inputTokens: 1200, cachedInputTokens: 500, outputTokens: 250 },
          hypotheticalApiCostUsd: 0.42,
        },
      },
    });
    expect(runner.requests[1]?.args).toEqual(
      expect.arrayContaining([
        '--print',
        '--model',
        'sonnet',
        '--effort',
        'high',
        '--output-format',
        'stream-json',
        '--json-schema',
      ]),
    );
    expect(runner.requests[1]?.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(runner.requests[1]?.env?.HOME).toMatch(/provider-home$/u);
    expect(runner.requests[1]?.env?.CODEX_HOME).toBeUndefined();
  });

  it('rejects a decision outside the typed planner contract', async () => {
    const runner = new RecordingRunner(
      JSON.stringify({
        decisionJson: JSON.stringify({ status: 'ready', plan: {} }),
        evidenceRequestsJson: '[]',
      }),
    );
    const planner = new SubscriptionCliImplementationPlanner(runner);

    const result = await planner.plan(request('fast'));

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_planner_output' } });
  });

  it('returns typed blocking questions without inventing an implementation plan', async () => {
    const decision = {
      status: 'needs_clarification',
      questions: [
        {
          id: 'target-browser',
          question: 'Which browser must the reproduction cover?',
          reason: 'The evidence requirement changes with this choice.',
        },
      ],
    } as const;
    const runner = new RecordingRunner(
      JSON.stringify({ decisionJson: JSON.stringify(decision), evidenceRequestsJson: '[]' }),
    );
    const planner = new SubscriptionCliImplementationPlanner(runner);

    const result = await planner.plan(request('fast'));

    expect(result).toMatchObject({ ok: true, value: { decision } });
  });
});
