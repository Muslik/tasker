import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { OperatorTaskInvocationDetail } from '../../server/operator-contracts.js';
import { InvocationPrompt, triggerInvocationPromptCopy } from './InvocationPrompt.js';

const detail: OperatorTaskInvocationDetail = {
  schemaVersion: 1,
  invocationId: 'invocation-1',
  taskReference: 'TASK-1',
  prompt: 'Run the task.',
  promptBytes: 13,
  provider: 'codex',
  profile: 'default',
  profileSha256: 'a'.repeat(64),
  model: 'gpt-5.4',
  effort: 'high',
  serviceTier: 'fast',
  argv: ['codex', 'exec'],
  skills: ['typescript-design'],
  inputEvidenceArtifactIds: ['artifact-1'],
  startedAt: '2026-08-30T10:00:00.000Z',
  finishedAt: '2026-08-30T10:00:05.000Z',
  durationMs: 5_000,
  status: 'completed',
  exitStatus: { kind: 'exited', exitCode: 0 },
  usage: {
    inputTokens: 11,
    cachedInputTokens: 2,
    outputTokens: 5,
    reasoningOutputTokens: 3,
  },
  cost: { source: 'provider_reported', amountUsd: 0.34 },
  references: {
    kind: 'execution',
    workflowId: 'workflow-1',
    runId: 'run-1',
    nodeId: 'deliver-pr',
    blockRun: 1,
    providerAttempt: 1,
    transcriptId: 'transcript-1',
    outputArtifactIds: ['artifact-1'],
    receiptArtifactId: null,
  },
};

describe('InvocationPrompt', () => {
  it('renders invocation metadata and the exact prompt in SSR', () => {
    const html = renderToStaticMarkup(
      createElement(InvocationPrompt, {
        invocationId: detail.invocationId,
        detail,
      }),
    );

    expect(html).toContain('Copy prompt');
    expect(html).toContain('invocation-1');
    expect(html).toContain('codex exec');
    expect(html).toContain('gpt-5.4');
    expect(html).toContain('Run the task.');
    expect(html).toContain('13 bytes');
  });

  it('copies prompts through the exported dependency-free helper', async () => {
    const writeText = vi.fn<(prompt: string) => void>();
    const onCopy = vi.fn<(prompt: string) => void>();

    await expect(
      triggerInvocationPromptCopy(detail.prompt, {
        writeText,
        onCopy,
      }),
    ).resolves.toBe(detail.prompt);
    expect(writeText).toHaveBeenCalledWith(detail.prompt);
    expect(onCopy).toHaveBeenCalledWith(detail.prompt);
  });
});
