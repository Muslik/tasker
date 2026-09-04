import { z } from 'zod';

import { WorkflowStageDescriptorSchema } from '../graph/contracts.js';
import { JsonValueSchema, OutputPredicateMappingSchema } from '../graph/schema.js';
import { SemanticExecutionRoleSchema } from '../graph/semantic-schema.js';
import { AgentInvocationUsageSchema } from '../steps/agent-usage.js';

const VersionedReferenceSchema = z.string().regex(/^[a-z][a-z0-9_.-]*@[1-9]\d*$/u);
const EvidenceReferenceSchema = z.string().min(1);

export const BlockStageSchema = WorkflowStageDescriptorSchema;

export const BlockExecutorSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('agent'),
      profile: z.string().min(1),
      strategyRole: SemanticExecutionRoleSchema.nullable(),
      prompt: z.string().min(1),
      skills: z.array(z.string().min(1)),
    })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal('process'), executor: VersionedReferenceSchema })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal('effect'), adapter: VersionedReferenceSchema })
    .strict()
    .readonly(),
]);

export const CompletionEvaluatorSchema: z.ZodType<CompletionEvaluator> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('structured_evidence'),
        source: z.enum(['task_output', 'workspace_files']),
        requiredArtifactKinds: z.array(z.string().min(1)).min(1),
      })
      .strict()
      .readonly(),
    z
      .object({
        kind: z.literal('process_receipt'),
        acceptance: z.enum(['zero', 'any_exit']),
      })
      .strict()
      .readonly(),
    z
      .object({ kind: z.literal('workspace_mutation') })
      .strict()
      .readonly(),
    z
      .object({ kind: z.literal('reconciled_effect') })
      .strict()
      .readonly(),
    z
      .object({ kind: z.literal('all'), evaluators: z.array(CompletionEvaluatorSchema).min(2) })
      .strict()
      .readonly(),
  ]),
);

export const BlockDefinitionSchema = z
  .object({
    schemaVersion: z.literal(3),
    reference: VersionedReferenceSchema,
    description: z.string().min(1),
    stage: BlockStageSchema,
    availableDuring: z
      .array(z.enum(['bootstrap_investigation', 'execution', 'retrospective']))
      .min(1),
    inputContract: z.string().min(1),
    outputContract: z.string().min(1),
    outputPredicates: OutputPredicateMappingSchema.optional(),
    executor: BlockExecutorSchema,
    allowedCapabilities: z.array(z.string().min(1)),
    allowedEffects: z.array(z.string().min(1)),
    outcomes: z
      .array(z.enum(['completed', 'needs_input', 'continuation_required', 'blocked', 'failed']))
      .min(1),
    completion: CompletionEvaluatorSchema,
    requiredArtifacts: z.array(z.string().min(1)),
    producedArtifacts: z.array(z.string().min(1)),
  })
  .strict()
  .readonly();

export const AgentQuestionSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    whyBlocking: z.string().min(1),
  })
  .strict()
  .readonly();

export const AgentClaimCategorySchema = z.enum([
  'authorization',
  'infrastructure',
  'task_ambiguity',
  'dependency',
  'agent_contract',
]);

export const AgentClaimSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('candidate_complete'),
      summary: z.string().min(1),
      output: JsonValueSchema,
      evidenceReferences: z.array(EvidenceReferenceSchema),
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal('needs_input'),
      summary: z.string().min(1),
      waitKind: z.string().min(1),
      questions: z.array(AgentQuestionSchema).min(1).max(10),
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal('continuation_required'),
      summary: z.string().min(1),
      requestReference: EvidenceReferenceSchema,
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal('blocked'),
      summary: z.string().min(1),
      waitKind: z.string().min(1),
      category: AgentClaimCategorySchema,
      retryable: z.boolean(),
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal('failed'),
      summary: z.string().min(1),
      category: AgentClaimCategorySchema,
      retryable: z.boolean(),
    })
    .strict()
    .readonly(),
]);

export const CompletionEvidenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('artifact'),
      reference: EvidenceReferenceSchema,
      artifactKind: z.string().min(1),
      contentHash: z.string().min(1),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('process'),
      reference: EvidenceReferenceSchema,
      exitCode: z.number().int(),
      outputHash: z.string().min(1),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('workspace_mutation'),
      reference: EvidenceReferenceSchema,
      changed: z.boolean(),
      fingerprint: z.string().min(1),
      trackedDiffSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .optional(),
      changedPaths: z
        .array(
          z
            .object({ status: z.string().length(2), path: z.string().min(1) })
            .strict()
            .readonly(),
        )
        .optional(),
      changedPathsTruncated: z.boolean().optional(),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('effect'),
      reference: EvidenceReferenceSchema,
      reconciled: z.boolean(),
      remoteIdentity: z.string().min(1),
    })
    .strict()
    .readonly(),
]);

export const CompletionVerdictSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('accepted'),
      evidenceReferences: z.array(EvidenceReferenceSchema).min(1),
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal('rejected'),
      reasons: z.array(z.string().min(1)).min(1),
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal('waiting'),
      waitKind: z.string().min(1),
      summary: z.string().min(1),
    })
    .strict()
    .readonly(),
]);

export const BlockReceiptSchema = z
  .object({
    schemaVersion: z.literal(7),
    receiptId: z.string().min(1),
    blockReference: VersionedReferenceSchema,
    blockDefinitionHash: z.string().min(1),
    taskReference: z.string().min(1),
    workflowId: z.string().min(1),
    workflowRunId: z.string().min(1),
    workflowHash: z.string().min(1),
    nodeId: z.string().min(1),
    blockRun: z.number().int().positive(),
    claim: AgentClaimSchema,
    verdict: CompletionVerdictSchema,
    predicateFacts: z.record(z.string().min(1), z.boolean()),
    evidence: z.array(CompletionEvidenceSchema),
    transcriptReference: z.string().min(1).nullable(),
    usageReference: z.string().min(1).nullable(),
    usage: AgentInvocationUsageSchema.nullable(),
    completedAt: z.iso.datetime(),
  })
  .strict()
  .readonly();

export type CompletionEvaluator =
  | {
      readonly kind: 'structured_evidence';
      readonly source: 'task_output' | 'workspace_files';
      readonly requiredArtifactKinds: readonly string[];
    }
  | { readonly kind: 'process_receipt'; readonly acceptance: 'zero' | 'any_exit' }
  | { readonly kind: 'workspace_mutation' }
  | { readonly kind: 'reconciled_effect' }
  | { readonly kind: 'all'; readonly evaluators: readonly CompletionEvaluator[] };

export type BlockDefinition = z.infer<typeof BlockDefinitionSchema>;
export type AgentClaim = z.infer<typeof AgentClaimSchema>;
export type AgentClaimCategory = z.infer<typeof AgentClaimCategorySchema>;
export type CompletionEvidence = z.infer<typeof CompletionEvidenceSchema>;
export type CompletionVerdict = z.infer<typeof CompletionVerdictSchema>;
export type BlockReceipt = z.infer<typeof BlockReceiptSchema>;
