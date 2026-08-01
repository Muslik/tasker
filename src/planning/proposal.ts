import { z } from 'zod';

import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  JsonValueSchema,
  WorkflowSourceSchema,
  type JsonValue,
  type WorkflowNodeSource,
  type WorkflowSource,
} from '../workflow/index.js';
import { getStepRetryBudget, M1_WORKFLOW_CONTRACTS } from './contracts.js';
import {
  FixtureInputFailureSchema,
  parseTaskFixture,
  TaskFixtureSchema,
  type FixtureInputFailure,
  type TaskFixture,
} from './fixtures.js';
import {
  getBaseWorkflowTemplate,
  materializeTaskWorkflow,
  selectWorkflowTemplate,
  WorkflowTemplateIdSchema,
} from './templates.js';
import {
  resolvePackagePublicationPolicy,
  resolveProjectWorkflowProfile,
} from './project-policies.js';

export const VerificationProfileSchema = z.enum([
  'full',
  'full_with_visual',
  'targeted',
  'translation_and_targeted',
]);

export const VerificationPlanSchema = z
  .object({
    checks: z.array(z.string().min(1)).min(1),
    profile: VerificationProfileSchema,
    rationale: z.string().min(1),
  })
  .strict();

export const RetryBudgetSchema = z
  .object({
    maxAttempts: z.number().int().nonnegative(),
    nodeId: z.string().min(1),
    scope: z.enum(['loop', 'step']),
  })
  .strict();

export const ExpectedArtifactSchema = z
  .object({
    kind: z.string().min(1),
    nodeId: z.string().min(1),
  })
  .strict();

export const WaitMetadataSchema = z
  .object({
    nodeId: z.string().min(1),
    resumeAt: z.string().min(1).optional(),
    slotPolicy: z.enum(['release', 'retain']),
    waitKind: z.string().min(1),
  })
  .strict();

export const CapabilityMetadataSchema = z
  .object({
    available: z.array(z.string().min(1)),
    required: z.array(z.string().min(1)),
  })
  .strict();

export const WorkflowAssemblyDecisionSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    source: z.string().min(1),
    reason: z.string().min(1),
    effect: z.string().min(1),
  })
  .strict();

export const WorkflowAnalyzerOutputSchema = z
  .object({
    assemblyDecisions: z.array(WorkflowAssemblyDecisionSchema).min(1),
    source: WorkflowSourceSchema,
    verificationPlan: VerificationPlanSchema,
  })
  .strict();

export const AnalyzerVersionSchema = z.string().regex(/^[a-z][a-z0-9_-]*@[1-9]\d*$/u);

export const WorkflowProposalArtifactSchema = z
  .object({
    analyzerVersion: AnalyzerVersionSchema,
    assemblyDecisions: z.array(WorkflowAssemblyDecisionSchema).min(1),
    capabilities: CapabilityMetadataSchema,
    expectedArtifacts: z.array(ExpectedArtifactSchema),
    fixture: TaskFixtureSchema,
    proposalSchemaVersion: z.literal(1),
    retryBudgets: z.array(RetryBudgetSchema),
    source: z.unknown(),
    templateId: WorkflowTemplateIdSchema,
    templateSource: WorkflowSourceSchema,
    verificationPlan: VerificationPlanSchema,
    waits: z.array(WaitMetadataSchema),
  })
  .strict();

export type WorkflowProposalArtifact = z.infer<typeof WorkflowProposalArtifactSchema>;
export type WorkflowAnalyzerOutput = z.infer<typeof WorkflowAnalyzerOutputSchema>;
export type RetryBudget = z.infer<typeof RetryBudgetSchema>;
export type ExpectedArtifact = z.infer<typeof ExpectedArtifactSchema>;
export type WaitMetadata = z.infer<typeof WaitMetadataSchema>;
export type WorkflowAssemblyDecision = z.infer<typeof WorkflowAssemblyDecisionSchema>;

const ProposalInputIssueSchema = z
  .object({
    message: z.string().min(1),
    path: z.array(z.union([z.string(), z.number()])),
  })
  .strict();

export const ProposalInputFailureSchema = z
  .object({
    code: z.literal('invalid_proposal'),
    issues: z.array(ProposalInputIssueSchema).min(1),
  })
  .strict();

export type ProposalInputFailure = z.infer<typeof ProposalInputFailureSchema>;
export type AnalyzeTaskFailure = FixtureInputFailure | ProposalInputFailure;

export const M1_AVAILABLE_CAPABILITIES = Object.freeze([
  'command.run',
  'git.write',
  'package.publish',
  'repository.read',
  'workspace.write',
]);

const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

interface ProposalMetadata {
  readonly expectedArtifacts: readonly ExpectedArtifact[];
  readonly requiredCapabilities: readonly string[];
  readonly retryBudgets: readonly RetryBudget[];
  readonly waits: readonly WaitMetadata[];
}

