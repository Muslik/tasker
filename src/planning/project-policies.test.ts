import { describe, expect, it } from 'vitest';

import { resolveProjectWorkflowProfile } from './index.js';

describe('project workflow policies', () => {
  it('does not add external coordination to an unconfigured repository', () => {
    const profile = resolveProjectWorkflowProfile('twiket/unconfigured-frontend');

    expect(profile).toEqual({
      repository: 'twiket/unconfigured-frontend',
      repositoryKind: 'generic',
      source: 'default',
      translations: { kind: 'none' },
    });
  });
});
