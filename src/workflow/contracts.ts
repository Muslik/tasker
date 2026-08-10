import { z } from 'zod';

import {
  AbiIdSchema,
  AbiVersionSchema,
  StepActivityDeliverySchema,
  WaitResolutionMappingSchema,
  WaitReferenceSchema,
} from './schema.js';
import { WorkflowChangeKindSchema } from './execution-result.js';

const RuntimeSchemaSchema = z.custom<z.ZodType>(
  (value) => value instanceof z.ZodType,
  'Expected a Zod runtime schema',
);

const EffectKindSchema = z.string().min(1);
const CapabilitySchema = z.string().min(1);
const ArtifactKindSchema = z.string().min(1);
const ResumeBoundarySchema = z.enum(['none', 'attempt', 'step']);
const IdempotencySchema = z.enum(['none', 'key', 'probe']);

export const WorkflowStageDescriptorSchema = z
  .object({ id: z.string().min(1), label: z.string().min(1) })
  .strict()
  .readonly();

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
  activityDelivery: StepActivityDeliverySchema.default({ kind: 'single_attempt' }),
  waitKinds: z.array(WaitReferenceSchema).default([]),
  artifactContracts: z.array(ArtifactKindSchema).default([]),
  requiredArtifactContracts: z.array(ArtifactKindSchema).default([]),
  workflowChanges: z.array(WorkflowChangeKindSchema).default([]),
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
  stage: WorkflowStageDescriptorSchema,
  resolutionSchema: RuntimeSchemaSchema.optional(),
  resolutionMapping: WaitResolutionMappingSchema.optional(),
  artifactContracts: z.array(ArtifactKindSchema).optional(),
  description: z.string().min(1).optional(),
});

export type ReconciliationContract = z.infer<typeof ReconciliationContractSchema>;
export type StepTypeContract = z.infer<typeof StepTypeContractSchema>;
export type StepTypeContractInput = z.input<typeof StepTypeContractSchema>;
export type PredicateContract = z.infer<typeof PredicateContractSchema>;
export type WaitContract = z.infer<typeof WaitContractSchema>;
export type WorkflowStageDescriptor = z.infer<typeof WorkflowStageDescriptorSchema>;

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

const createRegistry = <T extends VersionedContract, Input>(
  schema: z.ZodType<T, Input>,
  entries: readonly Input[],
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

export const createStepTypeRegistry = (
  entries: readonly StepTypeContractInput[],
): StepTypeRegistry => createRegistry(StepTypeContractSchema, entries);

export const createPredicateRegistry = (entries: readonly PredicateContract[]): PredicateRegistry =>
  createRegistry(PredicateContractSchema, entries);

export const createWaitRegistry = (entries: readonly WaitContract[]): WaitRegistry =>
  createRegistry(WaitContractSchema, entries);
