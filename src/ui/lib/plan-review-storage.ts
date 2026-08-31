import { z } from 'zod';

import type { PlanReviewDraftAnnotation } from './plan-review-feedback.js';

type StorageLike = {
  readonly localStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
};

const browserWindow = (): StorageLike | null =>
  (globalThis as typeof globalThis & { readonly window?: StorageLike }).window ?? null;

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

export type PlanReviewDraft = {
  readonly guidance: string;
  readonly annotations: readonly PlanReviewDraftAnnotation[];
};

export const planReviewDraftKey = (input: {
  readonly taskReference: string;
  readonly runId: string;
  readonly planArtifactId: string;
  readonly planAttempt: number;
}) =>
  [
    'tasker',
    'plan-review',
    input.taskReference,
    input.runId,
    input.planArtifactId,
    String(input.planAttempt),
  ].join(':');

export const loadPlanReviewDraft = (key: string): PlanReviewDraft | null => {
  const browser = browserWindow();
  if (browser === null) return null;
  try {
    const raw = browser.localStorage.getItem(key);
    if (raw === null) return null;
    return DraftSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
};

export const savePlanReviewDraft = (key: string, draft: PlanReviewDraft): void => {
  const browser = browserWindow();
  if (browser === null) return;
  try {
    browser.localStorage.setItem(key, JSON.stringify(DraftSchema.parse(draft)));
  } catch {
    return;
  }
};

export const clearPlanReviewDraft = (key: string): void => {
  const browser = browserWindow();
  if (browser === null) return;
  try {
    browser.localStorage.removeItem(key);
  } catch {
    return;
  }
};
