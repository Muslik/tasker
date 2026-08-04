import { z } from 'zod';

import type { BitbucketRepositoryConfiguration } from '../../repositories/bitbucket.js';

const RawPullRequestRefSchema = z
  .object({
    id: z.string().min(1),
    repository: z
      .object({
        slug: z.string().min(1),
        project: z.object({ key: z.string().min(1) }).loose(),
      })
      .loose(),
  })
  .loose();

const RawPullRequestSchema = z
  .object({
    id: z.number().int().positive(),
    version: z.number().int().nonnegative(),
    state: z.string().min(1),
    title: z.string().min(1),
    fromRef: RawPullRequestRefSchema,
    toRef: RawPullRequestRefSchema,
    links: z
      .object({
        self: z.array(z.object({ href: z.url() }).loose()).default([]),
      })
      .loose()
      .optional(),
  })
  .loose();

const RawPullRequestPageSchema = z
  .object({
    values: z.array(RawPullRequestSchema),
    isLastPage: z.boolean(),
    nextPageStart: z.number().int().nonnegative().optional(),
  })
  .loose();

export const BitbucketPullRequestSchema = z
  .object({
    id: z.number().int().positive(),
    version: z.number().int().nonnegative(),
    state: z.string().min(1),
    title: z.string().min(1),
    sourceRef: z.string().min(1),
    targetRef: z.string().min(1),
    url: z.url().nullable(),
  })
  .strict();

export type BitbucketPullRequest = z.infer<typeof BitbucketPullRequestSchema>;

export type BitbucketPullRequestProblem = {
  readonly kind:
    | 'access_blocked'
    | 'auth_failed'
    | 'conflict'
    | 'invalid_request'
    | 'invalid_response'
    | 'not_found'
    | 'unavailable';
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
};

export type BitbucketPullRequestLookup =
  | { readonly status: 'found'; readonly pullRequest: BitbucketPullRequest }
  | { readonly status: 'not_found' }
  | { readonly status: 'ambiguous'; readonly pullRequestIds: readonly number[] }
  | { readonly status: 'failed'; readonly problem: BitbucketPullRequestProblem };

export type BitbucketPullRequestCreation =
  | { readonly status: 'created'; readonly pullRequest: BitbucketPullRequest }
  | { readonly status: 'failed'; readonly problem: BitbucketPullRequestProblem };

export interface BitbucketPullRequestPort {
  findOpen(input: {
    readonly projectKey: string;
    readonly repositorySlug: string;
    readonly sourceRef: string;
    readonly targetRef: string;
  }): Promise<BitbucketPullRequestLookup>;
  create(input: {
    readonly projectKey: string;
    readonly repositorySlug: string;
    readonly title: string;
    readonly description: string;
    readonly sourceRef: string;
    readonly targetRef: string;
  }): Promise<BitbucketPullRequestCreation>;
}

type FetchImplementation = typeof fetch;

const pullRequestFrom = (raw: z.infer<typeof RawPullRequestSchema>): BitbucketPullRequest =>
  BitbucketPullRequestSchema.parse({
    id: raw.id,
    version: raw.version,
    state: raw.state,
    title: raw.title,
    sourceRef: raw.fromRef.id,
    targetRef: raw.toRef.id,
    url: raw.links?.self[0]?.href ?? null,
  });

const problemForStatus = (status: number): BitbucketPullRequestProblem => {
  if (status === 400) {
    return {
      kind: 'invalid_request',
      message: 'Bitbucket rejected the pull request payload',
      retryable: false,
      httpStatus: status,
    };
  }
  if (status === 401) {
    return {
      kind: 'auth_failed',
      message: 'Bitbucket rejected the configured token',
      retryable: false,
      httpStatus: status,
    };
  }
  if (status === 403) {
    return {
      kind: 'access_blocked',
      message: 'Bitbucket returned 403. VPN or repository access may be required',
      retryable: true,
      httpStatus: status,
    };
  }
  if (status === 404) {
    return {
      kind: 'not_found',
      message: 'Bitbucket repository or pull request endpoint was not found',
      retryable: false,
      httpStatus: status,
    };
  }
  if (status === 409) {
    return {
      kind: 'conflict',
      message: 'Bitbucket reported a conflicting pull request state',
      retryable: true,
      httpStatus: status,
    };
  }
  return {
    kind: 'unavailable',
    message: `Bitbucket pull request request failed with HTTP ${String(status)}`,
    retryable: status >= 500,
    httpStatus: status,
  };
};

