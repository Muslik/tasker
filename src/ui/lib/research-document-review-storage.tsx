import { z } from 'zod';

const AnnotationDraftSchema = z
  .object({
    id: z.string().min(1),
    quote: z.string().min(1).max(500),
    note: z.string().max(2_000),
  })
  .strict();

const DraftSchema = z
  .object({
    guidance: z.string().max(10_000),
    annotations: z.array(AnnotationDraftSchema).max(50),
  })
  .strict();

export type ResearchDocumentReviewDraft = z.infer<typeof DraftSchema>;
export type ResearchDocumentReviewAnnotationDraft = z.infer<typeof AnnotationDraftSchema>;

export const researchDocumentReviewDraftKey = (input: {
  readonly taskReference: string;
  readonly runId: string;
  readonly blockRun: number;
  readonly documentArtifactId: string;
}) =>
  [
    'tasker',
    'research-document-review',
    input.taskReference,
    input.runId,
    String(input.blockRun),
    input.documentArtifactId,
  ].join(':');

export const loadResearchDocumentReviewDraft = (
  key: string,
): ResearchDocumentReviewDraft | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    return DraftSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
};

export const saveResearchDocumentReviewDraft = (
  key: string,
  draft: ResearchDocumentReviewDraft,
): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(DraftSchema.parse(draft)));
  } catch {
    return;
  }
};

export const clearResearchDocumentReviewDraft = (key: string): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    return;
  }
};
