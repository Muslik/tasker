import { z } from 'zod';

import type { CompiledWorkflowArtifact, CompiledWorkflowNode } from '../graph/index.js';
import type { WorkflowProposalArtifact } from './proposal.js';

const PresentationStatusSchema = z.literal('planned');

const BasePresentationShape = {
  id: z.string().min(1),
  label: z.string().min(1),
  status: PresentationStatusSchema,
} as const;

const SequencePresentationNodeSchema = z
  .object({
    ...BasePresentationShape,
    childIds: z.array(z.string().min(1)).min(1),
    kind: z.literal('sequence'),
  })
  .strict();

const StepPresentationNodeSchema = z
  .object({
    ...BasePresentationShape,
    expectedArtifacts: z.array(z.string().min(1)),
    kind: z.literal('step'),
    uses: z.string().min(1),
  })
  .strict();

const LoopPresentationNodeSchema = z
  .object({
    ...BasePresentationShape,
    bodyId: z.string().min(1),
    kind: z.literal('bounded_loop'),
    maxAttempts: z.number().int().positive(),
    until: z.string().min(1),
    exhaustedWait: z.string().min(1).optional(),
  })
  .strict();

const FinalizePresentationNodeSchema = z
  .object({
    ...BasePresentationShape,
    kind: z.literal('finalize'),
    outcome: z.string().min(1),
  })
  .strict();

export const PresentationNodeSchema = z.discriminatedUnion('kind', [
  LoopPresentationNodeSchema,
  FinalizePresentationNodeSchema,
  SequencePresentationNodeSchema,
  StepPresentationNodeSchema,
]);

export const WorkflowPresentationTreeSchema = z
  .object({
    nodeCount: z.number().int().positive(),
    nodes: z.record(z.string(), PresentationNodeSchema),
    rootId: z.string().min(1),
  })
  .strict();

export type PresentationNode = z.infer<typeof PresentationNodeSchema>;
export type WorkflowPresentationTree = z.infer<typeof WorkflowPresentationTreeSchema>;

export const createWorkflowPresentation = (
  compiled: CompiledWorkflowArtifact,
  proposal: WorkflowProposalArtifact,
): WorkflowPresentationTree => {
  const nodes: Record<string, PresentationNode> = {};
  const artifactsByNode = new Map<string, string[]>();

  for (const artifact of proposal.expectedArtifacts) {
    const artifacts = artifactsByNode.get(artifact.nodeId) ?? [];
    artifacts.push(artifact.kind);
    artifactsByNode.set(artifact.nodeId, artifacts);
  }

  const visit = (node: CompiledWorkflowNode): void => {
    switch (node.kind) {
      case 'sequence':
        nodes[node.id] = {
          childIds: node.children.map((child) => child.id),
          id: node.id,
          kind: 'sequence',
          label: node.id,
          status: 'planned',
        };
        node.children.forEach(visit);
        return;

      case 'step':
        nodes[node.id] = {
          expectedArtifacts: [...(artifactsByNode.get(node.id) ?? [])].sort((left, right) =>
            left.localeCompare(right),
          ),
          id: node.id,
          kind: 'step',
          label: node.id,
          status: 'planned',
          uses: node.uses,
        };
        return;

      case 'bounded_loop':
        nodes[node.id] = {
          bodyId: node.body.id,
          id: node.id,
          kind: 'bounded_loop',
          label: node.id,
          maxAttempts: node.maxAttempts,
          ...(node.exhaustedWait === undefined ? {} : { exhaustedWait: node.exhaustedWait }),
          status: 'planned',
          until: node.until,
        };
        visit(node.body);
        return;

      case 'finalize':
        nodes[node.id] = {
          id: node.id,
          kind: 'finalize',
          label: node.id,
          outcome: node.outcome,
          status: 'planned',
        };
        return;
    }
  };

  visit(compiled.graph.root);

  return WorkflowPresentationTreeSchema.parse({
    nodeCount: Object.keys(nodes).length,
    nodes,
    rootId: compiled.graph.root.id,
  });
};
