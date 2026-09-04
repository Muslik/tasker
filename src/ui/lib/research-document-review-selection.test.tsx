import { describe, expect, it } from 'vitest';

import { captureResearchDocumentSelection } from './research-document-review-selection.js';

describe('captureResearchDocumentSelection', () => {
  it('captures the verbatim quote and button position for an in-document selection', () => {
    expect(
      captureResearchDocumentSelection(
        {
          rangeCount: 1,
          toString: () => 'Exact excerpt',
          getRangeAt: () => ({
            commonAncestorContainer: insideNode,
            getBoundingClientRect: () => ({ left: 24, bottom: 96 }),
          }),
        },
        {
          contains: (node) => node === insideNode,
        },
      ),
    ).toEqual({
      kind: 'captured',
      quote: 'Exact excerpt',
      rect: { left: 24, top: 96 },
    });
  });

  it('rejects selections outside the rendered document', () => {
    expect(
      captureResearchDocumentSelection(
        {
          rangeCount: 1,
          toString: () => 'Outside',
          getRangeAt: () => ({
            commonAncestorContainer: { id: 'outside' },
            getBoundingClientRect: () => ({ left: 0, bottom: 0 }),
          }),
        },
        {
          contains: () => false,
        },
      ),
    ).toEqual({ kind: 'outside' });
  });

  it('rejects quotes longer than the server contract allows', () => {
    expect(
      captureResearchDocumentSelection(
        {
          rangeCount: 1,
          toString: () => 'x'.repeat(501),
          getRangeAt: () => ({
            commonAncestorContainer: insideNode,
            getBoundingClientRect: () => ({ left: 0, bottom: 0 }),
          }),
        },
        {
          contains: () => true,
        },
      ),
    ).toEqual({ kind: 'too_long' });
  });

  it('accepts a custom quote limit for reusable selection capture', () => {
    expect(
      captureResearchDocumentSelection(
        {
          rangeCount: 1,
          toString: () => 'x'.repeat(800),
          getRangeAt: () => ({
            commonAncestorContainer: insideNode,
            getBoundingClientRect: () => ({ left: 0, bottom: 0 }),
          }),
        },
        {
          contains: () => true,
        },
        { maxLength: 2_000 },
      ),
    ).toEqual({
      kind: 'captured',
      quote: 'x'.repeat(800),
      rect: { left: 0, top: 0 },
    });
  });
});

const insideNode = { id: 'inside' };
