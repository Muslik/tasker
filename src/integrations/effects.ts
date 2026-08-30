import { z } from 'zod';

import type { LedgerRepository } from '../ledger/repository.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { canonicalJson } from '../shared/json.js';
import { JsonValueSchema, type JsonValue } from '../workflow/schema.js';

const ExternalEffectIdentitySchema = z
  .object({
    operationId: z.string().min(1),
    effectId: z.string().regex(/^[a-z][a-z0-9.-]*$/u),
    effectKind: z.string().min(1),
  })
  .strict();

export const ExternalEffectIntentSchema = ExternalEffectIdentitySchema.extend({
  schemaVersion: z.literal(1),
  identity: JsonValueSchema,
  preparedAt: z.iso.datetime(),
}).strict();

export const ExternalEffectReceiptSchema = ExternalEffectIdentitySchema.extend({
  schemaVersion: z.literal(1),
  status: z.literal('applied'),
  result: JsonValueSchema,
  appliedAt: z.iso.datetime(),
}).strict();

export type ExternalEffectIntent = z.infer<typeof ExternalEffectIntentSchema>;
export type ExternalEffectReceipt = z.infer<typeof ExternalEffectReceiptSchema>;

export type ExternalEffectStoreError =
  | {
      readonly kind: 'intent_mismatch';
      readonly artifactId: string;
    }
  | {
      readonly kind: 'artifact_corrupt';
      readonly artifactId: string;
      readonly issues: readonly string[];
    }
  | { readonly kind: 'ledger_conflict' };

const aggregateIdFor = (operationId: string, effectId: string): string =>
  `external-effect:${operationId}:${effectId}`;

const intentArtifactIdFor = (aggregateId: string): string => `${aggregateId}:intent`;
const receiptArtifactIdFor = (aggregateId: string): string => `${aggregateId}:receipt`;

const issues = (error: z.ZodError): readonly string[] =>
  error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`);

const sameJson = (left: JsonValue, right: JsonValue): boolean =>
  canonicalJson(left) === canonicalJson(right);

export class ExternalEffectStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public prepare(input: {
    readonly operationId: string;
    readonly effectId: string;
    readonly effectKind: string;
    readonly identity: JsonValue;
  }): Outcome<ExternalEffectIntent, ExternalEffectStoreError> {
    const aggregateId = aggregateIdFor(input.operationId, input.effectId);
    const artifactId = intentArtifactIdFor(aggregateId);
    const existing = this.ledger.readArtifact(artifactId);
    if (existing !== null) {
      const parsed = ExternalEffectIntentSchema.safeParse(existing.payload);
      if (!parsed.success) {
        return err({ kind: 'artifact_corrupt', artifactId, issues: issues(parsed.error) });
      }
      return parsed.data.operationId === input.operationId &&
        parsed.data.effectId === input.effectId &&
        parsed.data.effectKind === input.effectKind &&
        sameJson(parsed.data.identity, input.identity)
        ? ok(parsed.data)
        : err({ kind: 'intent_mismatch', artifactId });
    }

    const intent = ExternalEffectIntentSchema.parse({
      schemaVersion: 1,
      ...input,
      preparedAt: this.clock.now(),
    });
    const committed = this.ledger.transact({
      aggregate: {
        aggregateId,
        expectedVersion: 0,
        events: [
          {
            eventId: `event:${aggregateId}:intent`,
            eventType: 'ExternalEffectIntentPrepared',
            eventSchemaVersion: 1,
            payload: { artifactId },
            actor: 'integration',
          },
        ],
      },
      artifacts: [
        {
          artifactId,
          artifactKind: 'external_effect_intent',
          storageUri: `ledger://artifacts/${artifactId}`,
          payload: intent,
          metadata: {
            operationId: intent.operationId,
            effectId: intent.effectId,
            effectKind: intent.effectKind,
          },
          createdAt: intent.preparedAt,
        },
      ],
      timestamp: intent.preparedAt,
    });
    if (committed.ok) return ok(intent);

    const raced = this.ledger.readArtifact(artifactId);
    if (raced === null) return err({ kind: 'ledger_conflict' });
    const parsed = ExternalEffectIntentSchema.safeParse(raced.payload);
    if (!parsed.success) {
      return err({ kind: 'artifact_corrupt', artifactId, issues: issues(parsed.error) });
    }
    return parsed.data.operationId === input.operationId &&
      parsed.data.effectId === input.effectId &&
      parsed.data.effectKind === input.effectKind &&
      sameJson(parsed.data.identity, input.identity)
      ? ok(parsed.data)
      : err({ kind: 'intent_mismatch', artifactId });
  }

  public readReceipt(
    operationId: string,
    effectId: string,
  ): Outcome<ExternalEffectReceipt | null, ExternalEffectStoreError> {
    const artifactId = receiptArtifactIdFor(aggregateIdFor(operationId, effectId));
    const artifact = this.ledger.readArtifact(artifactId);
    if (artifact === null) return ok(null);
    const parsed = ExternalEffectReceiptSchema.safeParse(artifact.payload);
    return parsed.success
      ? ok(parsed.data)
      : err({ kind: 'artifact_corrupt', artifactId, issues: issues(parsed.error) });
  }

  public recordApplied(input: {
    readonly operationId: string;
    readonly effectId: string;
    readonly effectKind: string;
    readonly result: JsonValue;
  }): Outcome<ExternalEffectReceipt, ExternalEffectStoreError> {
    const aggregateId = aggregateIdFor(input.operationId, input.effectId);
    const artifactId = receiptArtifactIdFor(aggregateId);
    const existing = this.readReceipt(input.operationId, input.effectId);
    if (!existing.ok) return existing;
    if (existing.value !== null) {
      return existing.value.effectKind === input.effectKind &&
        sameJson(existing.value.result, input.result)
        ? ok(existing.value)
        : err({ kind: 'intent_mismatch', artifactId });
    }

    const receipt = ExternalEffectReceiptSchema.parse({
      schemaVersion: 1,
      ...input,
      status: 'applied',
      appliedAt: this.clock.now(),
    });
    const committed = this.ledger.transact({
      aggregate: {
        aggregateId,
        expectedVersion: 1,
        events: [
          {
            eventId: `event:${aggregateId}:receipt`,
            eventType: 'ExternalEffectApplied',
            eventSchemaVersion: 1,
            payload: { artifactId },
            actor: 'integration',
          },
        ],
      },
      artifacts: [
        {
          artifactId,
          artifactKind: 'external_effect_receipt',
          storageUri: `ledger://artifacts/${artifactId}`,
          payload: receipt,
          metadata: {
            operationId: receipt.operationId,
            effectId: receipt.effectId,
            effectKind: receipt.effectKind,
          },
          createdAt: receipt.appliedAt,
          parentArtifactId: intentArtifactIdFor(aggregateId),
        },
      ],
      timestamp: receipt.appliedAt,
    });
    if (committed.ok) return ok(receipt);

    const raced = this.readReceipt(input.operationId, input.effectId);
    if (!raced.ok) return raced;
    if (raced.value === null) return err({ kind: 'ledger_conflict' });
    return raced.value.effectKind === input.effectKind && sameJson(raced.value.result, input.result)
      ? ok(raced.value)
      : err({ kind: 'intent_mismatch', artifactId });
  }

  public intentArtifactId(operationId: string, effectId: string): string {
    return intentArtifactIdFor(aggregateIdFor(operationId, effectId));
  }

  public receiptArtifactId(operationId: string, effectId: string): string {
    return receiptArtifactIdFor(aggregateIdFor(operationId, effectId));
  }
}
