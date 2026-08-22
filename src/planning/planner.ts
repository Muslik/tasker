import { z } from 'zod';

import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  CompiledWorkflowArtifactSchema,
  compileSemanticWorkflow,
  SemanticWorkflowArtifactSchema,
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
    semantic: SemanticWorkflowArtifactSchema,
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
  const semanticResult = compileSemanticWorkflow({
    contracts: HARNESS_WORKFLOW_CONTRACTS,
    source: proposal.source,
    loopExhaustedWait: 'operator_guidance@1',
  });

  if (!semanticResult.ok) {
    return err({
      code: 'workflow_rejected',
      proposal,
      stage: 'workflow_validation',
      validatorReport: semanticResult.error,
    });
  }
  const compiled = semanticResult.value.compiled;

  const obligationReport = validateWorkflowObligations(compiled.graph, proposal.task);
  const policyIssues = [...obligationReport.issues];
  if (policyIssues.length > 0) {
    return err({
      code: 'workflow_rejected',
      proposal,
      stage: 'workflow_validation',
      validatorReport: {
        workflowId: compiled.graph.metadata.workflowId,
        issues: policyIssues,
      },
    });
  }

  const requiredCapabilities = requiredCapabilitiesFromCompiledGraph(
    proposal,
    compiled.graph.metadata.references.stepTypes,
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
      compiled,
      semantic: semanticResult.value,
      presentation: createWorkflowPresentation(compiled, proposal),
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
