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

const renderAnnotation = (annotation: ResearchDocumentReviewAnnotation): string =>
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

export const combineResearchDocumentReviewGuidance = (
  resolutionValue: RequestResearchDocumentChangesResolution,
): string => {
  const resolution = RequestResearchDocumentChangesResolutionSchema.parse(resolutionValue);
  return capGuidance(
    [
      ...(resolution.guidance === undefined ? [] : [resolution.guidance]),
      ...resolution.annotations.map(renderAnnotation),
    ].join('\n\n'),
  );
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
