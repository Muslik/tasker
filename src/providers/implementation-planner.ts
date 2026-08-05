import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { renderPromptTemplate } from '../harness/index.js';
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
import { err, ok, type Outcome } from '../shared/outcome.js';
import type { CommandRunner } from './command-runner.js';
import {
  codexOutputJsonSchema,
  parseCodexStream,
  prepareIsolatedCodexHome,
  providerFailureMessage,
  sha256,
} from './codex-cli-support.js';
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
        workflow: request.context.workflow,
        repositoryReference: request.context.repositoryReference,
        operatorGuidance: request.context.operatorGuidance,
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
    const model = this.options.model ?? 'gpt-5.4';
    const serviceTier = this.options.serviceTier ?? 'fast';

    try {
      const prompt = plannerPrompt(request);
      await prepareIsolatedCodexHome(isolatedCodexHome, {
        includePlanningSurfaces: request.strategy === 'ralplan',
      });
      await mkdir(isolatedCodexHome, { recursive: true });
      const preparedSkills = await prepareAgentSkills({
        provider: 'codex',
        repositoryPath: request.repositoryPath,
        configurationRoot: isolatedCodexHome,
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
      const execution = await this.runner.run({
        ...(request.operationId === null ? {} : { operationId: request.operationId }),
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
          request.repositoryPath,
          '--output-schema',
          schemaPath,
          '--json',
          '-',
        ],
        cwd: request.repositoryPath,
        env: {
          CODEX_HOME: isolatedCodexHome,
          ...workspaceHarnessEnvironment(request.repositoryPath, preparedSkills.value.skillsRoot),
          TASKER_HARNESS_ENV_FILE: '/dev/null',
        },
        unsetEnv: request.mediatedCredentialEnvironment,
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
