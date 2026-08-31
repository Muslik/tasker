import { z } from 'zod';

import {
  ApproveResearchDocumentReviewResolutionSchema,
  RequestResearchDocumentChangesResolutionSchema,
  ResearchDocumentReviewWaitDetailsSchema,
  type RequestResearchDocumentChangesResolution,
  type ResearchDocumentReviewAnnotation,
  type ResearchDocumentReviewResolution,
  type ResearchDocumentReviewWaitDetails,
} from '../shared/research-document-review.js';

const RESEARCH_DOCUMENT_REVIEW_GUIDANCE_LIMIT = 10_000;

const PlannerGuidanceAnnotationSchema = z
  .object({
    quote: z.string().min(1).max(500),
    note: z.string().trim().min(1).max(2_000),
  })
  .strict();

const PlannerGuidanceSchema = z
  .object({
    guidance: z.string().trim().min(1).max(RESEARCH_DOCUMENT_REVIEW_GUIDANCE_LIMIT).optional(),
    annotations: z.array(PlannerGuidanceAnnotationSchema).max(50),
  })
  .strict();

const renderAnnotation = (annotation: z.infer<typeof PlannerGuidanceAnnotationSchema>): string =>
  `«Фрагмент: "${annotation.quote}" — ${annotation.note}»`;

const capGuidance = (value: string): string =>
  value.slice(0, RESEARCH_DOCUMENT_REVIEW_GUIDANCE_LIMIT);

type ResearchDocumentReviewResolutionInput =
  | { readonly decision: 'approve' }
  | {
      readonly decision: 'request_changes';
      readonly guidance?: string;
      readonly annotations: readonly ResearchDocumentReviewAnnotation[];
    };

export const combinePlannerGuidance = (guidanceValue: z.input<typeof PlannerGuidanceSchema>) => {
  const guidance = PlannerGuidanceSchema.parse(guidanceValue);
  return capGuidance(
    [
      ...(guidance.guidance === undefined ? [] : [guidance.guidance]),
      ...guidance.annotations.map(renderAnnotation),
    ].join('\n\n'),
  );
};

export const combineResearchDocumentReviewGuidance = (
  resolutionValue: RequestResearchDocumentChangesResolution,
): string => {
  const resolution = RequestResearchDocumentChangesResolutionSchema.parse(resolutionValue);
  return combinePlannerGuidance({
    annotations: resolution.annotations,
    ...(resolution.guidance === undefined ? {} : { guidance: resolution.guidance }),
  });
};

export const normalizeResearchDocumentReviewResolution = (
  resolutionValue: ResearchDocumentReviewResolutionInput,
): ResearchDocumentReviewResolution => {
  return resolutionValue.decision === 'approve'
    ? ApproveResearchDocumentReviewResolutionSchema.parse({ decision: 'approve' })
    : RequestResearchDocumentChangesResolutionSchema.parse({
        decision: 'request_changes',
        annotations: resolutionValue.annotations,
        guidance: combineResearchDocumentReviewGuidance({
          decision: 'request_changes',
          annotations: [...resolutionValue.annotations],
          ...(resolutionValue.guidance === undefined ? {} : { guidance: resolutionValue.guidance }),
        }),
      });
};

export const readResearchDocumentReviewDetails = (
  details: unknown,
): ResearchDocumentReviewWaitDetails | null => {
  const parsed = ResearchDocumentReviewWaitDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data : null;
};
