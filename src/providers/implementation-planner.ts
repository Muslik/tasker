import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { renderPromptTemplate, type ResolvedExecutionProfile } from '../harness/index.js';
import {
  ImplementationPlannerContextSchema,
  ImplementationPlanningDecisionSchema,
  type ImplementationPlannerContext,
  type ImplementationPlanningDecision,
  type PlanningStrategy,
} from '../planning/implementation-plan.js';
import {
  PlanningEvidenceRequestSchema,
  type PlanningEvidenceRequest,
} from '../planning/planning-evidence.js';
import {
  planningAgentInvocationId,
  type AgentInvocationArtifact,
  type AgentInvocationRecorder,
  type AgentInvocationTokenUsage,
} from '../observability/agent-invocation.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import type { WorkspaceCommandRunner } from './command-runner.js';
import {
  codexOutputJsonSchema,
  prepareIsolatedCodexHome,
  providerFailureMessage,
  sha256,
} from './codex-cli-support.js';
import { prepareIsolatedClaudeHome } from './claude-cli-support.js';
import {
  parseSubscriptionCliStream,
  type SubscriptionCliStreamResult,
} from './subscription-cli-stream.js';
import {
  prepareAgentSkills,
  type PrepareAgentSkillsFailure,
  workspaceHarnessEnvironment,
} from './agent-skills.js';
import {
  ImplementationPlannerReceiptSchema,
  type ImplementationPlannerReceipt,
} from './contracts.js';
import { estimateApiCost } from './api-cost.js';

const ImplementationPlannerProviderOutputSchema = z
  .object({
    decision: ImplementationPlanningDecisionSchema.nullable(),
    evidenceRequests: z.array(PlanningEvidenceRequestSchema).max(10),
  })
  .strict();

export interface ImplementationPlannerRequest {
  readonly operationId: string | null;
  readonly taskReference: string;
  readonly planningEpisodeId: string;
  readonly planningAttempt: number;
  readonly invocationNumber: number;
  readonly inputEvidenceArtifactIds: readonly string[];
  readonly outputReferences: {
    readonly completedArtifactId: string;
    readonly validatedCandidateArtifactId: string;
    readonly evidenceRequestArtifactId: string;
    readonly failedArtifactId: string;
    readonly receiptArtifactId: string | null;
  };
  readonly onTranscriptDegradation?: ((message: string) => void) | undefined;
  readonly repositoryPath: string;
  readonly strategy: PlanningStrategy;
  readonly profile: ResolvedExecutionProfile;
  readonly skills: readonly string[];
  readonly mediatedSkills: readonly string[];
  readonly mediatedCredentialEnvironment: readonly string[];
  readonly context: ImplementationPlannerContext;
  readonly promptTemplate: string;
}

export interface ImplementationPlannerSuccess {
  readonly decision: ImplementationPlanningDecision | null;
  readonly evidenceRequests?: readonly PlanningEvidenceRequest[];
  readonly receipt: ImplementationPlannerReceipt;
}

export type ImplementationPlannerDecisionSuccess = ImplementationPlannerSuccess & {
  readonly decision: ImplementationPlanningDecision;
};

export type ImplementationPlannerFailure =
  | PrepareAgentSkillsFailure
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
  | {
      readonly kind: 'invalid_planner_output';
      readonly issues: readonly string[];
      readonly receipt?: ImplementationPlannerReceipt;
    };

export interface ImplementationPlanner {
  plan(
    request: ImplementationPlannerRequest,
  ): Promise<Outcome<ImplementationPlannerSuccess, ImplementationPlannerFailure>>;
}

