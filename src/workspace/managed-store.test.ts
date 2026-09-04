import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RepositoryRemoteSource } from './bitbucket.js';
import {
  GitRepositoryCloner,
  ManagedRepositoryStore,
  type RepositoryCloner,
} from './managed-store.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('managed repository store', () => {
  it('clones through the non-interactive Git boundary into an existing temporary directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tasker-git-cloner-'));
    directories.push(root);
    const remote = join(root, 'remote.git');
    const destination = mkdtempSync(join(root, '.clone-'));
    execFileSync('git', ['init', '--bare', '--quiet', remote]);
    const cloner = new GitRepositoryCloner('test-token');

    const result = await cloner.clone(remote, destination);

    expect(result).toEqual({ status: 'cloned' });
    expect(existsSync(join(destination, '.git'))).toBe(true);
  });

  it('provisions a missing repository under application data', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tasker-managed-store-'));
    directories.push(root);
    const storePath = join(root, 'application-data', 'repositories');
    const find = vi.fn(() =>
      Promise.resolve({
        status: 'found' as const,
        repository: {
          candidate: {
            repositoryId: 'front-avia',
            projectKey: 'ONETWOTRIP',
            reference: 'ONETWOTRIP/front-avia',
            remoteUrl: 'https://bitbucket.twiket.com/scm/onetwotrip/front-avia.git',
          },
          cloneUrl: 'https://bitbucket.twiket.com/scm/onetwotrip/front-avia.git',
        },
      }),
    );
    const source: RepositoryRemoteSource = { find };
    const clone = vi.fn((remoteUrl: string, destination: string) => {
      execFileSync('git', ['init', '--quiet', destination]);
      execFileSync('git', ['-C', destination, 'remote', 'add', 'origin', remoteUrl]);
      return Promise.resolve({ status: 'cloned' as const });
    });
    const cloner: RepositoryCloner = { clone };
    const managed = new ManagedRepositoryStore(
      { storePath, runnerId: 'local-test' },
      source,
      cloner,
    );

    const provisioned = await managed.resolve('front-avia');

    expect(provisioned).toMatchObject({
      status: 'found',
      repository: {
        checkout: {
          runnerId: 'local-test',
          path: join(storePath, 'onetwotrip--front-avia'),
        },
      },
    });
    expect(clone).toHaveBeenCalledOnce();
    expect(clone.mock.calls[0]?.[1]?.startsWith(join(storePath, '.clone-'))).toBe(true);
    expect(find).toHaveBeenCalledOnce();
  });

  it('reuses an existing managed checkout without contacting Bitbucket', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tasker-managed-store-'));
    directories.push(root);
    const storePath = join(root, 'repositories');
    const checkout = join(storePath, 'onetwotrip--front-avia');
    execFileSync('git', ['init', '--quiet', checkout]);
    execFileSync('git', [
      '-C',
      checkout,
      'remote',
      'add',
      'origin',
      'https://bitbucket.twiket.com/scm/onetwotrip/front-avia.git',
    ]);
    const find = vi.fn();
    const source: RepositoryRemoteSource = { find };
    const managed = new ManagedRepositoryStore({ storePath, runnerId: 'local-test' }, source, {
      clone: vi.fn(),
    });

    const result = await managed.resolve('front-avia');

    expect(result).toMatchObject({ status: 'found', repository: { checkout: { path: checkout } } });
    expect(find).not.toHaveBeenCalled();
  });

  it('keeps a recoverable Bitbucket failure as an explicit resolution state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tasker-managed-store-'));
    directories.push(root);
    const source: RepositoryRemoteSource = {
      find: vi.fn(() =>
        Promise.resolve({
          status: 'unavailable' as const,
          problem: {
            kind: 'access_blocked' as const,
            message: 'Bitbucket returned 403. VPN or repository access may be required',
            retryable: true,
            httpStatus: 403,
          },
        }),
      ),
    };
    const managed = new ManagedRepositoryStore(
      { storePath: join(root, 'repositories'), runnerId: 'local-test' },
      source,
      { clone: vi.fn() },
    );

    const result = await managed.resolve('front-avia');

    expect(result).toMatchObject({
      status: 'unavailable',
      problem: { kind: 'access_blocked', retryable: true, httpStatus: 403 },
    });
  });
});
