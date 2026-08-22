import { createHash } from 'node:crypto';

import { z } from 'zod';

import { err, ok, type Outcome } from '../shared/outcome.js';
import { compileWorkflow, type WorkflowCompilerContracts } from './compiler.js';
import {
  CompiledWorkflowArtifactSchema,
  JsonValueSchema,
  ValidationReportSchema,
  type JsonValue,
  type ValidationReport,
  type WorkflowNodeSource,
  type WorkflowSource,
} from './schema.js';
import {
  SEMANTIC_WORKFLOW_IR_VERSION,
  SemanticWorkflowSourceSchema,
  type SemanticNodeSource,
  type SemanticWorkflowSource,
} from './semantic-schema.js';

const INTERNAL_FINALIZE_ID = '__tasker_complete';

export const SemanticWorkflowArtifactSchema = z
  .object({
    semanticIrVersion: z.literal(SEMANTIC_WORKFLOW_IR_VERSION),
    semanticCanonicalJson: z.string().min(1),
    semanticHash: z.string().regex(/^[a-f0-9]{64}$/u),
    source: SemanticWorkflowSourceSchema,
    compiled: CompiledWorkflowArtifactSchema,
  })
  .strict();

export type SemanticWorkflowArtifact = z.infer<typeof SemanticWorkflowArtifactSchema>;

export interface CompileSemanticWorkflowOptions {
  readonly contracts: WorkflowCompilerContracts;
  readonly source: unknown;
  readonly loopExhaustedWait: string;
  readonly terminalOutcome?: string;
}

const canonicalizeJson = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === 'object') {
    const canonical = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
      const child = value[key];
      if (child !== undefined) canonical[key] = canonicalizeJson(child);
    }
    return canonical;
  }
  return value;
};

const validationReportFor = (source: unknown, issues: z.core.$ZodIssue[]): ValidationReport => {
  const workflowId =
    source !== null &&
    typeof source === 'object' &&
    'id' in source &&
    typeof source.id === 'string' &&
    source.id.length > 0
      ? source.id
      : undefined;
  return ValidationReportSchema.parse({
    ...(workflowId === undefined ? {} : { workflowId }),
    issues: [
      {
        code: 'invalid_source',
        message: 'Semantic workflow source does not match its strict contract',
        path: [],
        details: {
          issues: issues.map((issue) => ({
            code: issue.code,
            message: issue.message,
            path: issue.path.filter(
              (part): part is number | string =>
                typeof part === 'number' || typeof part === 'string',
            ),
          })),
        },
      },
    ],
  });
};

const lowerNode = (node: SemanticNodeSource, loopExhaustedWait: string): WorkflowNodeSource => {
  switch (node.kind) {
    case 'step':
      return { kind: 'step', id: node.id, uses: node.uses, with: node.with };
    case 'sequence':
      return {
        kind: 'sequence',
        id: node.id,
        children: node.children.map((child) => lowerNode(child, loopExhaustedWait)),
      };
    case 'bounded_loop':
      return {
        kind: 'bounded_loop',
        id: node.id,
        maxAttempts: node.maxAttempts,
        until: node.until,
        checkBefore: false,
        exhaustedWait: loopExhaustedWait,
        body: lowerNode(node.body, loopExhaustedWait),
      };
  }
};

const lowerSource = (
  source: SemanticWorkflowSource,
  loopExhaustedWait: string,
  terminalOutcome: string,
): WorkflowSource => ({
  id: source.id,
  version: source.version,
  root: {
    kind: 'sequence',
    id: source.root.id,
    children: [
      ...source.root.children.map((child) => lowerNode(child, loopExhaustedWait)),
      { kind: 'finalize', id: INTERNAL_FINALIZE_ID, outcome: terminalOutcome },
    ],
  },
});

export const compileSemanticWorkflow = (
  options: CompileSemanticWorkflowOptions,
): Outcome<SemanticWorkflowArtifact, ValidationReport> => {
  const parsed = SemanticWorkflowSourceSchema.safeParse(options.source);
  if (!parsed.success) return err(validationReportFor(options.source, parsed.error.issues));

  const canonicalSource = canonicalizeJson(
    JsonValueSchema.parse(parsed.data),
  ) as unknown as SemanticWorkflowSource;
  const semanticCanonicalJson = JSON.stringify(canonicalSource);
  const semanticHash = createHash('sha256').update(semanticCanonicalJson).digest('hex');
  const compiled = compileWorkflow({
    contracts: options.contracts,
    source: lowerSource(
      canonicalSource,
      options.loopExhaustedWait,
      options.terminalOutcome ?? 'accepted',
    ),
  });
  if (!compiled.ok) return compiled;

  return ok(
    SemanticWorkflowArtifactSchema.parse({
      semanticIrVersion: SEMANTIC_WORKFLOW_IR_VERSION,
      semanticCanonicalJson,
      semanticHash,
      source: canonicalSource,
      compiled: compiled.value,
    }),
  );
};
