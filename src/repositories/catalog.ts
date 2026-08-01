import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';

import {
  RepositoryCandidateSchema,
  RepositoryCatalogEntrySchema,
  RepositoryCatalogResponseSchema,
  type RepositoryCandidate,
  type RepositoryCatalogEntry,
  type RepositoryProvisionProblem,
} from './contracts.js';

export type RepositoryCatalogLookup =
  | { readonly status: 'found'; readonly repository: RepositoryCatalogEntry }
  | { readonly status: 'not_found' }
  | { readonly status: 'ambiguous'; readonly candidates: readonly RepositoryCatalogEntry[] };

export type RepositoryResolution =
  | { readonly status: 'found'; readonly repository: RepositoryCatalogEntry }
  | { readonly status: 'not_found' }
  | { readonly status: 'ambiguous'; readonly candidates: readonly RepositoryCandidate[] }
  | { readonly status: 'unavailable'; readonly problem: RepositoryProvisionProblem };

export interface RepositoryCatalog {
  list(): readonly RepositoryCatalogEntry[];
  find(reference: string): RepositoryCatalogLookup;
  resolve(reference: string): Promise<RepositoryResolution>;
}

const normalizeLookup = (value: string): string =>
  value
    .trim()
    .replace(/\.git$/iu, '')
    .toLocaleLowerCase('en-US');

const normalizeRemoteIdentity = (remoteUrl: string): string =>
  remoteUrl
    .trim()
    .replace(/\/$/u, '')
    .replace(/\.git$/iu, '')
    .toLocaleLowerCase('en-US');

const repositoryIdFromRemote = (remoteUrl: string): string => {
  const normalized = remoteUrl.replace(/\.git$/iu, '').replace(/\/$/u, '');
  const separator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf(':'));
  return normalized.slice(separator + 1);
};

