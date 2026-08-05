import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { getHarnessPack, renderPromptTemplate } from '../harness/index.js';
import {
  VerificationPlanSchema,
  WorkflowAssemblyDecisionSchema,
  WorkflowAnalyzerOutputSchema,
  type EvidenceBundle,
  type WorkflowAnalyzerContext,
  type WorkflowAnalyzerOutput,
} from '../planning/index.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import type { CommandRunner } from './command-runner.js';
import {
  codexOutputJsonSchema,
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
  readonly evidenceBundle: EvidenceBundle;
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

const analyzerPrompt = (request: CodexWorkflowAnalyzerRequest): string =>
  renderPromptTemplate(getHarnessPack().prompts.workflowAnalyzer.content, {
    taskSnapshot: JSON.stringify(request.taskSnapshot, null, 2),
    plannerContext: JSON.stringify(request.plannerContext, null, 2),
    repositoryEvidence: JSON.stringify(
      {
        taskReference: request.evidenceBundle.taskReference,
        revision: request.evidenceBundle.revision,
        inputFingerprint: request.evidenceBundle.inputFingerprint,
        entries: request.evidenceBundle.entries.filter(
          ({ evidenceType }) =>
            evidenceType === 'repository_inventory' || evidenceType === 'repository_document',
        ),
      },
      null,
      2,
    ),
  });

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

    const prompt = analyzerPrompt(request);
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
        `${JSON.stringify(codexOutputJsonSchema(WorkflowAnalyzerProviderOutputSchema), null, 2)}\n`,
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
