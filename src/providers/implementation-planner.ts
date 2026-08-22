import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { renderPromptTemplate, type ResolvedExecutionProfile } from '../harness/index.js';
import { TaskExecutionStrategySchema } from '../harness/execution-profile-contracts.js';
import {
  ImplementationPlanFollowUpSchema,
  ImplementationPlanSchema,
  ImplementationPlannerContextSchema,
  ImplementationPlanningDecisionSchema,
  PlanningQuestionSchema,
  PrePlanInvestigationRequestSchema,
  type ImplementationPlannerContext,
  type ImplementationPlanningDecision,
  type PlanningStrategy,
} from '../planning/implementation-plan.js';
import {
  VerificationPlanSchema,
  WorkflowAssemblyDecisionSchema,
} from '../planning/workflow-proposal-contracts.js';
import {
  BranchNodeSourceSchema,
  FinalizeNodeSourceSchema,
  GateNodeSourceSchema,
  JsonValueSchema,
  NodeIdSchema,
  PredicateReferenceSchema,
  SequenceNodeSourceSchema,
  StepNodeSourceSchema,
  WaitReferenceSchema,
  type WorkflowNodeSource,
} from '../workflow/index.js';
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
import { estimateApiCost } from './api-cost.js';

type ProviderWorkflowNodeSource =
  | {
      readonly kind: 'sequence';
      readonly id: string;
      readonly children: readonly ProviderWorkflowNodeSource[];
    }
  | {
      readonly kind: 'step';
      readonly id: string;
      readonly uses: string;
      readonly with: z.infer<typeof JsonValueSchema>;
    }
  | {
      readonly kind: 'branch';
      readonly id: string;
      readonly when: string;
      readonly then: ProviderWorkflowNodeSource;
      readonly otherwise: ProviderWorkflowNodeSource;
    }
  | {
      readonly kind: 'bounded_loop';
      readonly id: string;
      readonly maxAttempts: number;
      readonly until: string;
      readonly checkBefore: boolean;
      readonly exhaustedWait: string | null;
      readonly body: ProviderWorkflowNodeSource;
    }
  | {
      readonly kind: 'wait';
      readonly id: string;
      readonly for: string;
      readonly resumeAt: string | null;
    }
  | {
      readonly kind: 'gate';
      readonly id: string;
      readonly reason: string;
      readonly resumeWhen: string;
      readonly with: z.infer<typeof JsonValueSchema>;
    }
  | z.infer<typeof FinalizeNodeSourceSchema>;

const ProviderWorkflowNodeSourceSchema: z.ZodType<ProviderWorkflowNodeSource> = z.lazy(() =>
  z.union([
    SequenceNodeSourceSchema.extend({
      children: z.array(ProviderWorkflowNodeSourceSchema).min(1),
    }),
    StepNodeSourceSchema,
    BranchNodeSourceSchema.extend({
      then: ProviderWorkflowNodeSourceSchema,
      otherwise: ProviderWorkflowNodeSourceSchema,
    }),
    z
      .object({
        kind: z.literal('bounded_loop'),
        id: NodeIdSchema,
        maxAttempts: z.number(),
        until: PredicateReferenceSchema,
        checkBefore: z.boolean(),
        exhaustedWait: WaitReferenceSchema.nullable(),
        body: ProviderWorkflowNodeSourceSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('wait'),
        id: NodeIdSchema,
        for: WaitReferenceSchema,
        resumeAt: z.string().min(1).nullable(),
      })
      .strict(),
    GateNodeSourceSchema.extend({ with: JsonValueSchema }),
    FinalizeNodeSourceSchema,
  ]),
);

const ProviderWorkflowAnalyzerOutputSchema = z
  .object({
    assemblyDecisions: z.array(WorkflowAssemblyDecisionSchema).min(1),
    source: z
      .object({
        id: z.string().min(1),
        version: z.number().int().positive(),
        root: ProviderWorkflowNodeSourceSchema,
      })
      .strict(),
    verificationPlan: VerificationPlanSchema,
  })
  .strict();

const ProviderImplementationPlanningDecisionSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ready'),
      executionStrategy: TaskExecutionStrategySchema,
      plan: ImplementationPlanSchema,
      followUps: z.array(ImplementationPlanFollowUpSchema).max(20),
      workflow: ProviderWorkflowAnalyzerOutputSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('needs_clarification'),
      questions: z.array(PlanningQuestionSchema).min(1).max(10),
    })
    .strict(),
  z
    .object({
      status: z.literal('investigation_required'),
      request: PrePlanInvestigationRequestSchema,
    })
    .strict(),
]);

const ImplementationPlannerProviderOutputSchema = z
  .object({
    decision: ProviderImplementationPlanningDecisionSchema.nullable(),
    evidenceRequests: z.array(PlanningEvidenceRequestSchema).max(10),
  })
  .strict();

const normalizeProviderWorkflowNode = (node: ProviderWorkflowNodeSource): WorkflowNodeSource => {
  switch (node.kind) {
    case 'sequence':
      return { ...node, children: node.children.map(normalizeProviderWorkflowNode) };
    case 'branch':
      return {
        ...node,
        then: normalizeProviderWorkflowNode(node.then),
        otherwise: normalizeProviderWorkflowNode(node.otherwise),
      };
    case 'bounded_loop':
      return {
        kind: node.kind,
        id: node.id,
        maxAttempts: node.maxAttempts,
        until: node.until,
        checkBefore: node.checkBefore,
        ...(node.exhaustedWait === null ? {} : { exhaustedWait: node.exhaustedWait }),
        body: normalizeProviderWorkflowNode(node.body),
      };
    case 'wait':
      return {
        kind: node.kind,
        id: node.id,
        for: node.for,
        ...(node.resumeAt === null ? {} : { resumeAt: node.resumeAt }),
      };
    case 'gate':
      return {
        kind: node.kind,
        id: node.id,
        reason: node.reason,
        resumeWhen: node.resumeWhen,
        ...(node.with === null ? {} : { with: node.with }),
      };
    case 'step':
    case 'finalize':
      return node;
  }
};

const normalizeProviderDecision = (
  decision: z.infer<typeof ProviderImplementationPlanningDecisionSchema>,
): unknown =>
  decision.status === 'ready'
    ? {
        ...decision,
        workflow: {
          ...decision.workflow,
          source: {
            ...decision.workflow.source,
            root: normalizeProviderWorkflowNode(decision.workflow.source.root),
          },
        },
      }
    : decision;

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

      const evidenceRequests = providerOutput.data.evidenceRequests;
      const hasEvidenceRequests = evidenceRequests.length > 0;

      const receipt = ImplementationPlannerReceiptSchema.parse({
        status: 'completed',
        provider: profile.provider === 'codex' ? 'codex_cli' : 'claude_cli',
        plannerVersion: 'implementation-planner@3',
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
        apiCost: estimateApiCost(profile, stream.value.usage, stream.value.reportedCostUsd),
      });
      if (hasEvidenceRequests) {
        if (providerOutput.data.decision !== null) {
          return invalidOutput(['decision must be null while evidence requests are pending']);
        }
        return ok({
          decision: null,
          evidenceRequests,
          stderr: execution.stderr,
          receipt,
        });
      }
      if (providerOutput.data.decision === null) {
        return invalidOutput(['decision is required when no evidence request is pending']);
      }

      const decision = ImplementationPlanningDecisionSchema.safeParse(
        normalizeProviderDecision(providerOutput.data.decision),
      );
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
