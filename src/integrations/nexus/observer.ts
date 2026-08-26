import { z } from 'zod';

import { err, ok, type Outcome } from '../../shared/outcome.js';
import {
  NexusRegistryClient,
  type NexusObservedPackage,
  type NexusPackageObservationProblem,
} from './client.js';

const EXACT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const PACKAGE_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._~-]*$/u;
const MAX_PACKAGE_NAME_LENGTH = 214;

const isExactSemver = (value: string): boolean => EXACT_SEMVER_PATTERN.test(value);

const hasPrerelease = (value: string): boolean => {
  const match = EXACT_SEMVER_PATTERN.exec(value);
  return match?.[4] !== undefined;
};

const isValidPackageSegment = (value: string): boolean =>
  value.length > 0 &&
  !value.startsWith('.') &&
  !value.startsWith('_') &&
  PACKAGE_SEGMENT_PATTERN.test(value);

const isValidNpmPackageName = (value: string): boolean => {
  if (value.length === 0 || value.length > MAX_PACKAGE_NAME_LENGTH) return false;
  if (value.startsWith('@')) {
    const slash = value.indexOf('/');
    if (slash <= 1 || slash === value.length - 1) return false;
    const scope = value.slice(1, slash);
    const name = value.slice(slash + 1);
    return isValidPackageSegment(scope) && isValidPackageSegment(name);
  }
  if (value.includes('/')) return false;
  return isValidPackageSegment(value);
};

export const NexusReleaseChannelSchema = z.enum(['dev', 'final']);
export type NexusReleaseChannel = z.infer<typeof NexusReleaseChannelSchema>;

export const NexusPackageSelectionSchema = z
  .object({
    packageName: z
      .string()
      .min(1)
      .refine(isValidNpmPackageName, 'Expected a valid npm package name'),
    version: z.string().min(1).refine(isExactSemver, 'Expected an exact semver version'),
  })
  .strict();

export type NexusPackageSelection = z.infer<typeof NexusPackageSelectionSchema>;

export const NexusPackageObservationRequestSchema = z
  .object({
    channel: NexusReleaseChannelSchema,
    packages: z.array(NexusPackageSelectionSchema).min(1),
  })
  .strict()
  .superRefine((input, context) => {
    const seen = new Set<string>();
    for (const [index, item] of input.packages.entries()) {
      if (seen.has(item.packageName)) {
        context.addIssue({
          code: 'custom',
          path: ['packages', index],
          message: 'Expected each package name to appear once',
        });
      } else {
        seen.add(item.packageName);
      }

      const prerelease = hasPrerelease(item.version);
      if (input.channel === 'dev' && !prerelease) {
        context.addIssue({
          code: 'custom',
          path: ['packages', index, 'version'],
          message: 'Dev channel requires prerelease package versions',
        });
      }
      if (input.channel === 'final' && prerelease) {
        context.addIssue({
          code: 'custom',
          path: ['packages', index, 'version'],
          message: 'Final channel forbids prerelease package versions',
        });
      }
    }
  });

export interface NexusPackageObservation {
  readonly channel: NexusReleaseChannel;
  readonly observedAt: string;
  readonly packages: readonly NexusObservedPackage[];
}

export interface NexusPackageObserverPort {
  observe(
    input: NexusPackageObservationRequest,
  ): Promise<Outcome<NexusPackageObservation, NexusPackageObservationProblem>>;
}

export type NexusPackageObservationRequest = z.infer<typeof NexusPackageObservationRequestSchema>;

export class NexusPackageObserver implements NexusPackageObserverPort {
  public constructor(
    private readonly client: Pick<
      NexusRegistryClient,
      'fetchPackageVersion'
    > = new NexusRegistryClient(),
  ) {}

  public async observe(
    input: NexusPackageObservationRequest,
  ): Promise<Outcome<NexusPackageObservation, NexusPackageObservationProblem>> {
    const parsed = NexusPackageObservationRequestSchema.safeParse(input);
    if (!parsed.success) {
      return err({
        kind: 'invalid_input',
        message: parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
        retryable: false,
      });
    }

    const packages: NexusObservedPackage[] = [];
    const missing: { packageName: string; version: string }[] = [];

    for (const item of parsed.data.packages) {
      const result = await this.client.fetchPackageVersion(item.packageName, item.version);
      if (!result.ok) {
        if (result.error.kind === 'unavailable') {
          if (result.error.missing !== undefined) {
            for (const entry of result.error.missing) {
              missing.push({
                packageName: entry.packageName,
                version: entry.version === '*' ? item.version : entry.version,
              });
            }
          } else {
            missing.push(item);
          }
          continue;
        }
        return result;
      }
      packages.push(result.value);
    }

    if (missing.length > 0) {
      return err({
        kind: 'unavailable',
        message: `Nexus registry is missing ${missing
          .map(({ packageName, version }) => `${packageName}@${version}`)
          .join(', ')}`,
        retryable: false,
        missing,
      });
    }

    return ok({
      channel: parsed.data.channel,
      observedAt: new Date().toISOString(),
      packages,
    });
  }
}