const collectProposalMetadata = (source: WorkflowSource): ProposalMetadata => {
  const expectedArtifacts: ExpectedArtifact[] = [];
  const requiredCapabilities: string[] = [];
  const retryBudgets: RetryBudget[] = [];
  const waits: WaitMetadata[] = [];

  const visit = (node: WorkflowNodeSource): void => {
    switch (node.kind) {
      case 'sequence':
        node.children.forEach(visit);
        return;

      case 'branch':
        visit(node.then);
        visit(node.otherwise);
        return;

      case 'bounded_loop':
        retryBudgets.push({
          maxAttempts: node.maxAttempts,
          nodeId: node.id,
          scope: 'loop',
        });
        visit(node.body);
        return;

      case 'step': {
        const contract = M1_WORKFLOW_CONTRACTS.stepTypes.get(node.uses);
        const retryBudget = getStepRetryBudget(node.uses);

        if (contract !== undefined) {
          requiredCapabilities.push(...contract.requiredCapabilities);
          expectedArtifacts.push(
            ...contract.artifactContracts.map((kind) => ({ kind, nodeId: node.id })),
          );
        }

        if (retryBudget !== undefined) {
          retryBudgets.push({
            maxAttempts: retryBudget,
            nodeId: node.id,
            scope: 'step',
          });
        }

        return;
      }

      case 'wait': {
        const contract = M1_WORKFLOW_CONTRACTS.waits.get(node.for);
        waits.push({
          nodeId: node.id,
          ...(node.resumeAt === undefined ? {} : { resumeAt: node.resumeAt }),
          slotPolicy: node.slotPolicy ?? contract?.slotPolicy ?? 'retain',
          waitKind: node.for,
        });
        return;
      }

      case 'finalize':
      case 'gate':
        return;
    }
  };

  visit(source.root);

  const byNodeAndKind = <T extends { readonly kind?: string; readonly nodeId: string }>(
    left: T,
    right: T,
  ): number => {
    const nodeOrder = left.nodeId.localeCompare(right.nodeId);
    return nodeOrder === 0 ? (left.kind ?? '').localeCompare(right.kind ?? '') : nodeOrder;
  };

  return {
    expectedArtifacts: expectedArtifacts.sort(byNodeAndKind),
    requiredCapabilities: sortedUnique(requiredCapabilities),
    retryBudgets: retryBudgets.sort((left, right) => {
      const nodeOrder = left.nodeId.localeCompare(right.nodeId);
      return nodeOrder === 0 ? left.scope.localeCompare(right.scope) : nodeOrder;
    }),
    waits: waits.sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
  };
};

const createVerificationPlan = (fixture: TaskFixture): z.infer<typeof VerificationPlanSchema> => {
  switch (fixture.family) {
    case 'short_bugfix':
      return {
        checks: ['reproduction evidence', 'targeted tests for changed behavior'],
        profile: 'targeted',
        rationale:
          'A localized bug fix needs proof of reproduction and focused regression coverage.',
      };

    case 'feature_with_review':
      return fixture.verification === 'full_with_visual'
        ? {
            checks: ['full test suite', 'visual comparison of affected screens'],
            profile: 'full_with_visual',
            rationale: 'The feature spans a booking flow and changes visible frontend behavior.',
          }
        : {
            checks: ['full test suite'],
            profile: 'full',
            rationale: 'The feature spans multiple behaviors, so targeted checks are insufficient.',
          };

    case 'shared_component': {
      const profile = resolveProjectWorkflowProfile(fixture.componentRepository);
      const includesExternalTranslation =
        fixture.translationIntent === 'copy_change' && profile.translations.kind === 'external';

      return includesExternalTranslation
        ? {
            checks: ['translation resources pulled', 'targeted consumer tests'],
            profile: 'translation_and_targeted',
            rationale:
              'The component project uses external translation, which must resolve before consumer checks.',
          }
        : {
            checks: ['targeted component and consumer tests'],
            profile: 'targeted',
            rationale:
              'The shared-component change needs focused checks in the component and its consumer.',
          };
    }
  }
};

