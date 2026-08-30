import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { WorkflowChangeReview } from './WorkflowChangeReview.js';

it('offers accept, reject-with-guidance, and dismiss decisions', () => {
  const continuation = {
    status: 'awaiting_review',
    continuationId: 'continuation',
    attempt: 1,
    parentNodeId: 'node',
    reason: 'Need another stage',
    transcriptOperationId: 'operation',
    semanticHash: 'a'.repeat(64),
    workflowHash: 'b'.repeat(64),
    usage: {
      provider: 'codex',
      profile: 'default',
      profileSha256: 'a'.repeat(64),
      model: 'gpt-5.4',
      effort: 'high',
      serviceTier: 'fast',
      sessionId: 'session',
      durationMs: 1,
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
      apiCost: { source: 'unrated' },
    },
  };
  const html = renderToStaticMarkup(
    createElement(WorkflowChangeReview, {
      run: { status: 'waiting', wait: { waitKind: 'workflow_change.review@1' } },
      continuation,
      pending: false,
      error: null,
      onDecision: vi.fn(),
    } as never),
  );
  expect(html).toContain('Accept workflow');
  expect(html).toContain('Reject with guidance');
  expect(html).toContain('Dismiss');
});
