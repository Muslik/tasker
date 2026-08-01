import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverRepositoryCatalog } from '../../src/repositories/catalog.js';

const directories: string[] = [];

const createCheckout = (root: string, name: string, remoteUrl: string): string => {
  const path = join(root, name);
  execFileSync('git', ['init', '--quiet', path]);
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', remoteUrl]);
  return path;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('repository catalog', () => {
  it('groups duplicate checkouts by remote and prefers the exact repository directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'tasker-repositories-'));
    directories.push(root);
    const duplicate = createCheckout(
      root,
      'front-avia-2',
      'ssh://git@bitbucket.twiket.com/onetwotrip/front-avia.git',
    );
    const preferred = createCheckout(
      root,
      'front-avia',
      'ssh://git@bitbucket.twiket.com/onetwotrip/front-avia.git',
    );

    const catalog = discoverRepositoryCatalog({ roots: [root], runnerId: 'local-test' });

    expect(catalog.list()).toEqual([
      expect.objectContaining({
        repositoryId: 'front-avia',
        checkout: { runnerId: 'local-test', path: preferred },
        checkoutPaths: [preferred, duplicate].sort(),
      }),
    ]);
    expect(catalog.list()[0]?.aliases).toContain('front-avia');
    expect(catalog.list()[0]?.aliases).toContain('front-avia-2');
  });

  it('keeps equal repository names from different remotes ambiguous', () => {
    const root = mkdtempSync(join(tmpdir(), 'tasker-repositories-'));
    directories.push(root);
    createCheckout(
      root,
      'front-backoffice-alpha',
      'ssh://git@bitbucket.twiket.com/team-a/front-backoffice.git',
    );
    createCheckout(
      root,
      'front-backoffice-beta',
      'ssh://git@bitbucket.twiket.com/team-b/front-backoffice.git',
    );
    const catalog = discoverRepositoryCatalog({ roots: [root], runnerId: 'local-test' });

    const lookup = catalog.find('front-backoffice');

    expect(lookup).toMatchObject({ status: 'ambiguous', candidates: [{}, {}] });
  });
});
