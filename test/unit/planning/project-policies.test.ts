import { describe, expect, it } from 'vitest';

import {
  resolvePackagePublicationPolicy,
  resolveProjectWorkflowProfile,
} from '../../../src/planning/index.js';

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

  it('applies the global frontend publication process to an @ott package', () => {
    const policy = resolvePackagePublicationPolicy(
      'onetwotrip/front-components',
      'packages/@ott/booking-copy',
    );

    expect(policy).toEqual({
      kind: 'human_final',
      source: 'global',
      policyId: 'frontend-ott-package',
      pathPrefix: 'packages/@ott/',
      developmentPublishCommand: 'pnpm component:publish-dev',
    });
  });

  it('does not apply the @ott publication process outside its package path', () => {
    const policy = resolvePackagePublicationPolicy(
      'onetwotrip/front-components',
      'src/components/booking-copy',
    );

    expect(policy).toEqual({ kind: 'none', source: 'default' });
  });
});
