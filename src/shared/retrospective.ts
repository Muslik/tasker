import { z } from 'zod';

export const RetrospectiveFindingSchema = z
  .object({
    kind: z.string().min(1),
    title: z.string().min(1),
    detail: z.string().min(1),
    evidenceReferences: z.array(z.string().min(1)),
    stepReference: z.string().min(1).optional(),
  })
  .strict();

const RetrospectiveProposalBaseSchema = z
  .object({
    id: z.string().min(1),
    target: z.enum(['harness_rule', 'automation_script', 'process', 'local_reject']),
    title: z.string().min(1),
    rationale: z.string().min(1),
    generalityRationale: z.string().min(1),
    harnessFile: z.string().min(1).optional(),
    status: z.enum(['proposed', 'approved', 'dismissed']),
  })
  .strict();

export const RetrospectiveProposalSchema = RetrospectiveProposalBaseSchema;
export const RetrospectiveAnalyzerProposalSchema = RetrospectiveProposalBaseSchema.extend({
  status: z.literal('proposed'),
}).strict();

export const RetrospectiveAnalyzerOutputSchema = z
  .object({
    findings: z.array(RetrospectiveFindingSchema),
    proposals: z.array(RetrospectiveAnalyzerProposalSchema),
  })
  .strict();

export type RetrospectiveAnalyzerOutput = z.infer<typeof RetrospectiveAnalyzerOutputSchema>;
