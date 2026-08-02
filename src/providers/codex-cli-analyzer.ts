import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import {
  VerificationPlanSchema,
  WorkflowAssemblyDecisionSchema,
  WorkflowAnalyzerOutputSchema,
  type WorkflowAnalyzerContext,
  type WorkflowAnalyzerOutput,
} from '../planning/index.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import type { CommandRunner } from './command-runner.js';
import {
  parseCodexStream,
  prepareIsolatedCodexHome,
  providerFailureMessage,
  sha256,
} from './codex-cli-support.js';
import { WorkflowAnalyzerReceiptSchema, type WorkflowAnalyzerReceipt } from './contracts.js';

const WorkflowAnalyzerProviderOutputSchema = z
  .object({
    assemblyDecisions: z.array(WorkflowAssemblyDecisionSchema).min(1),
    sourceJson: z.string().min(1),
    verificationPlan: VerificationPlanSchema,
  })
  .strict();

export interface CodexWorkflowAnalyzerRequest extends WorkflowAnalyzerContext {
  readonly repositoryPath: string;
}

export interface CodexWorkflowAnalyzerSuccess {
  readonly output: WorkflowAnalyzerOutput;
  readonly receipt: WorkflowAnalyzerReceipt;
  readonly stderr: string;
}

export type CodexWorkflowAnalyzerFailure =
  | {
      readonly kind: 'provider_unavailable';
      readonly message: string;
    }
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
  | {
      readonly kind: 'invalid_event_stream';
      readonly message: string;
    }
  | {
      readonly kind: 'invalid_analyzer_output';
      readonly issues: readonly string[];
    };

interface RepositoryEvidence {
  readonly files: readonly string[];
  readonly workflowDocuments: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}

const ignoredDirectories = new Set(['.git', 'build', 'coverage', 'dist', 'node_modules', 'target']);

const collectRepositoryEvidence = async (repositoryPath: string): Promise<RepositoryEvidence> => {
  const files: string[] = [];

  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 4 || files.length >= 750) return;

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= 750) return;
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

  const workflowDocumentPaths = files.filter((path) => {
    const basename = path.split('/').at(-1)?.toLowerCase() ?? '';
    return (
      path === 'AGENTS.md' ||
      path === 'README.md' ||
      path === 'WORKFLOW.md' ||
      basename === 'package.json' ||
      basename === 'pnpm-workspace.yaml' ||
      basename === 'tasker-workflow.md' ||
      basename === 'workflow.md'
    );
  });
  const workflowDocuments: { path: string; content: string }[] = [];
  let remainingBytes = 48_000;

  for (const path of workflowDocumentPaths) {
    if (remainingBytes <= 0) break;
    try {
      const content = await readFile(join(repositoryPath, path), 'utf8');
      const bounded = content.slice(0, Math.min(remainingBytes, 16_000));
      workflowDocuments.push({ path, content: bounded });
      remainingBytes -= Buffer.byteLength(bounded, 'utf8');
    } catch {
      // A concurrently removed or non-text policy file is simply absent from the evidence bundle.
    }
  }

  return { files, workflowDocuments };
};

const analyzerPrompt = (
  request: CodexWorkflowAnalyzerRequest,
  repositoryEvidence: RepositoryEvidence,
): string =>
  `
You are the read-only workflow analyzer for Tasker.

Tasker has already collected a bounded read-only repository snapshot below. Use only that evidence.
Do not call tools or shell commands. Do not edit files, create commits, install dependencies, or
perform remote writes. Initial workflow assembly is deliberately based on task, policy, manifest,
and repository-shape evidence; facts discovered by reproduction belong to runtime continuation.
Return only the JSON object required by the provided output schema.
The sourceJson field must contain the complete WorkflowSource as serialized JSON. It is a string
because the provider's strict-output schema cannot represent optional recursive DSL fields; Tasker
will parse and validate that string against its authoritative workflow contract.

The JSON encoded inside sourceJson MUST have exactly these top-level keys:
{"id":"task-specific-workflow-id","version":1,"root":{...registered workflow node...}}
Start by copying plannerContext.baseTemplate, then make only justified task-specific changes to its
id and recursive root nodes. Do not invent an envelope. In particular, NEVER return top-level keys
such as schemaVersion, task, repository, workflow, steps, or edges inside sourceJson.
Every task workflow must retain task.analyze@1 as the first root-sequence child and a
plan.approved@1 gate as the second. Tasker run settings decide whether that gate pauses for a human;
they never remove the mandatory planning step or its deterministic validation boundary.

Use only node kinds and versioned contracts present in plannerContext. The base template is a
starting point, not executable authority. Explain every material specialization in
assemblyDecisions. Select verification from observable task/repository facts and policy.

Do not claim facts that require later execution. In particular, do not claim that a bug was
reproduced or that an implementation works. If reproduction or implementation later discovers
a new repository/dependency, the runtime will return workflow_change_required and Tasker will
assemble a linked continuation.

taskSnapshot:
${JSON.stringify(request.taskSnapshot, null, 2)}

plannerContext:
${JSON.stringify(request.plannerContext, null, 2)}

repositoryEvidence:
${JSON.stringify(repositoryEvidence, null, 2)}
`.trim();