const createAssemblyDecisions = (fixture: TaskFixture): readonly WorkflowAssemblyDecision[] => {
  const decisions: WorkflowAssemblyDecision[] = [
    {
      id: 'task-family',
      title: 'Workflow family selected',
      source: 'task-snapshot',
      reason: `The intake classified this task as ${fixture.family}.`,
      effect:
        fixture.family === 'short_bugfix'
          ? 'Start from the short bugfix flow with mandatory reproduction.'
          : 'Start from the feature-with-review flow and specialize it for this task.',
    },
    {
      id: 'bounded-repair',
      title: 'Repair work is bounded',
      source: 'global:bounded-repair',
      reason: 'An unsuccessful implementation attempt must not loop forever.',
      effect: 'The implementation loop is capped at three attempts before intervention.',
    },
  ];

  switch (fixture.family) {
    case 'short_bugfix':
      decisions.push({
        id: 'reproduction-required',
        title: 'Reproduction required',
        source: 'task-snapshot',
        reason: 'The task is a bug and the fixture requires reproduction evidence.',
        effect: 'Add reproduce-bug before implementation and targeted verification.',
      });
      break;

    case 'feature_with_review':
      decisions.push({
        id: 'plan-review',
        title: 'Plan review policy evaluated',
        source: 'task-snapshot',
        reason: `The task plan-review policy is ${fixture.planReview}.`,
        effect:
          fixture.planReview === 'always'
            ? 'Insert a human plan-approval gate before implementation.'
            : 'Continue automatically unless the analyzer raises a question.',
      });
      break;

    case 'shared_component':
      decisions.push({
        id: 'cross-repository-component',
        title: 'Shared component work detected',
        source: 'task-snapshot',
        reason: `The change belongs partly to ${fixture.componentRepository}.`,
        effect: 'Implement the component in its repository before updating the consumer.',
      });
      break;
  }

  if (fixture.translationIntent === 'copy_change') {
    const targetRepository =
      fixture.family === 'shared_component' ? fixture.componentRepository : fixture.repository;
    const profile = resolveProjectWorkflowProfile(targetRepository);

    decisions.push(
      profile.translations.kind === 'external'
        ? {
            id: 'translation-policy',
            title: 'External translation policy applied',
            source: `project:${targetRepository}`,
            reason: `${targetRepository} is configured to synchronize copy through an external translator.`,
            effect:
              'Add extract and pull commands with a durable translation wait that releases the runner slot.',
          }
        : {
            id: 'translation-policy',
            title: 'Inline translation policy applied',
            source:
              profile.source === 'configured' ? `project:${targetRepository}` : 'project:default',
            reason:
              profile.source === 'configured'
                ? `${targetRepository} is configured to keep copy directly in source or locale JSON.`
                : `${targetRepository} has no project-specific translation flow, so the safe default keeps copy in source or locale JSON.`,
            effect: 'Keep copy changes inside implementation; add no translation commands or wait.',
          },
    );
  }

  if (fixture.family === 'shared_component') {
    const publication = resolvePackagePublicationPolicy(
      fixture.componentRepository,
      fixture.componentPath,
    );
    decisions.push(
      publication.kind === 'human_final'
        ? {
            id: 'publication-policy',
            title: 'Global package publication policy applied',
            source: `global:${publication.policyId}`,
            reason: `${publication.policyId} matched ${fixture.componentPath} in ${fixture.componentRepository}.`,
            effect:
              'Create a development publish, then persist a final-publish wait before consuming the supplied version.',
          }
        : {
            id: 'publication-policy',
            title: 'No package publication required',
            source: 'global:default',
            reason: `No global package rule matched ${fixture.componentPath} in ${fixture.componentRepository}.`,
            effect: 'Add no publish commands or publication wait.',
          },
    );
  }

  decisions.push({
    id: 'verification-profile',
    title: 'Verification profile selected',
    source: 'task-snapshot',
    reason: createVerificationPlan(fixture).rationale,
    effect: `Use the ${createVerificationPlan(fixture).profile} verification profile.`,
  });
  decisions.push({
    id: 'code-review-wait',
    title: 'Human code review retained',
    source: 'global:code-review',
    reason: 'Every task that prepares a PR must stop for operator review.',
    effect: 'End the autonomous delivery phase at the code-review wait.',
  });

  return decisions;
};

const replaceRootChildren = (
  source: WorkflowSource,
  update: (children: readonly WorkflowNodeSource[]) => unknown,
): unknown => {
  if (source.root.kind !== 'sequence') {
    return source;
  }

  return {
    ...source,
    root: {
      ...source.root,
      children: update(source.root.children),
    },
  };
};

const applyRejectedVariant = (fixture: TaskFixture, source: WorkflowSource): unknown => {
  if (fixture.expected === 'accepted') {
    return source;
  }

  switch (fixture.proposalVariant) {
    case 'unknown_step':
      return replaceRootChildren(source, (children) => [
        {
          id: 'unknown-step',
          kind: 'step',
          uses: 'provider.does_not_exist@1',
          with: {},
        },
        ...children.slice(1),
      ]);

    case 'missing_terminal':
      return replaceRootChildren(source, (children) =>
        children.filter((child) => child.kind !== 'finalize'),
      );

    case 'unsafe_effect':
      return replaceRootChildren(source, (children) => {
        const terminalIndex = children.findIndex((child) => child.kind === 'finalize');
        const unsafeStep: WorkflowNodeSource = {
          id: 'unsafe-remote-write',
          kind: 'step',
          uses: 'unsafe.effect@1',
          with: {
            objective: fixture.description,
            repository: fixture.repository,
            taskId: fixture.taskId,
          },
        };

        if (terminalIndex < 0) {
          return [...children, unsafeStep];
        }

        return [...children.slice(0, terminalIndex), unsafeStep, ...children.slice(terminalIndex)];
      });

    case 'unbounded_loop':
      return replaceRootChildren(source, (children) =>
        children.map((child) =>
          child.kind === 'bounded_loop'
            ? {
                body: child.body,
                id: child.id,
                kind: child.kind,
                until: child.until,
              }
            : child,
        ),
      );

    case 'unmet_capability':
      return source;
  }
};

