import { z } from 'zod';

import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  compileWorkflow,
  CompiledWorkflowArtifactSchema,
  ValidationReportSchema,
} from '../workflow/index.js';
import { HARNESS_WORKFLOW_CONTRACTS } from './contracts.js';
import { validateWorkflowObligations } from './obligations.js';
import {
  parseWorkflowProposal,
  ProposalInputFailureSchema,
  WorkflowProposalArtifactSchema,
  type WorkflowProposalArtifact,
} from './proposal.js';
import { createWorkflowPresentation, WorkflowPresentationTreeSchema } from './presentation.js';

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
  ProposalPlanningFailureSchema,
  WorkflowValidationFailureSchema,
]);

export const PlannedWorkflowSchema = z
  .object({
    compiled: CompiledWorkflowArtifactSchema,
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
    (reference) => HARNESS_WORKFLOW_CONTRACTS.stepTypes.get(reference)?.requiredCapabilities ?? [],
  );

  return [...new Set([...capabilities, ...proposal.capabilities.required])].sort((left, right) =>
    left.localeCompare(right),
  );
};

const planParsedWorkflowProposal = (
  proposal: WorkflowProposalArtifact,
): Outcome<PlannedWorkflow, PlanningFailure> => {
  const compiledResult = compileWorkflow({
    contracts: HARNESS_WORKFLOW_CONTRACTS,
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

  const obligationReport = validateWorkflowObligations(compiledResult.value.graph, proposal.task);
  const policyIssues = [...obligationReport.issues];
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