export class BitbucketPullRequestClient implements BitbucketPullRequestPort {
  public constructor(
    private readonly configuration: BitbucketRepositoryConfiguration,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  public async findOpen(input: {
    readonly projectKey: string;
    readonly repositorySlug: string;
    readonly sourceRef: string;
    readonly targetRef: string;
  }): Promise<BitbucketPullRequestLookup> {
    const matches: BitbucketPullRequest[] = [];
    let start: number | undefined;
    do {
      const query = new URLSearchParams({
        state: 'OPEN',
        at: input.sourceRef,
        direction: 'OUTGOING',
        limit: '100',
      });
      if (start !== undefined) query.set('start', String(start));
      const response = await this.request(
        `${this.repositoryPath(input.projectKey, input.repositorySlug)}/pull-requests?${query.toString()}`,
        { method: 'GET' },
      );
      if (response.status === 'failed') return response;
      const parsed = RawPullRequestPageSchema.safeParse(response.body);
      if (!parsed.success) return this.invalidResponse('pull request page');
      for (const raw of parsed.data.values) {
        if (
          raw.state === 'OPEN' &&
          raw.fromRef.id === input.sourceRef &&
          raw.toRef.id === input.targetRef &&
          raw.fromRef.repository.slug === input.repositorySlug &&
          raw.fromRef.repository.project.key === input.projectKey
        ) {
          matches.push(pullRequestFrom(raw));
        }
      }
      start = parsed.data.isLastPage ? undefined : parsed.data.nextPageStart;
      if (!parsed.data.isLastPage && start === undefined) {
        return this.invalidResponse('pull request pagination');
      }
    } while (start !== undefined);

    if (matches.length === 0) return { status: 'not_found' };
    if (matches.length > 1) {
      return { status: 'ambiguous', pullRequestIds: matches.map(({ id }) => id) };
    }
    return { status: 'found', pullRequest: matches[0] as BitbucketPullRequest };
  }

  public async create(input: {
    readonly projectKey: string;
    readonly repositorySlug: string;
    readonly title: string;
    readonly description: string;
    readonly sourceRef: string;
    readonly targetRef: string;
  }): Promise<BitbucketPullRequestCreation> {
    const response = await this.request(
      `${this.repositoryPath(input.projectKey, input.repositorySlug)}/pull-requests`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: input.title,
          description: input.description,
          fromRef: {
            id: input.sourceRef,
            repository: {
              slug: input.repositorySlug,
              project: { key: input.projectKey },
            },
          },
          toRef: {
            id: input.targetRef,
            repository: {
              slug: input.repositorySlug,
              project: { key: input.projectKey },
            },
          },
        }),
      },
    );
    if (response.status === 'failed') return response;
    const parsed = RawPullRequestSchema.safeParse(response.body);
    return parsed.success
      ? { status: 'created', pullRequest: pullRequestFrom(parsed.data) }
      : this.invalidCreation('pull request');
  }

  private repositoryPath(projectKey: string, repositorySlug: string): string {
    return `/rest/api/latest/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repositorySlug)}`;
  }

  private invalidResponse(subject: string): BitbucketPullRequestLookup {
    return {
      status: 'failed',
      problem: {
        kind: 'invalid_response',
        message: `Bitbucket returned an invalid ${subject} response`,
        retryable: false,
      },
    };
  }

  private invalidCreation(subject: string): BitbucketPullRequestCreation {
    return {
      status: 'failed',
      problem: {
        kind: 'invalid_response',
        message: `Bitbucket returned an invalid ${subject} response`,
        retryable: false,
      },
    };
  }

  private async request(
    path: string,
    request: { readonly method: 'GET' | 'POST'; readonly body?: string },
  ): Promise<
    | { readonly status: 'ok'; readonly body: unknown }
    | { readonly status: 'failed'; readonly problem: BitbucketPullRequestProblem }
  > {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.configuration.baseUrl}${path}`, {
        method: request.method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.configuration.token}`,
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: AbortSignal.timeout(this.configuration.requestTimeoutMs),
      });
    } catch {
      return {
        status: 'failed',
        problem: {
          kind: 'unavailable',
          message: 'Bitbucket is unreachable. Check VPN and network access',
          retryable: true,
        },
      };
    }
    if (!response.ok) return { status: 'failed', problem: problemForStatus(response.status) };
    try {
      return { status: 'ok', body: await response.json() };
    } catch {
      return { status: 'ok', body: null };
    }
  }
}
