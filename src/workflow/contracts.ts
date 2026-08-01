import { z } from 'zod';

import { AbiIdSchema, AbiVersionSchema, SlotPolicySchema, WaitReferenceSchema } from './schema.js';

const RuntimeSchemaSchema = z.custom<z.ZodType>(
  (value) => value instanceof z.ZodType,
  'Expected a Zod runtime schema',
);

const EffectKindSchema = z.string().min(1);
const CapabilitySchema = z.string().min(1);
const ArtifactKindSchema = z.string().min(1);
const ResumeBoundarySchema = z.enum(['none', 'attempt', 'step']);
const IdempotencySchema = z.enum(['none', 'key', 'probe']);

export const ReconciliationContractSchema = z.object({
  strategy: z.enum(['probe', 'receipt']),
  description: z.string().min(1).optional(),
});

export const StepTypeContractSchema = z.object({
  id: AbiIdSchema,
  version: AbiVersionSchema,
  inputSchema: RuntimeSchemaSchema,
  outputSchema: RuntimeSchemaSchema,
  allowedEffects: z.array(EffectKindSchema).default([]),
  requiredCapabilities: z.array(CapabilitySchema).default([]),
  resumeBoundary: ResumeBoundarySchema.default('none'),
  idempotency: IdempotencySchema.default('none'),
  retryPolicy: z.string().min(1).optional(),
  waitKinds: z.array(WaitReferenceSchema).default([]),
  artifactContracts: z.array(ArtifactKindSchema).default([]),
  redactionPolicy: z.string().min(1).optional(),
  reconciliation: ReconciliationContractSchema.optional(),
});

export const PredicateContractSchema = z.object({
  id: AbiIdSchema,
  version: AbiVersionSchema,
  inputSchema: RuntimeSchemaSchema,
  description: z.string().min(1).optional(),
});

export const WaitContractSchema = z.object({
  id: AbiIdSchema,
  version: AbiVersionSchema,
  resolutionSchema: RuntimeSchemaSchema.optional(),
  slotPolicy: SlotPolicySchema.optional(),
  description: z.string().min(1).optional(),
});

export type ReconciliationContract = z.infer<typeof ReconciliationContractSchema>;
export type StepTypeContract = z.infer<typeof StepTypeContractSchema>;
export type PredicateContract = z.infer<typeof PredicateContractSchema>;
export type WaitContract = z.infer<typeof WaitContractSchema>;

type VersionedContract = {
  readonly id: string;
  readonly version: string;
};

export interface ContractRegistry<T extends VersionedContract> {
  readonly entries: readonly T[];
  get(reference: string): T | undefined;
  has(reference: string): boolean;
}

export const toContractReference = (contract: VersionedContract): string =>
  `${contract.id}@${contract.version}`;

const createRegistry = <T extends VersionedContract>(
  schema: z.ZodType<T>,
  entries: readonly T[],
): ContractRegistry<T> => {
  const parsed = entries.map((entry) => schema.parse(entry));
  const map = new Map<string, T>();

  for (const entry of parsed) {
    const reference = toContractReference(entry);

    if (map.has(reference)) {
      throw new Error(`Duplicate contract registration for ${reference}`);
    }

    map.set(reference, entry);
  }

  const orderedEntries = [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => entry);

  return Object.freeze({
    entries: orderedEntries,
    get: (reference: string) => map.get(reference),
    has: (reference: string) => map.has(reference),
  });
};

export type StepTypeRegistry = ContractRegistry<StepTypeContract>;
export type PredicateRegistry = ContractRegistry<PredicateContract>;
export type WaitRegistry = ContractRegistry<WaitContract>;

export const createStepTypeRegistry = (entries: readonly StepTypeContract[]): StepTypeRegistry =>
  createRegistry(StepTypeContractSchema, entries);

export const createPredicateRegistry = (entries: readonly PredicateContract[]): PredicateRegistry =>
  createRegistry(PredicateContractSchema, entries);

export const createWaitRegistry = (entries: readonly WaitContract[]): WaitRegistry =>
  createRegistry(WaitContractSchema, entries);
