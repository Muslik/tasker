import { z } from 'zod';

import { getHarnessPack } from '../harness/index.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import {
  JsonValueSchema,
  WorkflowSourceSchema,
  type JsonValue,
  type WorkflowNodeSource,
  type WorkflowSource,
} from '../workflow/index.js';
import { HARNESS_WORKFLOW_CONTRACTS } from './contracts.js';
import { PlanningTaskSnapshotSchema } from './task-snapshot.js';
import {
  VerificationPlanSchema,
  WorkflowAnalyzerOutputSchema,
  WorkflowAssemblyDecisionSchema,
} from './workflow-proposal-contracts.js';

export {
  VerificationPlanSchema,
  VerificationProfileSchema,
  WorkflowAnalyzerOutputSchema,
  WorkflowAssemblyDecisionSchema,
} from './workflow-proposal-contracts.js';
export type {
  WorkflowAnalyzerOutput,
  WorkflowAssemblyDecision,
} from './workflow-proposal-contracts.js';

export const ExpectedArtifactSchema = z
  .object({ kind: z.string().min(1), nodeId: z.string().min(1) })
  .strict();

export const WaitMetadataSchema = z
  .object({
    nodeId: z.string().min(1),
    resumeAt: z.string().min(1).optional(),
    waitKind: z.string().min(1),
  })
  .strict();

export const CapabilityMetadataSchema = z
  .object({
    available: z.array(z.string().min(1)),
    required: z.array(z.string().min(1)),
  })
  .strict();

export const AnalyzerVersionSchema = z.string().regex(/^[a-z][a-z0-9_-]*@[1-9]\d*$/u);

export const WorkflowProposalArtifactSchema = z
  .object({
    analyzerVersion: AnalyzerVersionSchema,
    assemblyDecisions: z.array(WorkflowAssemblyDecisionSchema).min(1),
    capabilities: CapabilityMetadataSchema,
    expectedArtifacts: z.array(ExpectedArtifactSchema),
    task: PlanningTaskSnapshotSchema,
    proposalSchemaVersion: z.literal(3),
    source: z.unknown(),
    verificationPlan: VerificationPlanSchema,
    waits: z.array(WaitMetadataSchema),
  })
  .strict();

export type WorkflowProposalArtifact = z.infer<typeof WorkflowProposalArtifactSchema>;
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
export type AnalyzeTaskFailure = ProposalInputFailure;

export const HARNESS_AVAILABLE_CAPABILITIES = Object.freeze([
  ...getHarnessPack().company.availableCapabilities,
]);

const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

const collectProposalMetadata = (source: WorkflowSource) => {
  const expectedArtifacts: ExpectedArtifact[] = [];
  const requiredCapabilities: string[] = [];
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
        visit(node.body);
        return;
      case 'step': {
        const contract = HARNESS_WORKFLOW_CONTRACTS.stepTypes.get(node.uses);
        if (contract !== undefined) {
          requiredCapabilities.push(...contract.requiredCapabilities);
          expectedArtifacts.push(
            ...contract.artifactContracts.map((kind) => ({ kind, nodeId: node.id })),
          );
        }
        return;
      }
      case 'wait':
        waits.push({
          nodeId: node.id,
          ...(node.resumeAt === undefined ? {} : { resumeAt: node.resumeAt }),
          waitKind: node.for,
        });
        return;
      case 'finalize':
      case 'gate':
        return;
    }
  };
  visit(source.root);
  return {
    expectedArtifacts: expectedArtifacts.sort((left, right) =>
      `${left.nodeId}:${left.kind}`.localeCompare(`${right.nodeId}:${right.kind}`),
    ),
    requiredCapabilities: sortedUnique(requiredCapabilities),
    waits: waits.sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
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

export const createWorkflowProposalFromAnalyzerOutput = (
  taskInput: unknown,
  analyzerVersion: string,
  outputInput: unknown,
): Outcome<WorkflowProposalArtifact, ProposalInputFailure> => {
  const task = PlanningTaskSnapshotSchema.safeParse(taskInput);
  if (!task.success) return err(toProposalInputFailure(task.error.issues));
  const output = WorkflowAnalyzerOutputSchema.safeParse(outputInput);
  if (!output.success) return err(toProposalInputFailure(output.error.issues));
  const source = WorkflowSourceSchema.safeParse(output.data.source);
  const metadata = source.success
    ? collectProposalMetadata(source.data)
    : { expectedArtifacts: [], requiredCapabilities: [], waits: [] };

  return parseWorkflowProposal({
    analyzerVersion,
    assemblyDecisions: output.data.assemblyDecisions,
    capabilities: {
      available: [...HARNESS_AVAILABLE_CAPABILITIES],
      required: metadata.requiredCapabilities,
    },
    expectedArtifacts: metadata.expectedArtifacts,
    task: task.data,
    proposalSchemaVersion: 3,
    source: output.data.source,
    verificationPlan: output.data.verificationPlan,
    waits: metadata.waits,
  });
};

export const proposalSourceAsJson = (proposal: WorkflowProposalArtifact): JsonValue | undefined => {
  const result = JsonValueSchema.safeParse(proposal.source);
  return result.success ? result.data : undefined;
};
