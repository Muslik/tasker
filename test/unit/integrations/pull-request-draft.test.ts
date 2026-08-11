import { describe, expect, it } from 'vitest';

import { PullRequestDraftSchema } from '../../../src/integrations/index.js';

const draftWith = (branchArtifact: string) => ({
  title: 'AVIA-12045: Restore payment spacing',
  description: 'Restores the expected spacing above the payment button.',
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
});
