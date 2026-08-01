import { z } from 'zod';

import { loadHarnessEnvironmentDefaults } from '../shared/env-file.js';
import {
  RepositoryCandidateSchema,
  RepositoryProvisionProblemSchema,
  type RepositoryCandidate,
  type RepositoryProvisionProblem,
} from './contracts.js';

const DEFAULT_BITBUCKET_BASE_URL = 'https://bitbucket.twiket.com';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const BitbucketRepositoryConfigurationSchema = z
  .object({
    baseUrl: z.url(),
    token: z.string().min(1),
    requestTimeoutMs: z.number().int().positive(),
  })
  .strict();

const RawCloneLinkSchema = z
  .object({
    name: z.enum(['http', 'ssh']),
    href: z.string().min(1),
  })
  .loose();

const RawRepositorySchema = z
  .object({
    slug: z.string().min(1),
    name: z.string().min(1),
    project: z.object({ key: z.string().min(1) }).loose(),
    links: z.object({ clone: z.array(RawCloneLinkSchema).min(1) }).loose(),
  })
  .loose();

const RawRepositoryPageSchema = z
  .object({
    values: z.array(RawRepositorySchema),
    isLastPage: z.boolean(),
    nextPageStart: z.number().int().nonnegative().optional(),
  })
  .loose();

export type BitbucketRepositoryConfiguration = z.infer<
  typeof BitbucketRepositoryConfigurationSchema
>;

export interface RemoteRepository {
  readonly candidate: RepositoryCandidate;
  readonly cloneUrl: string;
}

export type RemoteRepositoryLookup =
  | { readonly status: 'found'; readonly repository: RemoteRepository }
  | { readonly status: 'not_found' }
  | { readonly status: 'ambiguous'; readonly candidates: readonly RepositoryCandidate[] }
  | { readonly status: 'unavailable'; readonly problem: RepositoryProvisionProblem };

export interface RepositoryRemoteSource {
  find(reference: string): Promise<RemoteRepositoryLookup>;
}

type FetchImplementation = typeof fetch;

export const loadBitbucketRepositoryConfiguration = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BitbucketRepositoryConfiguration | null => {
  const defaults = loadHarnessEnvironmentDefaults(environment);
  const parsed = BitbucketRepositoryConfigurationSchema.safeParse({
    baseUrl:
      environment.BITBUCKET_BASE_URL ?? defaults.BITBUCKET_BASE_URL ?? DEFAULT_BITBUCKET_BASE_URL,
    token: environment.BITBUCKET_TOKEN ?? defaults.BITBUCKET_TOKEN,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  });
  return parsed.success
    ? { ...parsed.data, baseUrl: parsed.data.baseUrl.replace(/\/$/u, '') }
    : null;
};

const requestProblem = (status: number): RepositoryProvisionProblem => {
  if (status === 401) {
    return RepositoryProvisionProblemSchema.parse({
      kind: 'auth_failed',
      message: 'Bitbucket rejected the configured token',
      retryable: false,
      httpStatus: status,
    });
  }
  if (status === 403) {
    return RepositoryProvisionProblemSchema.parse({
      kind: 'access_blocked',
      message: 'Bitbucket returned 403. VPN or repository access may be required',
      retryable: true,
      httpStatus: status,
    });
  }
  return RepositoryProvisionProblemSchema.parse({
    kind: 'unavailable',
    message: `Bitbucket repository lookup failed with HTTP ${String(status)}`,
    retryable: status >= 500,
    httpStatus: status,
  });
};

const normalize = (value: string): string => value.toLocaleLowerCase('en-US');

const remoteRepository = (raw: z.infer<typeof RawRepositorySchema>): RemoteRepository | null => {
  const clone = raw.links.clone.find((link) => link.name === 'http') ?? raw.links.clone[0];
  if (clone === undefined) return null;
  const reference = `${raw.project.key}/${raw.slug}`;
  const candidate = RepositoryCandidateSchema.safeParse({
    repositoryId: raw.slug,
    projectKey: raw.project.key,
    reference,
    remoteUrl: clone.href,
  });
  if (!candidate.success) return null;
  return {
    candidate: candidate.data,
    cloneUrl: clone.href,
  };
};