const plannerPrompt = (request: ImplementationPlannerRequest): string => {
  const strategyInstruction =
    request.strategy === 'ralplan'
      ? `Invoke $ralplan non-interactively and use its Planner -> Architect -> Critic consensus loop.
This provider boundary is read-only: keep deliberation in memory, do not create .omx files, and
return the final consensus decision through the required JSON schema.`
      : `Use one bounded planning pass. Start with the immutable evidence supplied below, then use
read-only repository tools or the selected logical skills only when they can resolve a material
planning uncertainty. Do not start a consensus or implementation workflow.`;

  return renderPromptTemplate(request.promptTemplate, {
    strategyInstruction: `${strategyInstruction}\nSelected read-only skills: ${
      request.skills.length === 0 ? 'none' : request.skills.join(', ')
    }.\nExternally mediated skills: ${
      request.mediatedSkills.length === 0 ? 'none' : request.mediatedSkills.join(', ')
    }.`,
    plannerContext: JSON.stringify(
      {
        task: request.context.task,
        taskSnapshot: request.context.taskSnapshot,
        blocks: request.context.blocks,
        repositoryReference: request.context.repositoryReference,
        operatorGuidance: request.context.operatorGuidance,
        validationFeedback: request.context.validationFeedback,
        previousDecision: request.context.previousDecision,
      },
      null,
      2,
    ),
    repositoryEvidence: JSON.stringify(request.context.evidenceBundle, null, 2),
  });
};

const emptyUsage = (): AgentInvocationTokenUsage => ({
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
});

const usageFromStream = (
  usage: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
    readonly reasoningOutputTokens: number;
  } | null,
): AgentInvocationTokenUsage =>
  usage === null
    ? emptyUsage()
    : {
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
      };

const planningTranscriptReferenceFor = (operationId: string): string =>
  `planning-transcript:${operationId}`;

const appendObservabilityLine = (request: ImplementationPlannerRequest, message: string): void => {
  try {
    request.onTranscriptDegradation?.(message.endsWith('\n') ? message : `${message}\n`);
  } catch {
    return;
  }
};

const buildReceipt = (
  request: ImplementationPlannerRequest,
  profile: ResolvedExecutionProfile,
  cliVersion: string,
  promptHash: string,
  durationMs: number,
  stream: SubscriptionCliStreamResult,
): ImplementationPlannerReceipt =>
  ImplementationPlannerReceiptSchema.parse({
    status: 'completed',
    provider: profile.provider === 'codex' ? 'codex_cli' : 'claude_cli',
    plannerVersion: 'implementation-planner@4',
    profile: profile.name,
    profileSha256: profile.configurationSha256,
    cliVersion,
    model: profile.model,
    effort: profile.effort,
    serviceTier: profile.provider === 'codex' ? profile.serviceTier : null,
    strategy: request.strategy,
    sessionId: stream.sessionId,
    promptHash,
    durationMs,
    usage: {
      inputTokens: stream.usage?.inputTokens ?? 0,
      cachedInputTokens: stream.usage?.cachedInputTokens ?? 0,
      outputTokens: stream.usage?.outputTokens ?? 0,
      reasoningOutputTokens: stream.usage?.reasoningOutputTokens ?? 0,
    },
    apiCost: estimateApiCost(profile, stream.usage, stream.reportedCostUsd),
  });

const mediatedSkill = (skill: string): string => `---
name: ${skill}
description: Request read-only ${skill} evidence through Tasker's provenance boundary.
---

# Mediated ${skill} evidence

Do not call ${skill} APIs, scripts, CLIs, or credentials directly. If the supplied Evidence Bundle
does not contain material information that only ${skill} can answer, return an evidence request
using the provider output contract. Tasker will perform the read, append immutable provenance, and
run planning again with the updated bundle.
`;

export class SubscriptionCliImplementationPlanner implements ImplementationPlanner {
  public constructor(
    private readonly runner: WorkspaceCommandRunner,
    private readonly recorder: AgentInvocationRecorder | null = null,
  ) {}

