import { describe, expect, it, vi } from 'vitest';

import { BitbucketRepositoryClient } from './bitbucket.js';

const configuration = {
  baseUrl: 'https://bitbucket.twiket.com',
  token: 'test-token',
  requestTimeoutMs: 1_000,
} as const;

const repository = (projectKey: string, slug = 'front-avia') => ({
  slug,
  name: slug,
  project: { key: projectKey },
  links: {
    clone: [
      { name: 'ssh', href: `ssh://git@bitbucket.twiket.com/${projectKey}/${slug}.git` },
      { name: 'http', href: `https://bitbucket.twiket.com/scm/${projectKey}/${slug}.git` },
    ],
  },
});

describe('Bitbucket repository client', () => {
  it('resolves one exact accessible repository and selects its HTTPS clone URL', async () => {
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          values: [repository('ONETWOTRIP')],
          isLastPage: true,
        }),
      ),
    );
    const client = new BitbucketRepositoryClient(configuration, request);

    const result = await client.find('front-avia');

    expect(result).toEqual({
      status: 'found',
      repository: {
        candidate: {
          repositoryId: 'front-avia',
          projectKey: 'ONETWOTRIP',
          reference: 'ONETWOTRIP/front-avia',
          remoteUrl: 'https://bitbucket.twiket.com/scm/ONETWOTRIP/front-avia.git',
        },
        cloneUrl: 'https://bitbucket.twiket.com/scm/ONETWOTRIP/front-avia.git',
      },
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe(
      'https://bitbucket.twiket.com/rest/api/1.0/repos?name=front-avia&limit=100',
    );
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer test-token',
    );
  });

  it('returns qualified candidates instead of guessing between Bitbucket projects', async () => {
    const client = new BitbucketRepositoryClient(
      configuration,
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            values: [
              repository('TEAM-A', 'front-backoffice'),
              repository('TEAM-B', 'front-backoffice'),
            ],
            isLastPage: true,
          }),
        ),
      ),
    );

    const result = await client.find('front-backoffice');

    expect(result).toMatchObject({
      status: 'ambiguous',
      candidates: [
        { reference: 'TEAM-A/front-backoffice' },
        { reference: 'TEAM-B/front-backoffice' },
      ],
    });
  });

  it('classifies a Bitbucket 403 as recoverable VPN or access loss', async () => {
    const client = new BitbucketRepositoryClient(
      configuration,
      vi.fn(() => Promise.resolve(new Response('', { status: 403 }))),
    );

    const result = await client.find('front-avia');

    expect(result).toEqual({
      status: 'unavailable',
      problem: {
        kind: 'access_blocked',
        message: 'Bitbucket returned 403. VPN or repository access may be required',
        retryable: true,
        httpStatus: 403,
      },
    });
  });

  it('rejects malformed Bitbucket JSON at the adapter boundary', async () => {
    const client = new BitbucketRepositoryClient(
      configuration,
      vi.fn(() =>
        Promise.resolve(
          new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }),
        ),
      ),
    );

    const result = await client.find('front-avia');

    expect(result).toMatchObject({
      status: 'unavailable',
      problem: { kind: 'invalid_response', retryable: false },
    });
  });
});
