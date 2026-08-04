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
  const children = graph.root.kind === 'sequence' ? graph.root.children : [];
  const analyzerIndexes = children.flatMap((node, index) =>
    node.kind === 'step' && node.uses === 'task.analyze@1' ? [index] : [],
  );
  const analyzerIndex = analyzerIndexes[0];
  const next = analyzerIndex === undefined ? undefined : children[analyzerIndex + 1];
  const gateIndex = analyzerIndex === undefined ? -1 : analyzerIndex + 1;
  const containsProductWrite = (node: CompiledWorkflow['root']): boolean => {
    switch (node.kind) {
      case 'step':
        return (
          M1_WORKFLOW_CONTRACTS.stepTypes
            .get(node.uses)
            ?.allowedEffects.includes('workspace.write') === true
        );
      case 'sequence':
        return node.children.some(containsProductWrite);
      case 'branch':
        return containsProductWrite(node.then) || containsProductWrite(node.otherwise);
      case 'bounded_loop':
        return containsProductWrite(node.body);
      case 'finalize':
      case 'gate':
      case 'wait':
        return false;
    }
  };
  const productWriteBeforePlan =
    gateIndex >= 0 && children.slice(0, gateIndex).some(containsProductWrite);
  const valid =
    analyzerIndexes.length === 1 &&
    next?.kind === 'gate' &&
    next.resumeWhen === 'plan.approved@1' &&
    !productWriteBeforePlan;

  return {
    workflowId: graph.metadata.workflowId,
    issues: valid
      ? []
      : [
          {
            code: 'required_planning_boundary_missing',
            message:
              'Task workflows must contain exactly one task.analyze@1 immediately followed by the plan.approved@1 gate',
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