  public async plan(
    requestInput: ImplementationPlannerRequest,
  ): Promise<Outcome<ImplementationPlannerSuccess, ImplementationPlannerFailure>> {
    const request = {
      ...requestInput,
      context: ImplementationPlannerContextSchema.parse(requestInput.context),
    };
    const profile = request.profile;
    const command = profile.command;
    const version = await this.runner.run({
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

    const directory = await mkdtemp(join(tmpdir(), 'tasker-implementation-planner-'));
    const schemaPath = join(directory, 'implementation-planner-output.schema.json');
    const providerConfigurationRoot = join(directory, 'provider-home');
    let prompt = '';
    let args: readonly string[] = [];
    let invocationId: string | null = null;
    let invocationStartedAt: string | null = null;
    const recorderNow = (): string | null => {
      if (this.recorder === null) return null;
      try {
        return this.recorder.now();
      } catch (error) {
        appendObservabilityLine(
          request,
          `[OBSERVABILITY FAILURE] planner invocation clock lookup failed for ${request.planningEpisodeId}/${String(request.invocationNumber)}: ${error instanceof Error ? error.message : 'unknown error'}; planning continues.`,
        );
        return null;
      }
    };

    const buildReferences = (outputArtifactIds: readonly string[]) => {
      if (request.operationId === null) return null;
      return {
        kind: 'planning' as const,
        transcriptId: planningTranscriptReferenceFor(request.operationId),
        outputArtifactIds: [...outputArtifactIds],
        receiptArtifactId: request.outputReferences.receiptArtifactId,
        planningEpisodeId: request.planningEpisodeId,
        planningAttempt: request.planningAttempt,
        invocationNumber: request.invocationNumber,
        operationId: request.operationId,
      };
    };
    const persistInvocation = (input: {
      readonly durationMs: number;
      readonly status: AgentInvocationArtifact['status'];
      readonly exitStatus: AgentInvocationArtifact['exitStatus'];
      readonly usage: AgentInvocationTokenUsage;
      readonly cost: AgentInvocationArtifact['cost'];
      readonly outputArtifactIds: readonly string[];
    }): void => {
      if (
        this.recorder === null ||
        invocationId === null ||
        invocationStartedAt === null ||
        request.operationId === null
      ) {
        return;
      }
      const references = buildReferences(input.outputArtifactIds);
      if (references === null) return;
      let finished;
      try {
        finished = this.recorder.finish({
          schemaVersion: 1,
          invocationId,
          taskReference: request.taskReference,
          prompt,
          promptBytes: Buffer.byteLength(prompt, 'utf8'),
          provider: profile.provider,
          profile: profile.name,
          profileSha256: profile.configurationSha256,
          model: profile.model,
          effort: profile.effort,
          serviceTier: profile.provider === 'codex' ? profile.serviceTier : null,
          argv: [command, ...args],
          skills: [...request.skills],
          inputEvidenceArtifactIds: [...request.inputEvidenceArtifactIds],
          startedAt: invocationStartedAt,
          finishedAt: recorderNow() ?? invocationStartedAt,
          durationMs: input.durationMs,
          status: input.status,
          exitStatus: input.exitStatus,
          usage: input.usage,
          cost: input.cost,
          references,
        });
      } catch (error) {
        appendObservabilityLine(
          request,
          `[OBSERVABILITY FAILURE] planner invocation artifact persistence threw for ${invocationId}: ${error instanceof Error ? error.message : 'unknown error'}; planning continues.`,
        );
        return;
      }
      if (!finished.ok) {
        appendObservabilityLine(
          request,
          `[OBSERVABILITY FAILURE] planner invocation artifact persistence failed (${finished.error.kind}) for ${invocationId}; planning continues.`,
        );
      }
    };
    const invalidPlannerOutput = (
      issues: readonly string[],
      receipt?: ImplementationPlannerReceipt,
    ): Outcome<never, ImplementationPlannerFailure> =>
      err(
        receipt === undefined
          ? { kind: 'invalid_planner_output', issues }
          : { kind: 'invalid_planner_output', issues, receipt },
      );
    const persistExitedFailure = (
      execution: Extract<
        Awaited<ReturnType<WorkspaceCommandRunner['run']>>,
        { readonly status: 'exited' }
      >,
      usage: AgentInvocationTokenUsage,
      cost: AgentInvocationArtifact['cost'],
      outputArtifactIds: readonly string[] = [],
    ): void => {
      persistInvocation({
        durationMs: execution.durationMs,
        status: 'failed',
        exitStatus: { kind: 'exited', exitCode: execution.exitCode },
        usage,
        cost,
        outputArtifactIds,
      });
    };

    try {
      prompt = plannerPrompt(request);
      const promptHash = sha256(prompt);
      if (profile.provider === 'codex') {
        await prepareIsolatedCodexHome(providerConfigurationRoot, {
          includePlanningSurfaces: request.strategy === 'ralplan',
        });
      } else {
        await prepareIsolatedClaudeHome(providerConfigurationRoot);
      }
      await mkdir(providerConfigurationRoot, { recursive: true });
      const preparedSkills = await prepareAgentSkills({
        provider: profile.provider,
        repositoryPath: request.repositoryPath,
        configurationRoot: providerConfigurationRoot,
        selection: { kind: 'planner', skills: [...request.skills] },
        skillOverrides: Object.fromEntries(
          request.mediatedSkills.map((skill) => [skill, mediatedSkill(skill)]),
        ),
      });
      if (!preparedSkills.ok) return err(preparedSkills.error);
      await writeFile(
        schemaPath,
        `${JSON.stringify(codexOutputJsonSchema(ImplementationPlannerProviderOutputSchema), null, 2)}\n`,
        'utf8',
      );
      const outputSchema = codexOutputJsonSchema(ImplementationPlannerProviderOutputSchema);
      args =
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
      invocationId =
        this.recorder !== null && request.operationId !== null
          ? planningAgentInvocationId(
              request.planningEpisodeId,
              request.planningAttempt,
              request.invocationNumber,
            )
          : null;
      invocationStartedAt = invocationId === null ? null : recorderNow();
      const recorder = this.recorder;
      if (invocationId !== null && invocationStartedAt !== null && recorder !== null) {
        const references = buildReferences([]);
        if (references === null)
          throw new Error('Planning invocation lost its operation reference');
        let started;
        try {
          started = recorder.start({
            invocationId,
            taskReference: request.taskReference,
            references,
            startedAt: invocationStartedAt,
          });
        } catch (error) {
          appendObservabilityLine(
            request,
            `[OBSERVABILITY FAILURE] planner invocation start threw for ${invocationId}: ${error instanceof Error ? error.message : 'unknown error'}; planning continues.`,
          );
          started = null;
        }
        if (started !== null && !started.ok) {
          appendObservabilityLine(
            request,
            `[OBSERVABILITY FAILURE] planner invocation start persistence failed (${started.error.kind}) for ${invocationId}; planning continues.`,
          );
        }
      }
      const execution = await this.runner.run({
        ...(request.operationId === null ? {} : { operationId: request.operationId }),
        command,
        args,
        cwd: request.repositoryPath,
        workspaceAccess: 'read_only',
        env: {
          ...(profile.provider === 'codex'
            ? { CODEX_HOME: providerConfigurationRoot }
            : { HOME: providerConfigurationRoot }),
          ...workspaceHarnessEnvironment(request.repositoryPath, preparedSkills.value.skillsRoot),
          TASKER_HARNESS_ENV_FILE: '/dev/null',
        },
        mounts: [{ source: directory, target: directory, readOnly: false }],
        unsetEnv: request.mediatedCredentialEnvironment,
        stdin: prompt,
        timeoutMs: profile.timeoutMs,
      });

      if (execution.status === 'spawn_failed') {
        persistInvocation({
          durationMs: execution.durationMs,
          status: 'failed',
          exitStatus: { kind: 'spawn_failed', message: execution.message },
          usage: emptyUsage(),
          cost: { source: 'unrated' },
          outputArtifactIds: [],
        });
        return err({ kind: 'provider_unavailable', message: execution.message });
      }
      if (execution.status === 'timed_out') {
        persistInvocation({
          durationMs: execution.durationMs,
          status: 'failed',
          exitStatus: { kind: 'timed_out' },
          usage: emptyUsage(),
          cost: { source: 'unrated' },
          outputArtifactIds: [],
        });
        return err({
          kind: 'provider_timed_out',
          durationMs: execution.durationMs,
          stderr: execution.stderr,
        });
      }
      if (execution.exitCode !== 0) {
        persistExitedFailure(execution, emptyUsage(), { source: 'unrated' });
        return err({
          kind: 'provider_failed',
          exitCode: execution.exitCode,
          message: providerFailureMessage(execution.stdout, execution.stderr),
          stderr: execution.stderr,
        });
      }

      const stream = parseSubscriptionCliStream(profile.provider, execution.stdout);
      if (!stream.ok) {
        persistExitedFailure(execution, emptyUsage(), { source: 'unrated' });
        return stream;
      }
      const receipt = buildReceipt(
        request,
        profile,
        version.stdout.trim(),
        promptHash,
        execution.durationMs,
        stream.value,
      );
      const providerOutput = ImplementationPlannerProviderOutputSchema.safeParse(
        stream.value.finalMessage,
      );
      if (!providerOutput.success) {
        persistExitedFailure(execution, usageFromStream(stream.value.usage), receipt.apiCost, [
          request.outputReferences.failedArtifactId,
        ]);
        return invalidPlannerOutput(
          providerOutput.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
          receipt,
        );
      }
      const evidenceRequests = providerOutput.data.evidenceRequests;
      const hasEvidenceRequests = evidenceRequests.length > 0;
      if (hasEvidenceRequests) {
        if (providerOutput.data.decision !== null) {
          persistExitedFailure(execution, usageFromStream(stream.value.usage), receipt.apiCost, [
            request.outputReferences.failedArtifactId,
          ]);
          return invalidPlannerOutput(
            ['decision must be null while evidence requests are pending'],
            receipt,
          );
        }
        persistInvocation({
          durationMs: execution.durationMs,
          status: 'waiting',
          exitStatus: { kind: 'exited', exitCode: execution.exitCode },
          usage: usageFromStream(stream.value.usage),
          cost: receipt.apiCost,
          outputArtifactIds: [request.outputReferences.evidenceRequestArtifactId],
        });
        return ok({
          decision: null,
          evidenceRequests,
          receipt,
        });
      }
      if (providerOutput.data.decision === null) {
        persistExitedFailure(execution, usageFromStream(stream.value.usage), receipt.apiCost, [
          request.outputReferences.failedArtifactId,
        ]);
        return invalidPlannerOutput(
          ['decision is required when no evidence request is pending'],
          receipt,
        );
      }

      const decision = ImplementationPlanningDecisionSchema.safeParse(providerOutput.data.decision);
      if (!decision.success) {
        persistExitedFailure(execution, usageFromStream(stream.value.usage), receipt.apiCost, [
          request.outputReferences.failedArtifactId,
        ]);
        return invalidPlannerOutput(
          decision.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
          receipt,
        );
      }
      persistInvocation({
        durationMs: execution.durationMs,
        status: decision.data.status === 'ready' ? 'completed' : 'waiting',
        exitStatus: { kind: 'exited', exitCode: execution.exitCode },
        usage: usageFromStream(stream.value.usage),
        cost: receipt.apiCost,
        outputArtifactIds:
          decision.data.status === 'ready'
            ? [
                request.outputReferences.validatedCandidateArtifactId,
                request.outputReferences.completedArtifactId,
              ]
            : [request.outputReferences.completedArtifactId],
      });
      return ok({ decision: decision.data, receipt });
    } catch (error) {
      if (this.recorder !== null && invocationId !== null) {
        if (invocationStartedAt === null) invocationStartedAt = recorderNow();
        persistInvocation({
          durationMs: 0,
          status: 'failed',
          exitStatus: {
            kind: 'thrown',
            message: error instanceof Error ? error.message : 'Unknown planner exception',
          },
          usage: emptyUsage(),
          cost: { source: 'unrated' },
          outputArtifactIds: [],
        });
      }
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
