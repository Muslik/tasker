import { describe, expect, it } from 'vitest';

import { renderResearchDocumentHtml } from './research-document-review-render.js';

describe('renderResearchDocumentHtml', () => {
  it('turns Confluence macros into readable placeholders and strips scripts', () => {
    const html = renderResearchDocumentHtml(`
      <h1>Research</h1>
      <ac:structured-macro ac:name="info">
        <ac:rich-text-body><p>Body</p></ac:rich-text-body>
      </ac:structured-macro>
      <script>alert(1)</script>
    `);

    expect(html).toContain('<h1>Research</h1>');
    expect(html).toContain('Macro:</strong> info');
    expect(html).toContain('<p>Body</p>');
    expect(html).not.toContain('<script>');
  });

  it('removes javascript links in the fallback sanitizer path', () => {
    const html = renderResearchDocumentHtml('<a href="javascript:alert(1)">Unsafe</a>');

    expect(html).not.toContain('javascript:alert');
  });

  it('preserves safe anchors', () => {
    const html = renderResearchDocumentHtml('<a href="https://example.com/docs">Docs</a>');

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('>Docs</a>');
  });

  it('stops cleanly on malformed macro markup', () => {
    const html = renderResearchDocumentHtml(
      '<ac:structured-macro ac:name="tip"><ac:plain-text-body>Draft',
    );

    expect(html).toContain('Macro:</strong> tip');
    expect(html).toContain('Draft');
  });

  it('drops unsafe fallback tags and attributes while preserving safe text', () => {
    const html = renderResearchDocumentHtml(
      '<p onload="alert(1)">Safe</p><iframe src="https://bad.example">Hidden</iframe>',
    );

    expect(html).toContain('<p>Safe</p>');
    expect(html).not.toContain('onload=');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('Hidden');
  });
});
