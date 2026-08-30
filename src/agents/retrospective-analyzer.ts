import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import {
  codexOutputJsonSchema,
  normalizeCodexStructuredOutput,
  prepareIsolatedCodexHome,
  providerFailureMessage,
} from './codex-cli-support.js';
import { prepareIsolatedClaudeHome } from './claude-cli-support.js';
import { parseSubscriptionCliStream } from './subscription-cli-stream.js';
import { prepareAgentSkills, workspaceHarnessEnvironment } from './agent-skills.js';
import { estimateApiCost } from './api-cost.js';
import type { WorkspaceCommandRunner } from './command-runner.js';
import type { ResolvedExecutionProfile } from '../harness/index.js';
import { renderPromptTemplate } from '../harness/index.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  RetrospectiveAnalyzerOutputSchema,
  type RetrospectiveAnalyzerOutput,
} from '../shared/retrospective.js';
import type { AgentInvocationUsage } from '../steps/agent-usage.js';

export interface RetrospectiveAnalyzerRequest {
  readonly operationId: string;
  readonly taskReference: string;
  readonly repositoryPath: string;
  readonly digest: string;
  readonly promptTemplate: string;
}

export type RetrospectiveAnalyzerFailure =
  | { readonly kind: 'provider_unavailable'; readonly message: string }
  | { readonly kind: 'provider_failed'; readonly message: string }
  | { readonly kind: 'provider_timed_out'; readonly message: string }
  | { readonly kind: 'invalid_event_stream'; readonly message: string }
  | { readonly kind: 'invalid_output'; readonly issues: readonly string[] };

export interface RetrospectiveAnalyzerResult {
  readonly output: RetrospectiveAnalyzerOutput;
  readonly usage: AgentInvocationUsage;
}

export class SubscriptionCliRetrospectiveAnalyzer {
  public constructor(
    private readonly runner: WorkspaceCommandRunner,
    private readonly profileFor: () => ResolvedExecutionProfile,
  ) {}

  public async analyze(
    request: RetrospectiveAnalyzerRequest,
  ): Promise<Outcome<RetrospectiveAnalyzerResult, RetrospectiveAnalyzerFailure>> {
    const profile = this.profileFor();
    const version = await this.runner.run({
      command: profile.command,
      args: ['--version'],
      cwd: request.repositoryPath,
      workspaceAccess: 'read_only',
      stdin: '',
      timeoutMs: 10_000,
    });
    if (version.status === 'spawn_failed')
      return err({ kind: 'provider_unavailable', message: version.message });
    if (version.status !== 'exited' || version.exitCode !== 0)
      return err({
        kind: 'provider_unavailable',
        message: 'Retrospective analyzer CLI version probe failed',
      });

    const directory = await mkdtemp(join(tmpdir(), 'tasker-retrospective-analyzer-'));
    const schemaPath = join(directory, 'retrospective-analyzer-output.schema.json');
    const configurationRoot = join(directory, 'provider-home');
    try {
      if (profile.provider === 'codex') await prepareIsolatedCodexHome(configurationRoot);
      else await prepareIsolatedClaudeHome(configurationRoot);
      const preparedSkills = await prepareAgentSkills({
        provider: profile.provider,
        repositoryPath: request.repositoryPath,
        configurationRoot,
        selection: { kind: 'analyzer' },
      });
      if (!preparedSkills.ok)
        return err({ kind: 'provider_unavailable', message: preparedSkills.error.kind });
      const outputSchema =
        profile.provider === 'codex'
          ? codexOutputJsonSchema(RetrospectiveAnalyzerOutputSchema)
          : z.toJSONSchema(RetrospectiveAnalyzerOutputSchema);
      await writeFile(schemaPath, `${JSON.stringify(outputSchema, null, 2)}\n`, 'utf8');
      const args =
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
            ];
      const prompt = renderPromptTemplate(request.promptTemplate, { digest: request.digest });
      const execution = await this.runner.run({
        operationId: request.operationId,
        taskReference: request.taskReference,
        command: profile.command,
        args,
        cwd: request.repositoryPath,
        workspaceAccess: 'read_only',
        env: {
          ...(profile.provider === 'codex'
            ? { CODEX_HOME: configurationRoot }
            : { HOME: configurationRoot }),
          ...workspaceHarnessEnvironment(request.repositoryPath, preparedSkills.value.skillsRoot),
          TASKER_HARNESS_ENV_FILE: '/dev/null',
        },
        mounts: [{ source: directory, target: directory, readOnly: false }],
        stdin: prompt,
        timeoutMs: profile.timeoutMs,
      });
      if (execution.status === 'spawn_failed')
        return err({ kind: 'provider_unavailable', message: execution.message });
      if (execution.status === 'timed_out')
        return err({
          kind: 'provider_timed_out',
          message: `Retrospective analyzer timed out after ${String(execution.durationMs)} ms`,
        });
      if (execution.exitCode !== 0)
        return err({
          kind: 'provider_failed',
          message: providerFailureMessage(execution.stdout, execution.stderr),
        });
      const stream = parseSubscriptionCliStream(profile.provider, execution.stdout);
      if (!stream.ok) return err({ kind: 'invalid_event_stream', message: stream.error.message });
      const finalMessage =
        profile.provider === 'codex'
          ? normalizeCodexStructuredOutput(
              stream.value.finalMessage,
              RetrospectiveAnalyzerOutputSchema,
            )
          : stream.value.finalMessage;
      const output = RetrospectiveAnalyzerOutputSchema.safeParse(finalMessage);
      if (!output.success)
        return err({
          kind: 'invalid_output',
          issues: output.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        });
      return ok({
        output: output.data,
        usage: {
          provider: profile.provider,
          profile: profile.name,
          profileSha256: profile.configurationSha256,
          model: profile.model,
          effort: profile.effort,
          serviceTier: profile.provider === 'codex' ? profile.serviceTier : null,
          sessionId: stream.value.sessionId,
          durationMs: execution.durationMs,
          inputTokens: stream.value.usage?.inputTokens ?? 0,
          cachedInputTokens: stream.value.usage?.cachedInputTokens ?? 0,
          outputTokens: stream.value.usage?.outputTokens ?? 0,
          reasoningOutputTokens: stream.value.usage?.reasoningOutputTokens ?? 0,
          apiCost: estimateApiCost(profile, stream.value.usage, stream.value.reportedCostUsd),
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