const toProposalCandidate = (fixture: TaskFixture): unknown => {
  const validSource = materializeTaskWorkflow(fixture);
  return proposalCandidateFromParts(fixture, 'm1-deterministic@1', {
    assemblyDecisions: createAssemblyDecisions(fixture),
    source: applyRejectedVariant(fixture, validSource),
    verificationPlan: createVerificationPlan(fixture),
  });
};

const proposalCandidateFromParts = (
  fixture: TaskFixture,
  analyzerVersion: string,
  parts: {
    readonly assemblyDecisions: readonly WorkflowAssemblyDecision[];
    readonly source: unknown;
    readonly verificationPlan: z.infer<typeof VerificationPlanSchema>;
  },
): unknown => {
  const templateId = selectWorkflowTemplate(fixture);
  const parsedSource = WorkflowSourceSchema.safeParse(parts.source);
  const metadata = parsedSource.success
    ? collectProposalMetadata(parsedSource.data)
    : {
        expectedArtifacts: [],
        requiredCapabilities: [],
        retryBudgets: [],
        waits: [],
      };
  const available =
    fixture.expected === 'rejected' && fixture.proposalVariant === 'unmet_capability'
      ? M1_AVAILABLE_CAPABILITIES.filter((capability) => capability !== 'repository.read')
      : M1_AVAILABLE_CAPABILITIES;

  return {
    analyzerVersion,
    assemblyDecisions: parts.assemblyDecisions,
    capabilities: {
      available: [...available],
      required: [...metadata.requiredCapabilities],
    },
    expectedArtifacts: metadata.expectedArtifacts,
    fixture,
    proposalSchemaVersion: 1,
    retryBudgets: metadata.retryBudgets,
    source: parts.source,
    templateId,
    templateSource: getBaseWorkflowTemplate(templateId),
    verificationPlan: parts.verificationPlan,
    waits: metadata.waits,
  };
};

const toProposalInputFailure = (issues: z.core.$ZodIssue[]): ProposalInputFailure => ({
  code: 'invalid_proposal',
  issues: issues.map((issue) => ({
    message: issue.message,
    path: issue.path.filter(
      (segment): segment is number | string =>
        typeof segment === 'number' || typeof segment === 'string',
    ),
  })),
});

export const parseWorkflowProposal = (
  input: unknown,
): Outcome<WorkflowProposalArtifact, ProposalInputFailure> => {
  const result = WorkflowProposalArtifactSchema.safeParse(input);

  return result.success ? ok(result.data) : err(toProposalInputFailure(result.error.issues));
};

export const analyzeTaskFixture = (
  input: unknown,
): Outcome<WorkflowProposalArtifact, AnalyzeTaskFailure> => {
  const fixtureResult = parseTaskFixture(input);

  if (!fixtureResult.ok) {
    return err(FixtureInputFailureSchema.parse(fixtureResult.error));
  }

  // The analyzer is an untrusted boundary even while M1 uses a deterministic local implementation.
  const untrustedProposal: unknown = toProposalCandidate(fixtureResult.value);
  return parseWorkflowProposal(untrustedProposal);
};

export const createWorkflowProposalFromAnalyzerOutput = (
  fixtureInput: unknown,
  analyzerVersion: string,
  outputInput: unknown,
): Outcome<WorkflowProposalArtifact, AnalyzeTaskFailure> => {
  const fixtureResult = parseTaskFixture(fixtureInput);
  if (!fixtureResult.ok) {
    return err(FixtureInputFailureSchema.parse(fixtureResult.error));
  }

  const output = WorkflowAnalyzerOutputSchema.safeParse(outputInput);
  if (!output.success) {
    return err(toProposalInputFailure(output.error.issues));
  }

  return parseWorkflowProposal(
    proposalCandidateFromParts(fixtureResult.value, analyzerVersion, output.data),
  );
};

export const proposalSourceAsJson = (proposal: WorkflowProposalArtifact): JsonValue | undefined => {
  const result = JsonValueSchema.safeParse(proposal.source);
  return result.success ? result.data : undefined;
};
