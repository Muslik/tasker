export type PlanReviewAnnotationInput = {
  readonly quote: string;
  readonly note: string;
};

export type PlanReviewDraftAnnotation = PlanReviewAnnotationInput & {
  readonly id: string;
};

const annotationFeedback = (annotation: { quote: string; note: string }, index: number): string =>
  `Annotation ${String(index + 1)}\n> ${annotation.quote.replaceAll('\n', '\n> ')}\n\n${annotation.note}`;

export const planReviewFeedbackFrom = ({
  guidance,
  annotations,
}: {
  readonly guidance: string;
  readonly annotations: readonly PlanReviewDraftAnnotation[];
}): string =>
  [
    guidance.trim().length === 0 ? null : guidance.trim(),
    ...annotations
      .map((annotation) => ({
        quote: annotation.quote.trim(),
        note: annotation.note.trim(),
      }))
      .filter((annotation) => annotation.quote.length > 0 && annotation.note.length > 0)
      .map(annotationFeedback),
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n');
