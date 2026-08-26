import { z } from 'zod';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const NexusRegistryAuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('anonymous') }).strict(),
  z
    .object({
      kind: z.literal('bearer'),
      token: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('basic'),
      username: z.string().min(1),
      password: z.string().min(1),
    })
    .strict(),
]);

export const NexusRegistryConfigurationSchema = z
  .object({
    registryUrl: z.httpUrl(),
    auth: NexusRegistryAuthSchema,
    requestTimeoutMs: z.number().int().positive(),
  })
  .strict();

export type NexusRegistryConfiguration = z.infer<typeof NexusRegistryConfigurationSchema>;

export const loadNexusRegistryConfiguration = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): NexusRegistryConfiguration | null => {
  const registryUrl = environment.TASKER_NEXUS_REGISTRY_URL?.trim();
  const authKind = environment.TASKER_NEXUS_AUTH_KIND?.trim();

  if (registryUrl === undefined || authKind === undefined) return null;

  const auth =
    authKind === 'anonymous'
      ? { kind: 'anonymous' as const }
      : authKind === 'bearer'
        ? {
            kind: 'bearer' as const,
            token: environment.TASKER_NEXUS_TOKEN?.trim(),
          }
        : authKind === 'basic'
          ? {
              kind: 'basic' as const,
              username: environment.TASKER_NEXUS_USERNAME?.trim(),
              password: environment.TASKER_NEXUS_PASSWORD?.trim(),
            }
          : null;
  if (auth === null) return null;

  const parsed = NexusRegistryConfigurationSchema.safeParse({
    registryUrl,
    auth,
    requestTimeoutMs: positiveInteger(
      environment.TASKER_NEXUS_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
  });

  return parsed.success
    ? { ...parsed.data, registryUrl: parsed.data.registryUrl.replace(/\/$/u, '') }
    : null;
};
