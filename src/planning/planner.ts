import { z } from 'zod';

import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  compileWorkflow,
  CompiledWorkflowArtifactSchema,
  ValidationReportSchema,
} from '../workflow/index.js';
import { M1_WORKFLOW_CONTRACTS } from './contracts.js';
import { createWorkflowDiff, GraphDiffArtifactSchema, type GraphDiffFailure } from './diff.js';
import { FixtureInputFailureSchema } from './fixtures.js';
import {
  analyzeTaskFixture,
  parseWorkflowProposal,
  ProposalInputFailureSchema,
  WorkflowProposalArtifactSchema,
  type WorkflowProposalArtifact,
} from './proposal.js';
import { createWorkflowPresentation, WorkflowPresentationTreeSchema } from './presentation.js';

const FixturePlanningFailureSchema = FixtureInputFailureSchema.extend({
  stage: z.literal('fixture'),
}).strict();

const ProposalPlanningFailureSchema = ProposalInputFailureSchema.extend({
  stage: z.literal('proposal'),
}).strict();

const WorkflowValidationFailureSchema = z
  .object({
    code: z.literal('workflow_rejected'),
    proposal: WorkflowProposalArtifactSchema,
    stage: z.literal('workflow_validation'),
    validatorReport: ValidationReportSchema,
  })
  .strict();

const CapabilityValidationFailureSchema = z
  .object({
    code: z.literal('unmet_capabilities'),
    missingCapabilities: z.array(z.string().min(1)).min(1),
    proposal: WorkflowProposalArtifactSchema,
    stage: z.literal('capability_validation'),
  })
  .strict();

const DiffPlanningFailureSchema = z
  .object({
    code: z.literal('graph_diff_failed'),
    proposal: WorkflowProposalArtifactSchema,
    side: z.enum(['task', 'template']),
    stage: z.literal('diff'),
  })
  .strict();

export const PlanningFailureSchema = z.discriminatedUnion('stage', [
  CapabilityValidationFailureSchema,
  DiffPlanningFailureSchema,
  FixturePlanningFailureSchema,
  ProposalPlanningFailureSchema,
  WorkflowValidationFailureSchema,
]);

export const PlannedWorkflowSchema = z
  .object({
    compiled: CompiledWorkflowArtifactSchema,
    diff: GraphDiffArtifactSchema,
    executionEligibility: z
      .object({
        reason: z.literal('m1_read_only'),
        status: z.literal('disabled'),
      })
      .strict(),
    presentation: WorkflowPresentationTreeSchema,
    proposal: WorkflowProposalArtifactSchema,
    status: z.literal('accepted'),
  })
  .strict();

export type PlanningFailure = z.infer<typeof PlanningFailureSchema>;
export type PlannedWorkflow = z.infer<typeof PlannedWorkflowSchema>;

const requiredCapabilitiesFromCompiledGraph = (
  proposal: WorkflowProposalArtifact,
  references: readonly string[],
): readonly string[] => {
  const capabilities = references.flatMap(
    (reference) => M1_WORKFLOW_CONTRACTS.stepTypes.get(reference)?.requiredCapabilities ?? [],
  );

  return [...new Set([...capabilities, ...proposal.capabilities.required])].sort((left, right) =>
    left.localeCompare(right),
  );
};

const toDiffFailure = (
  proposal: WorkflowProposalArtifact,
  failure: GraphDiffFailure,
): PlanningFailure => ({
  code: 'graph_diff_failed',
  proposal,
  side: failure.side,
  stage: 'diff',
});

export const planTaskWorkflow = (
  fixtureInput: unknown,
): Outcome<PlannedWorkflow, PlanningFailure> => {
  const proposalResult = analyzeTaskFixture(fixtureInput);

  if (!proposalResult.ok) {
    return proposalResult.error.code === 'invalid_fixture'
      ? err({ ...proposalResult.error, stage: 'fixture' })
      : err({ ...proposalResult.error, stage: 'proposal' });
  }

  return planParsedWorkflowProposal(proposalResult.value);
};

const planParsedWorkflowProposal = (
  proposal: WorkflowProposalArtifact,
): Outcome<PlannedWorkflow, PlanningFailure> => {
  const compiledResult = compileWorkflow({
    contracts: M1_WORKFLOW_CONTRACTS,
    source: proposal.source,
  });

  if (!compiledResult.ok) {
    return err({
      code: 'workflow_rejected',
      proposal,
      stage: 'workflow_validation',
      validatorReport: compiledResult.error,
    });
  }

  const requiredCapabilities = requiredCapabilitiesFromCompiledGraph(
    proposal,
    compiledResult.value.graph.metadata.references.stepTypes,
  );
  const available = new Set(proposal.capabilities.available);
  const missingCapabilities = requiredCapabilities.filter(
    (capability) => !available.has(capability),
  );

  if (missingCapabilities.length > 0) {
    return err({
      code: 'unmet_capabilities',
      missingCapabilities,
      proposal,
      stage: 'capability_validation',
    });
  }

  const diffResult = createWorkflowDiff({
    task: proposal.source,
    template: proposal.templateSource,
    templateId: proposal.templateId,
  });

  if (!diffResult.ok) {
    return err(toDiffFailure(proposal, diffResult.error));
  }

  return ok(
    PlannedWorkflowSchema.parse({
      compiled: compiledResult.value,
      diff: diffResult.value,
      executionEligibility: {
        reason: 'm1_read_only',
        status: 'disabled',
      },
      presentation: createWorkflowPresentation(compiledResult.value, proposal),
      proposal,
      status: 'accepted',
    }),
  );
};

export const planWorkflowProposal = (
  proposalInput: unknown,
): Outcome<PlannedWorkflow, PlanningFailure> => {
  const proposal = parseWorkflowProposal(proposalInput);
  return proposal.ok
    ? planParsedWorkflowProposal(proposal.value)
    : err({ ...proposal.error, stage: 'proposal' });
};