export class BitbucketRepositoryClient implements RepositoryRemoteSource {
  public constructor(
    private readonly configuration: BitbucketRepositoryConfiguration,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  public async find(reference: string): Promise<RemoteRepositoryLookup> {
    const segments = reference.split('/');
    return segments.length === 2
      ? this.findQualified(segments[0] as string, segments[1] as string)
      : this.findByName(reference);
  }

  private async findQualified(
    projectKey: string,
    repositorySlug: string,
  ): Promise<RemoteRepositoryLookup> {
    const response = await this.request(
      `/rest/api/1.0/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repositorySlug)}`,
    );
    if (response.status === 'http_error') {
      return response.httpStatus === 404
        ? { status: 'not_found' }
        : { status: 'unavailable', problem: requestProblem(response.httpStatus) };
    }
    if (response.status === 'unavailable') return response;
    const parsed = RawRepositorySchema.safeParse(response.body);
    if (!parsed.success) return this.invalidResponse('repository');
    const repository = remoteRepository(parsed.data);
    return repository === null
      ? this.invalidResponse('repository clone links')
      : { status: 'found', repository };
  }

  private async findByName(reference: string): Promise<RemoteRepositoryLookup> {
    const matches: RemoteRepository[] = [];
    let start: number | undefined;
    do {
      const query = new URLSearchParams({ name: reference, limit: '100' });
      if (start !== undefined) query.set('start', String(start));
      const response = await this.request(`/rest/api/1.0/repos?${query.toString()}`);
      if (response.status === 'http_error') {
        return { status: 'unavailable', problem: requestProblem(response.httpStatus) };
      }
      if (response.status === 'unavailable') return response;
      const parsed = RawRepositoryPageSchema.safeParse(response.body);
      if (!parsed.success) return this.invalidResponse('repository page');
      for (const raw of parsed.data.values) {
        if (
          normalize(raw.slug) !== normalize(reference) &&
          normalize(raw.name) !== normalize(reference)
        ) {
          continue;
        }
        const repository = remoteRepository(raw);
        if (repository === null) return this.invalidResponse('repository clone links');
        matches.push(repository);
      }
      start = parsed.data.isLastPage ? undefined : parsed.data.nextPageStart;
      if (!parsed.data.isLastPage && start === undefined) return this.invalidResponse('pagination');
    } while (start !== undefined);

    if (matches.length === 0) return { status: 'not_found' };
    if (matches.length > 1) {
      return { status: 'ambiguous', candidates: matches.map((match) => match.candidate) };
    }
    return { status: 'found', repository: matches[0] as RemoteRepository };
  }

  private invalidResponse(subject: string): RemoteRepositoryLookup {
    return {
      status: 'unavailable',
      problem: RepositoryProvisionProblemSchema.parse({
        kind: 'invalid_response',
        message: `Bitbucket returned an invalid ${subject} response`,
        retryable: false,
      }),
    };
  }

  private async request(
    path: string,
  ): Promise<
    | { readonly status: 'ok'; readonly body: unknown }
    | { readonly status: 'http_error'; readonly httpStatus: number }
    | { readonly status: 'unavailable'; readonly problem: RepositoryProvisionProblem }
  > {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.configuration.baseUrl}${path}`, {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.configuration.token}`,
        },
        signal: AbortSignal.timeout(this.configuration.requestTimeoutMs),
      });
    } catch {
      return {
        status: 'unavailable',
        problem: RepositoryProvisionProblemSchema.parse({
          kind: 'unavailable',
          message: 'Bitbucket is unreachable. Check VPN and network access',
          retryable: true,
        }),
      };
    }
    if (!response.ok) return { status: 'http_error', httpStatus: response.status };
    try {
      return { status: 'ok', body: await response.json() };
    } catch {
      return { status: 'ok', body: null };
    }
  }
}

export class UnconfiguredBitbucketRepositorySource implements RepositoryRemoteSource {
  public find(): Promise<RemoteRepositoryLookup> {
    return Promise.resolve({
      status: 'unavailable',
      problem: RepositoryProvisionProblemSchema.parse({
        kind: 'bitbucket_not_configured',
        message: 'BITBUCKET_TOKEN is not configured',
        retryable: false,
      }),
    });
  }
}
