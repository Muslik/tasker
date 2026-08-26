import { describe, expect, it, vi } from 'vitest';

import {
  NexusRegistryClient,
  type NexusRegistryConfiguration,
} from '../../../src/integrations/nexus/index.js';

const configuration: NexusRegistryConfiguration = {
  registryUrl: 'https://nexus.example/repository/npm-private',
  auth: { kind: 'bearer', token: 'secret-token' },
  requestTimeoutMs: 1_000,
};

describe('Nexus registry client', () => {
  it('normalizes the exact package release metadata at the network boundary', async () => {
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          name: '@tasker/pkg',
          versions: {
            '1.2.3-dev.4': {
              name: '@tasker/pkg',
              version: '1.2.3-dev.4',
              dist: {
                tarball:
                  'https://nexus.example/repository/npm-private/@tasker/pkg/-/pkg-1.2.3-dev.4.tgz',
                integrity: 'sha512-abc',
                shasum: 'deadbeef',
              },
            },
          },
        }),
      ),
    );
    const client = new NexusRegistryClient(configuration, request);

    const result = await client.fetchPackageVersion('@tasker/pkg', '1.2.3-dev.4');

    expect(result).toEqual({
      ok: true,
      value: {
        packageName: '@tasker/pkg',
        version: '1.2.3-dev.4',
        registry: 'https://nexus.example/repository/npm-private',
        tarballUrl:
          'https://nexus.example/repository/npm-private/@tasker/pkg/-/pkg-1.2.3-dev.4.tgz',
        integrity: 'sha512-abc',
        shasum: 'deadbeef',
      },
    });
    expect(request.mock.calls[0]?.[0]).toBe(
      'https://nexus.example/repository/npm-private/%40tasker%2Fpkg',
    );
    const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer secret-token');
  });

  it('classifies Nexus auth failures without exposing credentials', async () => {
    const client = new NexusRegistryClient(
      configuration,
      vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status: 403 }))),
    );

    const result = await client.fetchPackageVersion('@tasker/pkg', '1.2.3-dev.4');

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'auth',
        message: 'Nexus request for @tasker/pkg was rejected with HTTP 403',
        retryable: true,
        httpStatus: 403,
      },
    });
    expect(JSON.stringify(result)).not.toContain(
      configuration.auth.kind === 'bearer' ? configuration.auth.token : '',
    );
  });

  it('rejects malformed version metadata that omits both integrity and shasum', async () => {
    const client = new NexusRegistryClient(
      configuration,
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.json({
            name: 'pkg',
            versions: {
              '1.2.3': {
                version: '1.2.3',
                dist: {
                  tarball: 'https://nexus.example/repository/npm-private/pkg/-/pkg-1.2.3.tgz',
                },
              },
            },
          }),
        ),
      ),
    );

    const result = await client.fetchPackageVersion('pkg', '1.2.3');

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'invalid_response',
        message: 'Nexus metadata for pkg@1.2.3 omitted both integrity and shasum',
        retryable: false,
      },
    });
  });
});
