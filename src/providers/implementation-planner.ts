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
import { analyzeTaskFixture } from '../planning/proposal.js';
import { WorkflowSourceSchema } from '../workflow/index.js';
import {
  PlanningEvidenceRequestSchema,
  type PlanningEvidenceRequest,
} from '../planning/planning-evidence.js';
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
import {
  ImplementationPlannerReceiptSchema,
  type ImplementationPlannerReceipt,
} from './contracts.js';

const ImplementationPlannerProviderOutputSchema = z
  .object({
    decisionJson: z.string().min(1).nullable(),
    evidenceRequestsJson: z.string().min(2),
  })
  .strict();

export interface ImplementationPlannerRequest {
  readonly operationId: string | null;
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
  readonly stderr: string;
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
  | { readonly kind: 'invalid_planner_output'; readonly issues: readonly string[] };

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

const invalidOutput = (issues: readonly string[]): Outcome<never, ImplementationPlannerFailure> =>
  err({ kind: 'invalid_planner_output', issues });

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
  public constructor(private readonly runner: WorkspaceCommandRunner) {}

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

    try {
      const prompt = plannerPrompt(request);
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
        skills: [...request.skills],
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
      const execution = await this.runner.run({
        ...(request.operationId === null ? {} : { operationId: request.operationId }),
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
          TASKER_HARNESS_ENV_FILE: '/dev/null',
        },
        mounts: [{ source: directory, target: directory, readOnly: false }],
        unsetEnv: request.mediatedCredentialEnvironment,
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
      if (!stream.ok) return stream;
      const providerOutput = ImplementationPlannerProviderOutputSchema.safeParse(
        stream.value.finalMessage,
      );
      if (!providerOutput.success) {
        return invalidOutput(
          providerOutput.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        );
      }

      let evidenceRequestsInput: unknown = [];
      try {
        evidenceRequestsInput = JSON.parse(providerOutput.data.evidenceRequestsJson) as unknown;
      } catch {
        return invalidOutput(['evidenceRequestsJson: expected serialized request array JSON']);
      }
      const evidenceRequests = z
        .array(PlanningEvidenceRequestSchema)
        .min(1)
        .max(10)
        .safeParse(evidenceRequestsInput);
      const hasEvidenceRequests =
        Array.isArray(evidenceRequestsInput) && evidenceRequestsInput.length > 0;
      if (hasEvidenceRequests && !evidenceRequests.success) {
        return invalidOutput(
          evidenceRequests.error.issues.map(
            (issue) => `evidenceRequestsJson.${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        );
      }
      if (!hasEvidenceRequests && !Array.isArray(evidenceRequestsInput)) {
        return invalidOutput(['evidenceRequestsJson: expected an array']);
      }

      const receipt = ImplementationPlannerReceiptSchema.parse({
        status: 'completed',
        provider: profile.provider === 'codex' ? 'codex_cli' : 'claude_cli',
        plannerVersion: 'implementation-planner@2',
        profile: profile.name,
        profileSha256: profile.configurationSha256,
        cliVersion: version.stdout.trim(),
        model: profile.model,
        effort: profile.effort,
        serviceTier: profile.provider === 'codex' ? profile.serviceTier : null,
        strategy: request.strategy,
        sessionId: stream.value.sessionId,
        promptHash: sha256(prompt),
        durationMs: execution.durationMs,
        usage: {
          inputTokens: stream.value.usage.inputTokens,
          cachedInputTokens: stream.value.usage.cachedInputTokens,
          outputTokens: stream.value.usage.outputTokens,
          reasoningOutputTokens: stream.value.usage.reasoningOutputTokens,
        },
        hypotheticalApiCostUsd: stream.value.reportedCostUsd,
      });
      if (hasEvidenceRequests) {
        if (providerOutput.data.decisionJson !== null) {
          return invalidOutput(['decisionJson must be null while evidence requests are pending']);
        }
        if (!evidenceRequests.success) {
          throw new Error('Validated evidence request state is inconsistent');
        }
        return ok({
          decision: null,
          evidenceRequests: evidenceRequests.data,
          stderr: execution.stderr,
          receipt,
        });
      }
      if (providerOutput.data.decisionJson === null) {
        return invalidOutput(['decisionJson is required when no evidence request is pending']);
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

      return ok({ decision: decision.data, stderr: execution.stderr, receipt });
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
    const analyzed = analyzeTaskFixture(context.task);
    if (!analyzed.ok) {
      return Promise.resolve(
        err({ kind: 'invalid_planner_output', issues: ['Deterministic fixture is invalid.'] }),
      );
    }
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
            objective: 'Select and run the verification required by the task and discovered scope.',
            repository,
            files: [],
            verification: ['Complete the selected verification without unexplained failures.'],
          },
        ],
        assumptions: [
          'The current evidence exposes every repository and external effect required for execution.',
        ],
        risks: [
          {
            risk: 'Execution may discover a cross-repository dependency not visible during planning.',
            mitigation: 'Request a durable runtime continuation and preserve the completed prefix.',
          },
        ],
        acceptanceCriteria: [
          'The task-visible behavior matches the requested outcome.',
          'The configured verification profile completes with durable evidence.',
        ],
      },
      followUps: [],
      workflow: {
        assemblyDecisions: analyzed.value.assemblyDecisions,
        source: WorkflowSourceSchema.parse(analyzed.value.source),
        verificationPlan: analyzed.value.verificationPlan,
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
          plannerVersion: 'implementation-planner@2',
          profile: 'deterministic',
          profileSha256: promptHash,
          cliVersion: 'deterministic@1',
          model: 'deterministic',
          effort: 'low',
          serviceTier: null,
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
