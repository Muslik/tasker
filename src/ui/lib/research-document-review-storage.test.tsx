import { afterEach, describe, expect, it } from 'vitest';

import {
  clearResearchDocumentReviewDraft,
  loadResearchDocumentReviewDraft,
  researchDocumentReviewDraftKey,
  saveResearchDocumentReviewDraft,
} from './research-document-review-storage.js';

describe('research document review draft storage', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('loads a stored draft by task, run, block run, and document', () => {
    const { key } = installStorage();
    saveResearchDocumentReviewDraft(key, {
      guidance: 'Tighten the conclusion.',
      annotations: [{ id: 'annotation-1', quote: 'Draft', note: 'Clarify this point.' }],
    });

    expect(loadResearchDocumentReviewDraft(key)).toEqual({
      guidance: 'Tighten the conclusion.',
      annotations: [{ id: 'annotation-1', quote: 'Draft', note: 'Clarify this point.' }],
    });
  });

  it('clears a stored draft', () => {
    const { key } = installStorage();
    saveResearchDocumentReviewDraft(key, {
      guidance: 'Tighten the conclusion.',
      annotations: [{ id: 'annotation-1', quote: 'Draft', note: 'Clarify this point.' }],
    });

    clearResearchDocumentReviewDraft(key);

    expect(loadResearchDocumentReviewDraft(key)).toBeNull();
  });
});

const installStorage = () => {
  const storage = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
  };

  return {
    key: researchDocumentReviewDraftKey({
      taskReference: 'jira:AVIA-77',
      runId: 'run-research',
      blockRun: 4,
      documentArtifactId: 'artifact-research',
    }),
  };
};