const repositoryAliasFromRemote = (remoteUrl: string): string | null => {
  const normalized = remoteUrl.replace(/\.git$/iu, '').replace(/\/$/u, '');
  const path = normalized.includes('://')
    ? new URL(normalized).pathname.replace(/^\//u, '')
    : normalized.slice(normalized.indexOf(':') + 1);
  const segments = path.split('/').filter((segment) => segment.length > 0);
  return segments.length < 2 ? null : segments.slice(-2).join('/');
};

const readOrigin = (repositoryPath: string): string | null => {
  try {
    const value = execFileSync(
      'git',
      ['-C', repositoryPath, 'config', '--get', 'remote.origin.url'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    return value.length === 0 ? null : value;
  } catch {
    return null;
  }
};

const preferredCheckout = (repositoryId: string, paths: readonly string[]): string =>
  [...paths].sort((left, right) => {
    const leftExact = normalizeLookup(basename(left)) === normalizeLookup(repositoryId);
    const rightExact = normalizeLookup(basename(right)) === normalizeLookup(repositoryId);
    if (leftExact !== rightExact) return leftExact ? -1 : 1;
    if (left.length !== right.length) return left.length - right.length;
    return left.localeCompare(right);
  })[0] as string;

const candidateFromEntry = (repository: RepositoryCatalogEntry): RepositoryCandidate => {
  const qualifiedAlias = repository.aliases.find((alias) => alias.includes('/'));
  const projectKey = qualifiedAlias?.split('/')[0] ?? 'local';
  return RepositoryCandidateSchema.parse({
    repositoryId: repository.repositoryId,
    projectKey,
    reference: qualifiedAlias ?? repository.repositoryId,
    remoteUrl: repository.remoteUrl ?? `local:${repository.checkout.path}`,
  });
};

export class StaticRepositoryCatalog implements RepositoryCatalog {
  private readonly repositories: readonly RepositoryCatalogEntry[];

  public constructor(entries: readonly RepositoryCatalogEntry[]) {
    this.repositories = RepositoryCatalogResponseSchema.parse({
      repositories: entries,
    }).repositories;
  }

  public list(): readonly RepositoryCatalogEntry[] {
    return this.repositories;
  }

  public find(reference: string): RepositoryCatalogLookup {
    const normalized = normalizeLookup(reference);
    const candidates = this.repositories.filter((repository) =>
      repository.aliases.some((alias) => normalizeLookup(alias) === normalized),
    );
    if (candidates.length === 0) return { status: 'not_found' };
    if (candidates.length === 1) {
      return { status: 'found', repository: candidates[0] as RepositoryCatalogEntry };
    }
    return { status: 'ambiguous', candidates };
  }

  public resolve(reference: string): Promise<RepositoryResolution> {
    const lookup = this.find(reference);
    return Promise.resolve(
      lookup.status === 'ambiguous'
        ? { status: 'ambiguous', candidates: lookup.candidates.map(candidateFromEntry) }
        : lookup,
    );
  }
}

export interface RepositoryCatalogConfiguration {
  readonly storePath: string;
  readonly runnerId: string;
}

export const defaultRepositoryStorePath = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
): string => {
  const override = environment.TASKER_REPOSITORY_STORE?.trim();
  if (override) return resolve(override);
  if (platform === 'darwin') {
    return resolve(homeDirectory, 'Library', 'Application Support', 'Tasker', 'repositories');
  }
  if (platform === 'win32') {
    return resolve(
      environment.LOCALAPPDATA?.trim() || resolve(homeDirectory, 'AppData', 'Local'),
      'Tasker',
      'repositories',
    );
  }
  return resolve(
    environment.XDG_DATA_HOME?.trim() || resolve(homeDirectory, '.local', 'share'),
    'tasker',
    'repositories',
  );
};

export const loadRepositoryCatalogConfiguration = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RepositoryCatalogConfiguration => ({
  storePath: defaultRepositoryStorePath(environment),
  runnerId: environment.TASKER_RUNNER_ID?.trim() || 'local',
});

export const discoverRepositoryCatalog = (
  configuration: RepositoryCatalogConfiguration,
): StaticRepositoryCatalog => {
  const root = configuration.storePath;
  const discovered = !existsSync(root)
    ? []
    : readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => resolve(root, entry.name))
        .filter((repositoryPath) => existsSync(resolve(repositoryPath, '.git')))
        .map((repositoryPath) => ({ repositoryPath, remoteUrl: readOrigin(repositoryPath) }));

  const grouped = new Map<string, typeof discovered>();
  for (const repository of discovered) {
    const identity =
      repository.remoteUrl === null
        ? `local:${repository.repositoryPath}`
        : `remote:${normalizeRemoteIdentity(repository.remoteUrl)}`;
    grouped.set(identity, [...(grouped.get(identity) ?? []), repository]);
  }

  const repositories = [...grouped.values()]
    .map((group) => {
      const first = group[0] as (typeof group)[number];
      const repositoryId =
        first.remoteUrl === null
          ? basename(first.repositoryPath)
          : repositoryIdFromRemote(first.remoteUrl);
      const checkoutPaths = group.map((entry) => entry.repositoryPath).sort();
      const remoteAlias =
        first.remoteUrl === null ? null : repositoryAliasFromRemote(first.remoteUrl);
      const aliases = [
        repositoryId,
        ...checkoutPaths.map((checkoutPath) => basename(checkoutPath)),
        ...(remoteAlias === null ? [] : [remoteAlias]),
      ].filter((alias, index, values) => values.indexOf(alias) === index);

      return RepositoryCatalogEntrySchema.parse({
        repositoryId,
        remoteUrl: first.remoteUrl,
        checkout: {
          runnerId: configuration.runnerId,
          path: preferredCheckout(repositoryId, checkoutPaths),
        },
        checkoutPaths,
        aliases,
      });
    })
    .sort((left, right) =>
      left.repositoryId === right.repositoryId
        ? (left.remoteUrl ?? '').localeCompare(right.remoteUrl ?? '')
        : left.repositoryId.localeCompare(right.repositoryId),
    );

  return new StaticRepositoryCatalog(repositories);
};
