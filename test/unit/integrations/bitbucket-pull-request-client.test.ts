import { describe, expect, it, vi } from 'vitest';

import { BitbucketPullRequestClient } from '../../../src/integrations/index.js';

const configuration = {
  baseUrl: 'https://bitbucket.example',
  token: 'secret-token',
  requestTimeoutMs: 1_000,
};

const rawPullRequest = {
  id: 73,
  version: 2,
  state: 'OPEN',
  title: 'AVIA-13236: fix fare card',
  fromRef: {
    id: 'refs/heads/tasker/avia-13236',
    repository: { slug: 'front-avia', project: { key: 'ONETWOTRIP' } },
  },
  toRef: {
    id: 'refs/heads/main',
    repository: { slug: 'front-avia', project: { key: 'ONETWOTRIP' } },
  },
  links: {
    self: [
      {
        href: 'https://bitbucket.example/projects/ONETWOTRIP/repos/front-avia/pull-requests/73',
      },
    ],
  },
};

describe('Bitbucket pull request client', () => {
  it('finds an open PR by exact source and target refs', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({ values: [rawPullRequest], isLastPage: true }, { status: 200 }),
      ),
    );
    const client = new BitbucketPullRequestClient(configuration, fetchImplementation);

    const result = await client.findOpen({
      projectKey: 'ONETWOTRIP',
      repositorySlug: 'front-avia',
      sourceRef: 'refs/heads/tasker/avia-13236',
      targetRef: 'refs/heads/main',
    });

    expect(result).toMatchObject({
      status: 'found',
      pullRequest: { id: 73, sourceRef: 'refs/heads/tasker/avia-13236' },
    });
    const requestedUrl = fetchImplementation.mock.calls[0]?.[0];
    if (typeof requestedUrl !== 'string') throw new Error('Expected a string request URL');
    expect(requestedUrl).toContain(
      '/pull-requests?state=OPEN&at=refs%2Fheads%2Ftasker%2Favia-13236&direction=OUTGOING',
    );
  });

  it('reconciles an existing PR when Bitbucket canonicalizes the project key casing', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({ values: [rawPullRequest], isLastPage: true }, { status: 200 }),
      ),
    );
    const client = new BitbucketPullRequestClient(configuration, fetchImplementation);

    const result = await client.findOpen({
      projectKey: 'onetwotrip',
      repositorySlug: 'front-avia',
      sourceRef: 'refs/heads/tasker/avia-13236',
      targetRef: 'refs/heads/main',
    });

    expect(result).toMatchObject({ status: 'found', pullRequest: { id: 73 } });
  });

  it('creates a PR with explicit repository refs and bearer authentication', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(rawPullRequest, { status: 201 })),
    );
    const client = new BitbucketPullRequestClient(configuration, fetchImplementation);

    const result = await client.create({
      projectKey: 'ONETWOTRIP',
      repositorySlug: 'front-avia',
      title: rawPullRequest.title,
      description: 'Task description',
      sourceRef: rawPullRequest.fromRef.id,
      targetRef: rawPullRequest.toRef.id,
    });

    expect(result).toMatchObject({ status: 'created', pullRequest: { id: 73 } });
    const init = fetchImplementation.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ authorization: 'Bearer secret-token' });
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(init.body) as unknown).toMatchObject({
      fromRef: {
        id: rawPullRequest.fromRef.id,
        repository: { slug: 'front-avia', project: { key: 'ONETWOTRIP' } },
      },
      toRef: { id: rawPullRequest.toRef.id },
    });
  });

  it('classifies VPN access failures without exposing the token', async () => {
    const client = new BitbucketPullRequestClient(
      configuration,
      vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 403 }))),
    );

    const result = await client.findOpen({
      projectKey: 'ONETWOTRIP',
      repositorySlug: 'front-avia',
      sourceRef: 'refs/heads/tasker/avia-13236',
      targetRef: 'refs/heads/main',
    });

    expect(result).toEqual({
      status: 'failed',
      problem: {
        kind: 'access_blocked',
        message: 'Bitbucket returned 403. VPN or repository access may be required',
        retryable: true,
        httpStatus: 403,
      },
    });
    expect(JSON.stringify(result)).not.toContain(configuration.token);
  });
});
