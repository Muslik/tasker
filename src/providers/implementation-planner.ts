import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { getHarnessPack, renderPromptTemplate } from '../harness/index.js';
import {
  ImplementationPlannerContextSchema,
  ImplementationPlanningDecisionSchema,
  type ImplementationPlannerContext,
  type ImplementationPlanningDecision,
  type PlanningStrategy,
} from '../planning/implementation-plan.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import type { CommandRunner } from './command-runner.js';
import {
  parseCodexStream,
  prepareIsolatedCodexHome,
  providerFailureMessage,
  sha256,
} from './codex-cli-support.js';
import {
  ImplementationPlannerReceiptSchema,
  type ImplementationPlannerReceipt,
} from './contracts.js';

const ImplementationPlannerProviderOutputSchema = z
  .object({
    decisionJson: z.string().min(1),
  })
  .strict();

interface PlanningEvidence {
  readonly files: readonly string[];
  readonly documents: readonly { readonly path: string; readonly content: string }[];
}

const ignoredDirectories = new Set([
  '.git',
  '.tasker',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);
const readableExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.scss',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
const planningStopWords = new Set([
  'about',
  'after',
  'before',
  'change',
  'description',
  'implementation',
  'requested',
  'should',
  'task',
  'workflow',
]);

const extensionOf = (path: string): string => {
  const basename = path.split('/').at(-1) ?? '';
  const dot = basename.lastIndexOf('.');
  return dot < 0 ? '' : basename.slice(dot).toLowerCase();
};

const collectPlanningEvidence = async (
  repositoryPath: string,
  taskSnapshot: unknown,
): Promise<PlanningEvidence> => {
  const files: string[] = [];
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 8 || files.length >= 1_200) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= 1_200) return;
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await visit(join(directory, entry.name), relativePath, depth + 1);
        }
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };
  await visit(repositoryPath, '', 0);

  const snapshotText = JSON.stringify(taskSnapshot).toLowerCase();
  const keywords = [
    ...new Set(
      snapshotText
        .split(/[^\p{L}\p{N}_-]+/gu)
        .filter((token) => token.length >= 4 && !planningStopWords.has(token)),
    ),
  ].slice(0, 80);
  const pathHints = [
    ...snapshotText.matchAll(
      /(?:^|[\s`'"(])(?<path>(?:apps|docs|lib|packages|src|test|tests)\/[\p{L}\p{N}_./-]+)/gu,
    ),
  ]
    .map((match) => match.groups?.path?.replace(/[.,:;)]+$/u, ''))
    .filter((path): path is string => path !== undefined);

  const ranked = files
    .filter((path) => readableExtensions.has(extensionOf(path)))
    .map((path) => {
      const normalized = path.toLowerCase();
      const basename = normalized.split('/').at(-1) ?? normalized;
      const policyScore =
        basename === 'agents.md' ||
        basename === 'readme.md' ||
        basename === 'workflow.md' ||
        basename === 'tasker-workflow.md' ||
        basename === 'package.json'
          ? 40
          : 0;
      const hintScore = pathHints.some(
        (hint) => normalized.startsWith(hint) || hint.startsWith(normalized),
      )
        ? 100
        : 0;
      const keywordScore = keywords.reduce(
        (score, keyword) => score + (normalized.includes(keyword) ? 3 : 0),
        0,
      );
      return { path, score: policyScore + hintScore + keywordScore };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 28);

  const documents: { path: string; content: string }[] = [];
  let remainingBytes = 48_000;
  for (const entry of ranked) {
    if (remainingBytes <= 0) break;
    try {
      const content = await readFile(join(repositoryPath, entry.path), 'utf8');
      const bounded = content.slice(0, Math.min(remainingBytes, 6_000));
      documents.push({ path: entry.path, content: bounded });
      remainingBytes -= Buffer.byteLength(bounded, 'utf8');
    } catch {
      // A concurrently removed or non-text candidate is absent from this immutable evidence bundle.
    }
  }
  return { files: files.slice(0, 600), documents };
};

export interface ImplementationPlannerRequest {
  readonly repositoryPath: string;
  readonly strategy: PlanningStrategy;
  readonly context: ImplementationPlannerContext;
}

export interface ImplementationPlannerSuccess {
  readonly decision: ImplementationPlanningDecision;
  readonly receipt: ImplementationPlannerReceipt;
  readonly stderr: string;
}

export type ImplementationPlannerFailure =
  | { readonly kind: 'provider_unavailable'; readonly message: string }
  | {
      readonly kind: 'provider_timed_out';
      readonly durationMs: number;
      readonly stderr: string;
    }
  | {
      readonly kind: 'provider_failed';
      readonly exitCode: number;
      readonly message: string;
      readonly stderr: string;
    }
  | { readonly kind: 'invalid_event_stream'; readonly message: string }
  | { readonly kind: 'invalid_planner_output'; readonly issues: readonly string[] };

export interface ImplementationPlanner {
  plan(
    request: ImplementationPlannerRequest,
  ): Promise<Outcome<ImplementationPlannerSuccess, ImplementationPlannerFailure>>;
}

const plannerPrompt = (
  request: ImplementationPlannerRequest,
  evidence: PlanningEvidence | null,
): string => {
  const strategyInstruction =
    request.strategy === 'ralplan'
      ? `Invoke $ralplan non-interactively and use its Planner -> Architect -> Critic consensus loop.
This provider boundary is read-only: keep deliberation in memory, do not create .omx files, and
return the final consensus decision through the required JSON schema.`
      : `Use one bounded planning pass and only the immutable repository evidence supplied below.
Do not call tools or shell commands. Do not start a consensus or implementation workflow.`;

  return renderPromptTemplate(getHarnessPack().prompts.implementationPlanner.content, {
    strategyInstruction,
    plannerContext: JSON.stringify(request.context, null, 2),
    repositoryEvidence:
      evidence === null
        ? 'Available through read-only repository tools.'
        : JSON.stringify(evidence, null, 2),
  });
};

const invalidOutput = (issues: readonly string[]): Outcome<never, ImplementationPlannerFailure> =>
  err({ kind: 'invalid_planner_output', issues });

export class CodexCliImplementationPlanner implements ImplementationPlanner {
  public constructor(
    private readonly runner: CommandRunner,
    private readonly options: {
      readonly command?: string;
      readonly model?: string;
      readonly serviceTier?: 'fast' | 'flex';
      readonly fastTimeoutMs?: number;
      readonly ralplanTimeoutMs?: number;
    } = {},
  ) {}

  public async plan(
    requestInput: ImplementationPlannerRequest,
  ): Promise<Outcome<ImplementationPlannerSuccess, ImplementationPlannerFailure>> {
    const request = {
      ...requestInput,
      context: ImplementationPlannerContextSchema.parse(requestInput.context),
    };
    const command = this.options.command ?? 'codex';
    const version = await this.runner.run({
      command,
      args: ['--version'],
      cwd: request.repositoryPath,
      stdin: '',
      timeoutMs: 10_000,
    });
    if (version.status === 'spawn_failed') {
      return err({ kind: 'provider_unavailable', message: version.message });
    }
    if (version.status !== 'exited' || version.exitCode !== 0) {
      return err({ kind: 'provider_unavailable', message: 'Codex CLI version probe failed' });
    }

    const directory = await mkdtemp(join(tmpdir(), 'tasker-implementation-planner-'));
    const schemaPath = join(directory, 'implementation-planner-output.schema.json');
    const isolatedCodexHome = join(directory, 'codex-home');
    const isolatedWorkspace = join(directory, 'workspace');
    const model = this.options.model ?? 'gpt-5.4';
    const serviceTier = this.options.serviceTier ?? 'fast';

    try {
      const evidence =
        request.strategy === 'fast'
          ? await collectPlanningEvidence(request.repositoryPath, request.context.taskSnapshot)
          : null;
      const prompt = plannerPrompt(request, evidence);
      await prepareIsolatedCodexHome(isolatedCodexHome, {
        includePlanningSurfaces: request.strategy === 'ralplan',
      });
      await mkdir(isolatedCodexHome, { recursive: true });
      await mkdir(isolatedWorkspace, { recursive: true });
      await writeFile(
        schemaPath,
        `${JSON.stringify(z.toJSONSchema(ImplementationPlannerProviderOutputSchema), null, 2)}\n`,
        'utf8',
      );
      const execution = await this.runner.run({
        command,
        args: [
          'exec',
          '--model',
          model,
          '-c',
          `service_tier="${serviceTier}"`,
          '-c',
          `model_reasoning_effort="${request.strategy === 'ralplan' ? 'high' : 'low'}"`,
          '--ephemeral',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          '--cd',
          request.strategy === 'fast' ? isolatedWorkspace : request.repositoryPath,
          '--output-schema',
          schemaPath,
          '--json',
          '-',
        ],
        cwd: request.strategy === 'fast' ? isolatedWorkspace : request.repositoryPath,
        env: { CODEX_HOME: isolatedCodexHome },
        stdin: prompt,
        timeoutMs:
          request.strategy === 'ralplan'
            ? (this.options.ralplanTimeoutMs ?? 30 * 60_000)
            : (this.options.fastTimeoutMs ?? 10 * 60_000),
      });

      if (execution.status === 'spawn_failed') {
        return err({ kind: 'provider_unavailable', message: execution.message });
      }
      if (execution.status === 'timed_out') {
        return err({
          kind: 'provider_timed_out',
          durationMs: execution.durationMs,
          stderr: execution.stderr,
        });
      }
      if (execution.exitCode !== 0) {
        return err({
          kind: 'provider_failed',
          exitCode: execution.exitCode,
          message: providerFailureMessage(execution.stdout),
          stderr: execution.stderr,
        });
      }

      const stream = parseCodexStream(execution.stdout);
      if (!stream.ok) return stream;
      let providerOutputInput: unknown;
      try {
        providerOutputInput = JSON.parse(stream.value.finalMessage) as unknown;
      } catch {
        return invalidOutput(['Final agent message was not JSON']);
      }
      const providerOutput =
        ImplementationPlannerProviderOutputSchema.safeParse(providerOutputInput);
      if (!providerOutput.success) {
        return invalidOutput(
          providerOutput.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        );
      }

      let decisionInput: unknown;
      try {
        decisionInput = JSON.parse(providerOutput.data.decisionJson) as unknown;
      } catch {
        return invalidOutput(['decisionJson: expected serialized decision JSON']);
      }
      const decision = ImplementationPlanningDecisionSchema.safeParse(decisionInput);
      if (!decision.success) {
        return invalidOutput(
          decision.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        );
      }

      return ok({
        decision: decision.data,
        stderr: execution.stderr,
        receipt: ImplementationPlannerReceiptSchema.parse({
          status: 'completed',
          provider: 'codex_cli',
          plannerVersion: 'implementation-planner@1',
          cliVersion: version.stdout.trim(),
          model,
          serviceTier,
          strategy: request.strategy,
          sessionId: stream.value.sessionId,
          promptHash: sha256(prompt),
          durationMs: execution.durationMs,
          usage: {
            inputTokens: stream.value.usage.input_tokens,
            cachedInputTokens: stream.value.usage.cached_input_tokens,
            outputTokens: stream.value.usage.output_tokens,
            reasoningOutputTokens: stream.value.usage.reasoning_output_tokens ?? 0,
          },
          hypotheticalApiCostUsd: null,
        }),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export class DeterministicImplementationPlanner implements ImplementationPlanner {
  public plan(
    request: ImplementationPlannerRequest,
  ): Promise<Outcome<ImplementationPlannerSuccess, ImplementationPlannerFailure>> {
    const context = ImplementationPlannerContextSchema.parse(request.context);
    const repository = context.repositoryReference;
    const guidance = context.operatorGuidance;
    const decision = ImplementationPlanningDecisionSchema.parse({
      status: 'ready',
      plan: {
        schemaVersion: 1,
        title:
          guidance === null ? 'Implement the requested task' : 'Revise the implementation plan',
        summary:
          guidance === null
            ? 'Inspect the bounded task surface, make the smallest policy-compliant change, and verify the observable result.'
            : `Apply the operator guidance without discarding prior task evidence: ${guidance}`,
        steps: [
          {
            id: 'ground-current-behavior',
            title: 'Ground the current behavior',
            objective:
              'Confirm the affected code path and preserve the evidence required by the workflow.',
            repository,
            files: ['bounded task-related code search'],
            verification: ['Record the relevant current behavior or reproduction evidence.'],
          },
          {
            id: 'implement-bounded-change',
            title: 'Implement the bounded change',
            objective:
              'Change only the task-related surface and preserve repository workflow policy.',
            repository,
            files: ['files identified by the grounded code search'],
            verification: ['Review the resulting diff against the task acceptance criteria.'],
          },
          {
            id: 'verify-observable-result',
            title: 'Verify the observable result',
            objective: 'Run the verification profile already selected by the compiled workflow.',
            repository,
            files: [],
            verification: [
              'Complete the compiled workflow verification step without unexplained failures.',
            ],
          },
        ],
        assumptions: [
          'The compiled workflow already contains every required repository and effect boundary.',
        ],
        risks: [
          {
            risk: 'Execution may discover a cross-repository dependency not visible during planning.',
            mitigation: 'Return workflow_change_required and preserve the completed prefix.',
          },
        ],
        acceptanceCriteria: [
          'The task-visible behavior matches the requested outcome.',
          'The configured verification profile completes with durable evidence.',
        ],
      },
    });
    const promptHash = sha256(JSON.stringify({ context, strategy: request.strategy }));
    return Promise.resolve(
      ok({
        decision,
        stderr: '',
        receipt: ImplementationPlannerReceiptSchema.parse({
          status: 'completed',
          provider: 'deterministic',
          plannerVersion: 'implementation-planner@1',
          cliVersion: 'deterministic@1',
          model: 'deterministic',
          serviceTier: 'fast',
          strategy: request.strategy,
          sessionId: `deterministic:${promptHash.slice(0, 16)}`,
          promptHash,
          durationMs: 0,
          usage: {
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          hypotheticalApiCostUsd: 0,
        }),
      }),
    );
  }
}
