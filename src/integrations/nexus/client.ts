import { Buffer } from 'node:buffer';

import { z } from 'zod';

import { err, ok, type Outcome } from '../../shared/outcome.js';
import {
  loadNexusRegistryConfiguration,
  type NexusRegistryConfiguration,
} from './configuration.js';

const RawDistSchema = z
  .object({
    tarball: z.httpUrl(),
    integrity: z.string().min(1).optional(),
    shasum: z.string().min(1).optional(),
  })
  .loose();

const RawVersionSchema = z
  .object({
    name: z.string().min(1).optional(),
    version: z.string().min(1),
    dist: RawDistSchema,
  })
  .loose();

const RawPackageMetadataSchema = z
  .object({
    name: z.string().min(1),
    versions: z.record(z.string(), RawVersionSchema),
  })
  .loose();

export interface NexusObservedPackage {
  readonly packageName: string;
  readonly version: string;
  readonly registry: string;
  readonly tarballUrl: string;
  readonly integrity: string | null;
  readonly shasum: string | null;
}

export type NexusPackageObservationProblem = {
  readonly kind: 'auth' | 'invalid_input' | 'invalid_response' | 'network' | 'unavailable';
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly missing?: readonly {
    readonly packageName: string;
    readonly version: string;
  }[];
};

type FetchImplementation = typeof fetch;

export class NexusRegistryClient {
  public constructor(
    private readonly configuration: NexusRegistryConfiguration | null = loadNexusRegistryConfiguration(),
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  public async fetchPackageVersion(
    packageName: string,
    version: string,
  ): Promise<Outcome<NexusObservedPackage, NexusPackageObservationProblem>> {
    const response = await this.requestPackageMetadata(packageName);
    if (!response.ok) return response;

    let payload: unknown;
    try {
      payload = await response.value.json();
    } catch {
      return err({
        kind: 'invalid_response',
        message: `Nexus returned a non-JSON metadata response for ${packageName}`,
        retryable: false,
      });
    }

    const parsed = RawPackageMetadataSchema.safeParse(payload);
    if (!parsed.success) {
      return err({
        kind: 'invalid_response',
        message: `Nexus metadata for ${packageName} did not match the expected contract: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
        retryable: false,
      });
    }

    if (parsed.data.name !== packageName) {
      return err({
        kind: 'invalid_response',
        message: `Nexus metadata for ${packageName} reported package ${parsed.data.name}`,
        retryable: false,
      });
    }

    const release = parsed.data.versions[version];
    if (release === undefined) {
      return err({
        kind: 'unavailable',
        message: `Nexus registry does not contain ${packageName}@${version}`,
        retryable: false,
        missing: [{ packageName, version }],
      });
    }

    if (
      release.version !== version ||
      (release.name !== undefined && release.name !== packageName)
    ) {
      return err({
        kind: 'invalid_response',
        message: `Nexus metadata for ${packageName}@${version} was internally inconsistent`,
        retryable: false,
      });
    }

    if (release.dist.integrity === undefined && release.dist.shasum === undefined) {
      return err({
        kind: 'invalid_response',
        message: `Nexus metadata for ${packageName}@${version} omitted both integrity and shasum`,
        retryable: false,
      });
    }

    return ok({
      packageName,
      version,
      registry: this.configuration?.registryUrl ?? '',
      tarballUrl: release.dist.tarball,
      integrity: release.dist.integrity ?? null,
      shasum: release.dist.shasum ?? null,
    });
  }

  private async requestPackageMetadata(
    packageName: string,
  ): Promise<Outcome<Response, NexusPackageObservationProblem>> {
    if (this.configuration === null) {
      return err({
        kind: 'unavailable',
        message: 'Nexus package observation is not configured for Tasker',
        retryable: false,
      });
    }

    try {
      const response = await this.fetchImplementation(
        `${this.configuration.registryUrl}/${encodeURIComponent(packageName)}`,
        {
          headers: {
            accept: 'application/json',
            ...this.authorizationHeader(),
          },
          signal: AbortSignal.timeout(this.configuration.requestTimeoutMs),
        },
      );

      if (response.ok) return ok(response);
      if (response.status === 401 || response.status === 403) {
        return err({
          kind: 'auth',
          message: `Nexus request for ${packageName} was rejected with HTTP ${String(response.status)}`,
          retryable: response.status === 403,
          httpStatus: response.status,
        });
      }
      if (response.status === 404) {
        return err({
          kind: 'unavailable',
          message: `Nexus registry does not contain metadata for ${packageName}`,
          retryable: false,
          httpStatus: 404,
          missing: [{ packageName, version: '*' }],
        });
      }
      return err({
        kind: 'unavailable',
        message: `Nexus request for ${packageName} failed with HTTP ${String(response.status)}`,
        retryable: response.status >= 500,
        httpStatus: response.status,
      });
    } catch (error) {
      return err({
        kind: 'network',
        message:
          error instanceof Error
            ? error.message
            : `Nexus request for ${packageName} failed before a response`,
        retryable: true,
      });
    }
  }

  private authorizationHeader(): Record<string, string> {
    if (this.configuration === null || this.configuration.auth.kind === 'anonymous') return {};
    if (this.configuration.auth.kind === 'bearer') {
      return { authorization: `Bearer ${this.configuration.auth.token}` };
    }
    return {
      authorization: `Basic ${Buffer.from(
        `${this.configuration.auth.username}:${this.configuration.auth.password}`,
      ).toString('base64')}`,
    };
  }
}
