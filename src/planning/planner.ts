import { z } from 'zod';

import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  compileWorkflow,
  CompiledWorkflowArtifactSchema,
  ValidationReportSchema,
  type CompiledWorkflow,
  type ValidationReport,
} from '../workflow/index.js';
import { M1_WORKFLOW_CONTRACTS } from './contracts.js';
import { FixtureInputFailureSchema } from './fixtures.js';
import { validateWorkflowObligations } from './obligations.js';
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

export const PlanningFailureSchema = z.discriminatedUnion('stage', [
  CapabilityValidationFailureSchema,
  FixturePlanningFailureSchema,
  ProposalPlanningFailureSchema,
  WorkflowValidationFailureSchema,
]);

export const PlannedWorkflowSchema = z
  .object({
    compiled: CompiledWorkflowArtifactSchema,
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

const validateRequiredPlanningBoundary = (graph: CompiledWorkflow): ValidationReport => {
  const first = graph.root.kind === 'sequence' ? graph.root.children[0] : undefined;
  const second = graph.root.kind === 'sequence' ? graph.root.children[1] : undefined;
  const valid =
    first?.kind === 'step' &&
    first.uses === 'task.analyze@1' &&
    second?.kind === 'gate' &&
    second.resumeWhen === 'plan.approved@1';

  return {
    workflowId: graph.metadata.workflowId,
    issues: valid
      ? []
      : [
          {
            code: 'required_planning_boundary_missing',
            message:
              'Task workflows must begin with task.analyze@1 followed by the plan.approved@1 gate',
            path: ['root'],
          },
        ],
  };
};

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

  const planningBoundaryReport = validateRequiredPlanningBoundary(compiledResult.value.graph);
  const obligationReport = validateWorkflowObligations(
    compiledResult.value.graph,
    proposal.fixture,
  );
  const policyIssues = [...planningBoundaryReport.issues, ...obligationReport.issues];
  if (policyIssues.length > 0) {
    return err({
      code: 'workflow_rejected',
      proposal,
      stage: 'workflow_validation',
      validatorReport: {
        workflowId: compiledResult.value.graph.metadata.workflowId,
        issues: policyIssues,
      },
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

  return ok(
    PlannedWorkflowSchema.parse({
      compiled: compiledResult.value,
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
