import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import {
  getHarnessPack,
  renderPromptTemplate,
  type ResolvedExecutionProfile,
} from '../harness/index.js';
import {
  VerificationPlanSchema,
  WorkflowAssemblyDecisionSchema,
  WorkflowAnalyzerOutputSchema,
  type EvidenceBundle,
  type WorkflowAnalyzerContext,
  type WorkflowAnalyzerOutput,
} from '../planning/index.js';
import { SemanticWorkflowSourceSchema } from '../workflow/index.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import type { WorkspaceCommandRunner } from './command-runner.js';
import {
  codexOutputJsonSchema,
  prepareIsolatedCodexHome,
  providerFailureMessage,
  sha256,
} from './codex-cli-support.js';
import { prepareIsolatedClaudeHome } from './claude-cli-support.js';
import { parseSubscriptionCliStream } from './subscription-cli-stream.js';
import {
  prepareAgentSkills,
  type PrepareAgentSkillsFailure,
  workspaceHarnessEnvironment,
} from './agent-skills.js';
import { WorkflowAnalyzerReceiptSchema, type WorkflowAnalyzerReceipt } from './contracts.js';
import { estimateApiCost } from './api-cost.js';

const WorkflowAnalyzerProviderOutputSchema = z
  .object({
    assemblyDecisions: z.array(WorkflowAssemblyDecisionSchema).min(1),
    source: SemanticWorkflowSourceSchema,
    verificationPlan: VerificationPlanSchema,
  })
  .strict();

export interface WorkflowAnalyzerRequest extends WorkflowAnalyzerContext {
  readonly operationId: string;
  readonly repositoryPath: string;
  readonly repositoryReference: string;
  readonly evidenceBundle: EvidenceBundle;
}

export interface WorkflowAnalyzerSuccess {
  readonly output: WorkflowAnalyzerOutput;
  readonly receipt: WorkflowAnalyzerReceipt;
  readonly stderr: string;
}

export type WorkflowAnalyzerFailure =
  | PrepareAgentSkillsFailure
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

const analyzerPrompt = (request: WorkflowAnalyzerRequest): string =>
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

export class SubscriptionCliWorkflowAnalyzer {
  public constructor(
    private readonly runner: WorkspaceCommandRunner,
    private readonly profileFor: (repositoryReference: string) => ResolvedExecutionProfile,
  ) {}

  public async analyze(
    request: WorkflowAnalyzerRequest,
  ): Promise<Outcome<WorkflowAnalyzerSuccess, WorkflowAnalyzerFailure>> {
    const profile = this.profileFor(request.repositoryReference);
    const command = profile.command;
    const version = await this.runner.run({
      operationId: request.operationId,
      command,
      args: ['--version'],
      cwd: request.repositoryPath,
      workspaceAccess: 'read_only',
      stdin: '',
      timeoutMs: 10_000,
    });

    if (version.status === 'spawn_failed') {
      return err({ kind: 'provider_unavailable', message: version.message });
    }
    if (version.status !== 'exited' || version.exitCode !== 0) {
      return err({
        kind: 'provider_unavailable',
        message: `${profile.provider} CLI version probe failed`,
      });
    }

    const prompt = analyzerPrompt(request);
    const directory = await mkdtemp(join(tmpdir(), 'tasker-workflow-analyzer-'));
    const schemaPath = join(directory, 'workflow-analyzer-output.schema.json');
    const providerConfigurationRoot = join(directory, 'provider-home');
    try {
      if (profile.provider === 'codex') await prepareIsolatedCodexHome(providerConfigurationRoot);
      else await prepareIsolatedClaudeHome(providerConfigurationRoot);
      const preparedSkills = await prepareAgentSkills({
        provider: profile.provider,
        repositoryPath: request.repositoryPath,
        configurationRoot: providerConfigurationRoot,
        selection: { kind: 'analyzer' },
      });
      if (!preparedSkills.ok) return err(preparedSkills.error);
      await writeFile(
        schemaPath,
        `${JSON.stringify(codexOutputJsonSchema(WorkflowAnalyzerProviderOutputSchema), null, 2)}\n`,
        'utf8',
      );
      const outputSchema = codexOutputJsonSchema(WorkflowAnalyzerProviderOutputSchema);
      const execution = await this.runner.run({
        operationId: request.operationId,
        command,
        args:
          profile.provider === 'codex'
            ? [
                'exec',
                '--model',
                profile.model,
                '-c',
                `service_tier="${profile.serviceTier}"`,
                '-c',
                `model_reasoning_effort="${profile.effort}"`,
                '--ephemeral',
                '--skip-git-repo-check',
                '--dangerously-bypass-approvals-and-sandbox',
                '--cd',
                request.repositoryPath,
                '--output-schema',
                schemaPath,
                '--json',
                '-',
              ]
            : [
                '--print',
                '--model',
                profile.model,
                '--effort',
                profile.effort,
                '--output-format',
                'stream-json',
                '--verbose',
                '--no-session-persistence',
                '--dangerously-skip-permissions',
                '--json-schema',
                JSON.stringify(outputSchema),
                ...preparedSkills.value.cliArguments,
              ],
        cwd: request.repositoryPath,
        workspaceAccess: 'read_only',
        env: {
          ...(profile.provider === 'codex'
            ? { CODEX_HOME: providerConfigurationRoot }
            : { HOME: providerConfigurationRoot }),
          ...workspaceHarnessEnvironment(request.repositoryPath, preparedSkills.value.skillsRoot),
        },
        mounts: [{ source: directory, target: directory, readOnly: false }],
        stdin: prompt,
        timeoutMs: profile.timeoutMs,
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
          message: providerFailureMessage(execution.stdout, execution.stderr),
          stderr: execution.stderr,
        });
      }

      const stream = parseSubscriptionCliStream(profile.provider, execution.stdout);
      if (!stream.ok) {
        return stream;
      }

      const providerOutput = WorkflowAnalyzerProviderOutputSchema.safeParse(
        stream.value.finalMessage,
      );
      if (!providerOutput.success) {
        return err({
          kind: 'invalid_analyzer_output',
          issues: providerOutput.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
      }

      const output = WorkflowAnalyzerOutputSchema.safeParse({
        assemblyDecisions: providerOutput.data.assemblyDecisions,
        source: providerOutput.data.source,
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
          provider: profile.provider === 'codex' ? 'codex_cli' : 'claude_cli',
          analyzerVersion: 'workflow-analyzer@2',
          profile: profile.name,
          profileSha256: profile.configurationSha256,
          cliVersion: version.stdout.trim(),
          model: profile.model,
          effort: profile.effort,
          serviceTier: profile.provider === 'codex' ? profile.serviceTier : null,
          sessionId: stream.value.sessionId,
          promptHash: sha256(prompt),
          durationMs: execution.durationMs,
          usage: {
            inputTokens: stream.value.usage.inputTokens,
            cachedInputTokens: stream.value.usage.cachedInputTokens,
            outputTokens: stream.value.usage.outputTokens,
            reasoningOutputTokens: stream.value.usage.reasoningOutputTokens,
          },
          apiCost: estimateApiCost(profile, stream.value.usage, stream.value.reportedCostUsd),
        }),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
