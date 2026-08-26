import { describe, expect, it, vi } from 'vitest';

import {
  NexusPackageObserver,
  type NexusObservedPackage,
  type NexusPackageObservationProblem,
} from '../../../src/integrations/nexus/index.js';
import { err, ok, type Outcome } from '../../../src/shared/outcome.js';

const observedPackage = (input: Partial<NexusObservedPackage> = {}): NexusObservedPackage => ({
  packageName: '@tasker/pkg',
  version: '1.2.3-dev.4',
  registry: 'https://nexus.example/repository/npm-private',
  tarballUrl: 'https://nexus.example/repository/npm-private/@tasker/pkg/-/pkg-1.2.3-dev.4.tgz',
  integrity: 'sha512-abc',
  shasum: 'deadbeef',
  ...input,
});

const clientFrom = (
  implementation: (
    packageName: string,
    version: string,
  ) => Promise<Outcome<NexusObservedPackage, NexusPackageObservationProblem>>,
) => ({
  fetchPackageVersion: vi.fn(implementation),
});

describe('Nexus package observer', () => {
  it('observes every requested package/version for a dev channel release set', async () => {
    const client = clientFrom((packageName, version) =>
      Promise.resolve(ok(observedPackage({ packageName, version }))),
    );
    const observer = new NexusPackageObserver(client);

    const result = await observer.observe({
      channel: 'dev',
      packages: [
        { packageName: '@tasker/pkg', version: '1.2.3-dev.4' },
        { packageName: 'pkg-two', version: '4.5.6-rc.1' },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        channel: 'dev',
        packages: [
          { packageName: '@tasker/pkg', version: '1.2.3-dev.4' },
          { packageName: 'pkg-two', version: '4.5.6-rc.1' },
        ],
      },
    });
    expect(client.fetchPackageVersion).toHaveBeenCalledTimes(2);
  });

  it('rejects final channel prerelease versions before touching the network', async () => {
    const client = clientFrom(() => Promise.resolve(ok(observedPackage())));
    const observer = new NexusPackageObserver(client);

    const result = await observer.observe({
      channel: 'final',
      packages: [{ packageName: '@tasker/pkg', version: '1.2.3-rc.1' }],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'invalid_input',
        message: 'packages.0.version: Final channel forbids prerelease package versions',
        retryable: false,
      },
    });
    expect(client.fetchPackageVersion).not.toHaveBeenCalled();
  });

  it('rejects dev channel stable versions before touching the network', async () => {
    const client = clientFrom(() => Promise.resolve(ok(observedPackage())));
    const observer = new NexusPackageObserver(client);

    const result = await observer.observe({
      channel: 'dev',
      packages: [{ packageName: '@tasker/pkg', version: '1.2.3' }],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'invalid_input',
        message: 'packages.0.version: Dev channel requires prerelease package versions',
        retryable: false,
      },
    });
    expect(client.fetchPackageVersion).not.toHaveBeenCalled();
  });

  it('rejects multiple versions of the same package before touching the network', async () => {
    const client = clientFrom(() => Promise.resolve(ok(observedPackage())));
    const observer = new NexusPackageObserver(client);

    const result = await observer.observe({
      channel: 'dev',
      packages: [
        { packageName: '@tasker/pkg', version: '1.2.3-dev.4' },
        { packageName: '@tasker/pkg', version: '1.2.3-dev.5' },
      ],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'invalid_input',
        message: 'packages.1: Expected each package name to appear once',
        retryable: false,
      },
    });
    expect(client.fetchPackageVersion).not.toHaveBeenCalled();
  });

  it('fails the whole observation when any requested package release is unavailable', async () => {
    const client = clientFrom((packageName, version) =>
      Promise.resolve(
        packageName === 'pkg-two'
          ? err({
              kind: 'unavailable',
              message: `Nexus registry does not contain ${packageName}@${version}`,
              retryable: false,
              missing: [{ packageName, version }],
            })
          : ok(observedPackage({ packageName, version })),
      ),
    );
    const observer = new NexusPackageObserver(client);

    const result = await observer.observe({
      channel: 'dev',
      packages: [
        { packageName: '@tasker/pkg', version: '1.2.3-dev.4' },
        { packageName: 'pkg-two', version: '4.5.6-rc.1' },
      ],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'unavailable',
        message: 'Nexus registry is missing pkg-two@4.5.6-rc.1',
        retryable: false,
        missing: [{ packageName: 'pkg-two', version: '4.5.6-rc.1' }],
      },
    });
  });

  it('surfaces typed network failures from the read-only registry client', async () => {
    const client = clientFrom(() =>
      Promise.resolve(
        err({
          kind: 'network',
          message: 'socket hang up',
          retryable: true,
        }),
      ),
    );
    const observer = new NexusPackageObserver(client);

    const result = await observer.observe({
      channel: 'dev',
      packages: [{ packageName: '@tasker/pkg', version: '1.2.3-dev.4' }],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'network',
        message: 'socket hang up',
        retryable: true,
      },
    });
  });
});
