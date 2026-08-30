import { z } from 'zod';

export const ResearchDocumentReviewAnnotationSchema = z
  .object({
    quote: z.string().min(1).max(500),
    note: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const ApproveResearchDocumentReviewResolutionSchema = z
  .object({
    decision: z.literal('approve'),
  })
  .strict();

export const RequestResearchDocumentChangesResolutionSchema = z
  .object({
    decision: z.literal('request_changes'),
    guidance: z.string().trim().min(1).max(10_000).optional(),
    annotations: z.array(ResearchDocumentReviewAnnotationSchema).max(50),
  })
  .strict()
  .refine(
    (resolution) => resolution.guidance !== undefined || resolution.annotations.length > 0,
    'Research document review requires guidance or at least one annotation',
  );

export const ResearchDocumentReviewResolutionSchema = z.discriminatedUnion('decision', [
  ApproveResearchDocumentReviewResolutionSchema,
  RequestResearchDocumentChangesResolutionSchema,
]);

export const ResearchDocumentReviewWaitDetailsSchema = z
  .object({
    kind: z.literal('research_document_review'),
    documentArtifactId: z.string().min(1),
    documentStorageHtml: z.string().min(1),
  })
  .strict();

export const ResearchDocumentReviewOutputSchema = z
  .object({
    decision: z.enum(['approved', 'changes_requested']),
    documentArtifactId: z.string().min(1),
  })
  .strict();

export type ResearchDocumentReviewAnnotation = z.infer<
  typeof ResearchDocumentReviewAnnotationSchema
>;
export type ApproveResearchDocumentReviewResolution = z.infer<
  typeof ApproveResearchDocumentReviewResolutionSchema
>;
export type RequestResearchDocumentChangesResolution = z.infer<
  typeof RequestResearchDocumentChangesResolutionSchema
>;
export type ResearchDocumentReviewResolution = z.infer<
  typeof ResearchDocumentReviewResolutionSchema
>;
export type ResearchDocumentReviewWaitDetails = z.infer<
  typeof ResearchDocumentReviewWaitDetailsSchema
>;
export type ResearchDocumentReviewOutput = z.infer<typeof ResearchDocumentReviewOutputSchema>;
