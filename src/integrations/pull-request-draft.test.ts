import { describe, expect, it } from 'vitest';

import { formatGitCommitMessage, PullRequestDraftSchema } from './index.js';

const draftWith = (branchArtifact: string) => ({
  title: 'AVIA-12045: Restore payment spacing',
  description: 'Restores the expected spacing above the payment button.',
  commit: { kind: 'subject', subject: 'Restore payment spacing' },
  branchArtifacts: [branchArtifact],
});

describe('Pull-request draft', () => {
  it('accepts repository evidence intended for the task branch', () => {
    expect(PullRequestDraftSchema.safeParse(draftWith('.demo/AVIA-12045/result.png')).success).toBe(
      true,
    );
  });

  it.each(['.tasker/pull-request/ai-assistance.md', './.tasker/private.json'])(
    'rejects private control-plane path %s',
    (path) => {
      expect(PullRequestDraftSchema.safeParse(draftWith(path)).success).toBe(false);
    },
  );

  it('formats a scoped package commit through provider-neutral project policy', () => {
    const result = formatGitCommitMessage(
      'FC-2228',
      {
        kind: 'conventional',
        type: 'fix',
        scope: '@ott/ui',
        subject: 'restore button spacing',
      },
      {
        kind: 'conventional_task_key',
        allowedTypes: ['fix', 'feat'],
        requireScope: false,
      },
    );

    expect(result).toEqual({
      ok: true,
      message: 'fix(@ott/ui): [FC-2228] restore button spacing',
    });
  });
});
