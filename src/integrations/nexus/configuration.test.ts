import { describe, expect, it } from 'vitest';

import { loadNexusRegistryConfiguration } from './index.js';

describe('Nexus registry configuration', () => {
  it('requires an explicit auth mode before enabling package observation', () => {
    expect(
      loadNexusRegistryConfiguration({
        TASKER_NEXUS_REGISTRY_URL: 'https://nexus.example/repository/npm-private/',
      }),
    ).toBeNull();
  });

  it('normalizes an explicit bearer-token registry configuration', () => {
    expect(
      loadNexusRegistryConfiguration({
        TASKER_NEXUS_REGISTRY_URL: 'https://nexus.example/repository/npm-private/',
        TASKER_NEXUS_AUTH_KIND: 'bearer',
        TASKER_NEXUS_TOKEN: 'secret-token',
      }),
    ).toEqual({
      registryUrl: 'https://nexus.example/repository/npm-private',
      auth: { kind: 'bearer', token: 'secret-token' },
      requestTimeoutMs: 15_000,
    });
  });

  it('fails closed when basic auth is incomplete', () => {
    expect(
      loadNexusRegistryConfiguration({
        TASKER_NEXUS_REGISTRY_URL: 'https://nexus.example/repository/npm-private',
        TASKER_NEXUS_AUTH_KIND: 'basic',
        TASKER_NEXUS_USERNAME: 'reader',
      }),
    ).toBeNull();
  });
});
