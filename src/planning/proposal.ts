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

export const WorkflowProposalArtifactSchema = z
  .object({
    analyzerVersion: z.literal('m1-deterministic@1'),
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
export type RetryBudget = z.infer<typeof RetryBudgetSchema>;
export type ExpectedArtifact = z.infer<typeof ExpectedArtifactSchema>;
export type WaitMetadata = z.infer<typeof WaitMetadataSchema>;

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

const availableCapabilities = Object.freeze([
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

    case 'translation_cross_repo':
      return {
        checks: ['translation resources pulled', 'targeted consumer tests'],
        profile: 'translation_and_targeted',
        rationale:
          'External translation and package publication must resolve before consumer checks.',
      };
  }
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
  const templateId = selectWorkflowTemplate(fixture);
  const metadata = collectProposalMetadata(validSource);
  const available =
    fixture.expected === 'rejected' && fixture.proposalVariant === 'unmet_capability'
      ? availableCapabilities.filter((capability) => capability !== 'repository.read')
      : availableCapabilities;

  return {
    analyzerVersion: 'm1-deterministic@1',
    capabilities: {
      available: [...available],
      required: [...metadata.requiredCapabilities],
    },
    expectedArtifacts: metadata.expectedArtifacts,
    fixture,
    proposalSchemaVersion: 1,
    retryBudgets: metadata.retryBudgets,
    source: applyRejectedVariant(fixture, validSource),
    templateId,
    templateSource: getBaseWorkflowTemplate(templateId),
    verificationPlan: createVerificationPlan(fixture),
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

export const proposalSourceAsJson = (proposal: WorkflowProposalArtifact): JsonValue | undefined => {
  const result = JsonValueSchema.safeParse(proposal.source);
  return result.success ? result.data : undefined;
};