export class CodexCliWorkflowAnalyzer {
  public constructor(
    private readonly runner: CommandRunner,
    private readonly options: {
      readonly command?: string;
      readonly model?: string;
      readonly serviceTier?: 'fast' | 'flex';
      readonly timeoutMs?: number;
    } = {},
  ) {}

  public async analyze(
    request: CodexWorkflowAnalyzerRequest,
  ): Promise<Outcome<CodexWorkflowAnalyzerSuccess, CodexWorkflowAnalyzerFailure>> {
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

    const repositoryEvidence = await collectRepositoryEvidence(request.repositoryPath);
    const prompt = analyzerPrompt(request, repositoryEvidence);
    const directory = await mkdtemp(join(tmpdir(), 'tasker-codex-analyzer-'));
    const schemaPath = join(directory, 'workflow-analyzer-output.schema.json');
    const isolatedCodexHome = join(directory, 'codex-home');
    const isolatedWorkspace = join(directory, 'workspace');
    const model = this.options.model ?? 'gpt-5.4';
    const serviceTier = this.options.serviceTier ?? 'fast';

    try {
      await prepareIsolatedCodexHome(isolatedCodexHome);
      await mkdir(isolatedWorkspace, { recursive: true });
      await writeFile(
        schemaPath,
        `${JSON.stringify(z.toJSONSchema(WorkflowAnalyzerProviderOutputSchema), null, 2)}\n`,
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
          'model_reasoning_effort="low"',
          '--ephemeral',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          '--cd',
          isolatedWorkspace,
          '--output-schema',
          schemaPath,
          '--json',
          '-',
        ],
        cwd: isolatedWorkspace,
        env: { CODEX_HOME: isolatedCodexHome },
        stdin: prompt,
        timeoutMs: this.options.timeoutMs ?? 10 * 60_000,
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
      if (!stream.ok) {
        return stream;
      }

      let providerOutputInput: unknown;
      try {
        providerOutputInput = JSON.parse(stream.value.finalMessage) as unknown;
      } catch {
        return err({
          kind: 'invalid_analyzer_output',
          issues: ['Final agent message was not JSON'],
        });
      }
      const providerOutput = WorkflowAnalyzerProviderOutputSchema.safeParse(providerOutputInput);
      if (!providerOutput.success) {
        return err({
          kind: 'invalid_analyzer_output',
          issues: providerOutput.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
      }

      let sourceInput: unknown;
      try {
        sourceInput = JSON.parse(providerOutput.data.sourceJson) as unknown;
      } catch {
        return err({
          kind: 'invalid_analyzer_output',
          issues: ['sourceJson: expected serialized WorkflowSource JSON'],
        });
      }

      const output = WorkflowAnalyzerOutputSchema.safeParse({
        assemblyDecisions: providerOutput.data.assemblyDecisions,
        source: sourceInput,
        verificationPlan: providerOutput.data.verificationPlan,
      });
      if (!output.success) {
        return err({
          kind: 'invalid_analyzer_output',
          issues: output.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
      }

      return ok({
        output: output.data,
        stderr: execution.stderr,
        receipt: WorkflowAnalyzerReceiptSchema.parse({
          status: 'completed',
          provider: 'codex_cli',
          analyzerVersion: 'codex-cli@1',
          cliVersion: version.stdout.trim(),
          model,
          serviceTier,
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
