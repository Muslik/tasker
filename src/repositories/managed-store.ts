import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  discoverRepositoryCatalog,
  type RepositoryCatalog,
  type RepositoryCatalogConfiguration,
  type RepositoryCatalogLookup,
  type RepositoryResolution,
} from './catalog.js';
import type {
  BitbucketRepositoryConfiguration,
  RemoteRepository,
  RepositoryRemoteSource,
} from './bitbucket.js';
import {
  RepositoryProvisionProblemSchema,
  type RepositoryCatalogEntry,
  type RepositoryProvisionProblem,
} from './contracts.js';

export type GitCloneResult =
  | { readonly status: 'cloned' }
  | { readonly status: 'failed'; readonly problem: RepositoryProvisionProblem };

export interface RepositoryCloner {
  clone(remoteUrl: string, destination: string): Promise<GitCloneResult>;
}

export class GitRepositoryCloner implements RepositoryCloner {
  public constructor(private readonly bearerToken: string) {}

  public clone(remoteUrl: string, destination: string): Promise<GitCloneResult> {
    return new Promise((complete) => {
      execFile(
        'git',
        ['clone', '--origin', 'origin', '--', remoteUrl, destination],
        {
          env: {
            ...process.env,
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.extraHeader',
            GIT_CONFIG_VALUE_0: `Authorization: Bearer ${this.bearerToken}`,
            GIT_TERMINAL_PROMPT: '0',
          },
          timeout: 10 * 60 * 1_000,
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, _stdout, stderr) => {
          if (error === null) {
            complete({ status: 'cloned' });
            return;
          }
          const rawDetail = stderr.trim();
          const detail =
            this.bearerToken.length === 0
              ? rawDetail
              : rawDetail.replaceAll(this.bearerToken, '[redacted]');
          complete({
            status: 'failed',
            problem: RepositoryProvisionProblemSchema.parse({
              kind: 'clone_failed',
              message: detail.length === 0 ? 'git clone failed' : detail,
              retryable: true,
            }),
          });
        },
      );
    });
  }
}

const conflictProblem = (destination: string): RepositoryProvisionProblem =>
  RepositoryProvisionProblemSchema.parse({
    kind: 'destination_conflict',
    message: `Managed repository destination already exists and is not a usable clone: ${destination}`,
    retryable: false,
  });

const normalizedReference = (reference: string): string => reference.toLocaleLowerCase('en-US');

export class ManagedRepositoryStore implements RepositoryCatalog {
  private readonly inFlight = new Map<string, Promise<RepositoryResolution>>();

  public constructor(
    private readonly configuration: RepositoryCatalogConfiguration,
    private readonly source: RepositoryRemoteSource,
    private readonly cloner: RepositoryCloner,
  ) {}

  public list(): readonly RepositoryCatalogEntry[] {
    return this.catalog().list();
  }

  public find(reference: string): RepositoryCatalogLookup {
    return this.catalog().find(reference);
  }

  public resolve(reference: string): Promise<RepositoryResolution> {
    const existing = this.catalog().find(reference);
    if (existing.status !== 'not_found') return this.catalog().resolve(reference);

    const key = normalizedReference(reference);
    const current = this.inFlight.get(key);
    if (current !== undefined) return current;
    const pending = this.provision(reference).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  private catalog() {
    return discoverRepositoryCatalog(this.configuration);
  }

  private async provision(reference: string): Promise<RepositoryResolution> {
    const remote = await this.source.find(reference);
    if (remote.status !== 'found') return remote;

    await mkdir(this.configuration.storePath, { recursive: true, mode: 0o700 });
    const destination = this.destination(remote.repository);
    if (existsSync(destination)) {
      const existing = this.catalog().find(remote.repository.candidate.reference);
      return existing.status === 'found'
        ? existing
        : { status: 'unavailable', problem: conflictProblem(destination) };
    }

    // A clone becomes visible to the catalog only after its directory is atomically renamed.
    const temporary = await mkdtemp(join(this.configuration.storePath, '.clone-'));
    try {
      const cloned = await this.cloner.clone(remote.repository.cloneUrl, temporary);
      if (cloned.status === 'failed') return { status: 'unavailable', problem: cloned.problem };
      try {
        await rename(temporary, destination);
      } catch (error) {
        if (!existsSync(destination)) throw error;
      }
      const provisioned = this.catalog().find(remote.repository.candidate.reference);
      return provisioned.status === 'found'
        ? provisioned
        : {
            status: 'unavailable',
            problem: RepositoryProvisionProblemSchema.parse({
              kind: 'invalid_response',
              message: 'The cloned repository could not be identified from its origin remote',
              retryable: false,
            }),
          };
    } catch (error) {
      return {
        status: 'unavailable',
        problem: RepositoryProvisionProblemSchema.parse({
          kind: 'clone_failed',
          message: error instanceof Error ? error.message : 'Managed repository clone failed',
          retryable: true,
        }),
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private destination(repository: RemoteRepository): string {
    const name =
      `${repository.candidate.projectKey}--${repository.candidate.repositoryId}`.toLocaleLowerCase(
        'en-US',
      );
    return resolve(this.configuration.storePath, name);
  }
}

export const createManagedRepositoryStore = (
  configuration: RepositoryCatalogConfiguration,
  bitbucket: BitbucketRepositoryConfiguration | null,
  source: RepositoryRemoteSource,
): ManagedRepositoryStore =>
  new ManagedRepositoryStore(
    configuration,
    source,
    new GitRepositoryCloner(bitbucket?.token ?? ''),
  );
