import { describe, expect, it } from 'vitest';

import {
  RequestResearchDocumentChangesResolutionSchema,
  ResearchDocumentReviewAnnotationSchema,
} from '../shared/research-document-review.js';
import {
  combineResearchDocumentReviewGuidance,
  normalizeResearchDocumentReviewResolution,
} from './research-document-review.js';

describe('research document review', () => {
  it('preserves verbatim quotes and trims notes at the schema boundary', () => {
    const annotation = ResearchDocumentReviewAnnotationSchema.parse({
      quote: '  exact excerpt  ',
      note: '  Clarify this section.  ',
    });

    expect(annotation).toEqual({
      quote: '  exact excerpt  ',
      note: 'Clarify this section.',
    });
  });

  it('requires change requests to contain guidance or annotations', () => {
    expect(() =>
      RequestResearchDocumentChangesResolutionSchema.parse({
        decision: 'request_changes',
        annotations: [],
      }),
    ).toThrow('Research document review requires guidance or at least one annotation');
  });

  it('combines overall guidance and annotations into bounded draft feedback', () => {
    expect(
      combineResearchDocumentReviewGuidance({
        decision: 'request_changes',
        guidance: 'Tighten the conclusion.',
        annotations: [
          {
            quote: 'Latency improved 5%',
            note: 'Cite the before and after samples.',
          },
        ],
      }),
    ).toBe(
      'Tighten the conclusion.\n\n«Фрагмент: "Latency improved 5%" — Cite the before and after samples.»',
    );
  });

  it('caps combined feedback at ten thousand characters', () => {
    const guidance = combineResearchDocumentReviewGuidance({
      decision: 'request_changes',
      guidance: 'g'.repeat(10_000),
      annotations: [
        {
          quote: 'q',
          note: 'n',
        },
      ],
    });

    expect(guidance).toHaveLength(10_000);
  });

  it('normalizes request changes into the exact Temporal resolution shape', () => {
    expect(
      normalizeResearchDocumentReviewResolution({
        decision: 'request_changes',
        guidance: 'Need a tighter intro.',
        annotations: [
          {
            quote: 'Evidence is strong',
            note: 'Name the exact source system.',
          },
        ],
      }),
    ).toEqual({
      decision: 'request_changes',
      guidance:
        'Need a tighter intro.\n\n«Фрагмент: "Evidence is strong" — Name the exact source system.»',
      annotations: [
        {
          quote: 'Evidence is strong',
          note: 'Name the exact source system.',
        },
      ],
    });
  });
});
