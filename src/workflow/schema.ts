import { z } from 'zod';

export const WORKFLOW_IR_VERSION = 'workflow-ir-v1';
export const WORKFLOW_COMPILER_VERSION = 4;

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export interface SequenceNodeSource {
  readonly kind: 'sequence';
  readonly id: string;
  readonly children: readonly WorkflowNodeSource[];
}

export interface StepNodeSource {
  readonly kind: 'step';
  readonly id: string;
  readonly uses: string;
  readonly with: JsonValue;
}

export const StepActivityDeliverySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('single_attempt') }).strict(),
  z.object({ kind: z.literal('read_only') }).strict(),
  z.object({ kind: z.literal('workspace_reconciled') }).strict(),
  z.object({ kind: z.literal('remote_reconciled') }).strict(),
]);

export type StepActivityDelivery = z.infer<typeof StepActivityDeliverySchema>;

export interface BranchNodeSource {
  readonly kind: 'branch';
  readonly id: string;
  readonly when: string;
  readonly then: WorkflowNodeSource;
  readonly otherwise: WorkflowNodeSource;
}

export interface BoundedLoopNodeSource {
  readonly kind: 'bounded_loop';
  readonly id: string;
  readonly maxAttempts: number;
  readonly until: string;
  readonly checkBefore: boolean;
  readonly exhaustedWait?: string | undefined;
  readonly body: WorkflowNodeSource;
}

export interface WaitNodeSource {
  readonly kind: 'wait';
  readonly id: string;
  readonly for: string;
  readonly resumeAt?: string | undefined;
}

export interface GateNodeSource {
  readonly kind: 'gate';
  readonly id: string;
  readonly reason: string;
  readonly resumeWhen: string;
  readonly with?: JsonValue | undefined;
}

export interface FinalizeNodeSource {
  readonly kind: 'finalize';
  readonly id: string;
  readonly outcome: string;
}

export type WorkflowNodeSource =
  | BranchNodeSource
  | BoundedLoopNodeSource
  | FinalizeNodeSource
  | GateNodeSource
  | SequenceNodeSource
  | StepNodeSource
  | WaitNodeSource;

export interface WorkflowSource {
  readonly id: string;
  readonly version: number;
  readonly root: WorkflowNodeSource;
}

export interface ValidationIssue {
  readonly code:
    | 'duplicate_node_id'
    | 'effectful_step_without_reconciliation_metadata'
    | 'invalid_predicate_input'
    | 'invalid_step_input'
    | 'invalid_loop_bounds'
    | 'invalid_source'
    | 'invalid_terminal_structure'
    | 'missing_terminal_path'
    | 'required_planning_boundary_missing'
    | 'unsatisfied_workflow_obligation'
    | 'unknown_resume_target'
    | 'unknown_reference'
    | 'wait_without_resolution_contract';
  readonly message: string;
  readonly path: readonly (number | string)[];
  readonly details?: JsonValue | undefined;
}

export interface ValidationReport {
  readonly workflowId?: string | undefined;
  readonly issues: readonly ValidationIssue[];
}

export interface CompiledSequenceNode {
  readonly kind: 'sequence';
  readonly id: string;
  readonly children: readonly CompiledWorkflowNode[];
}

export interface CompiledStepNode {
  readonly kind: 'step';
  readonly id: string;
  readonly uses: string;
  readonly activityDelivery: StepActivityDelivery;
  readonly with: JsonValue;
}

export interface CompiledBranchNode {
  readonly kind: 'branch';
  readonly id: string;
  readonly when: string;
  readonly then: CompiledWorkflowNode;
  readonly otherwise: CompiledWorkflowNode;
}

export interface CompiledBoundedLoopNode {
  readonly kind: 'bounded_loop';
  readonly id: string;
  readonly maxAttempts: number;
  readonly until: string;
  readonly checkBefore: boolean;
  readonly exhaustedWait?: string | undefined;
  readonly body: CompiledWorkflowNode;
}

export interface WaitResolutionMapping {
  readonly discriminator: string;
  readonly cases: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
}

export interface OutputPredicateMapping {
  readonly discriminator: string;
  readonly cases: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  readonly defaultFacts?: Readonly<Record<string, boolean>> | undefined;
}

export interface CompiledWaitNode {
  readonly kind: 'wait';
  readonly id: string;
  readonly for: string;
  readonly resolutionMapping?: WaitResolutionMapping | undefined;
  readonly resumeAt?: string | undefined;
}

export interface CompiledGateNode {
  readonly kind: 'gate';
  readonly id: string;
  readonly reason: string;
  readonly resumeWhen: string;
  readonly with?: JsonValue | undefined;
}

export interface CompiledFinalizeNode {
  readonly kind: 'finalize';
  readonly id: string;
  readonly outcome: string;
}

export type CompiledWorkflowNode =
  | CompiledBranchNode
  | CompiledBoundedLoopNode
  | CompiledFinalizeNode
  | CompiledGateNode
  | CompiledSequenceNode
  | CompiledStepNode
  | CompiledWaitNode;

export interface CompiledWorkflow {
  readonly metadata: {
    readonly compilerVersion: typeof WORKFLOW_COMPILER_VERSION;
    readonly irVersion: typeof WORKFLOW_IR_VERSION;
    readonly references: {
      readonly predicates: readonly string[];
      readonly stepTypes: readonly string[];
      readonly waits: readonly string[];
    };
    readonly workflowId: string;
    readonly workflowVersion: number;
  };
  readonly root: CompiledWorkflowNode;
}

export interface CompiledWorkflowArtifact {
  readonly canonicalJson: string;
  readonly graph: CompiledWorkflow;
  readonly hash: string;
  readonly validatorReport: ValidationReport;
}

const jsonRecord = z.record(
  z.string(),
  z.lazy(() => JsonValueSchema),
);

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), jsonRecord]),
);

export const NodeIdSchema = z.string().min(1);
export const WorkflowIdSchema = z.string().min(1);
export const WorkflowVersionSchema = z.number().int().positive();
export const AbiIdSchema = z.string().min(1);
export const AbiVersionSchema = z.string().min(1);
export const AbiReferenceSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/, 'Expected an ABI-versioned reference');

export const StepTypeReferenceSchema = AbiReferenceSchema;
export const PredicateReferenceSchema = AbiReferenceSchema;
export const WaitReferenceSchema = AbiReferenceSchema;

export const SequenceNodeSourceSchema = z
  .object({
    kind: z.literal('sequence'),
    id: NodeIdSchema,
    children: z.array(z.lazy(() => WorkflowNodeSourceSchema)).min(1),
  })
  .strict();

export const StepNodeSourceSchema = z
  .object({
    kind: z.literal('step'),
    id: NodeIdSchema,
    uses: StepTypeReferenceSchema,
    with: JsonValueSchema,
  })
  .strict();

export const BranchNodeSourceSchema = z
  .object({
    kind: z.literal('branch'),
    id: NodeIdSchema,
    when: PredicateReferenceSchema,
    then: z.lazy(() => WorkflowNodeSourceSchema),
    otherwise: z.lazy(() => WorkflowNodeSourceSchema),
  })
  .strict();

export const BoundedLoopNodeSourceSchema = z
  .object({
    kind: z.literal('bounded_loop'),
    id: NodeIdSchema,
    maxAttempts: z.number(),
    until: PredicateReferenceSchema,
    checkBefore: z.boolean().default(false),
    exhaustedWait: WaitReferenceSchema.optional(),
    body: z.lazy(() => WorkflowNodeSourceSchema),
  })
  .strict();

export const WaitNodeSourceSchema = z
  .object({
    kind: z.literal('wait'),
    id: NodeIdSchema,
    for: WaitReferenceSchema,
    resumeAt: z.string().min(1).optional(),
  })
  .strict();

export const GateNodeSourceSchema = z
  .object({
    kind: z.literal('gate'),
    id: NodeIdSchema,
    reason: z.string().min(1),
    resumeWhen: PredicateReferenceSchema,
    with: JsonValueSchema.optional(),
  })
  .strict();

export const FinalizeNodeSourceSchema = z
  .object({
    kind: z.literal('finalize'),
    id: NodeIdSchema,
    outcome: z.string().min(1),
  })
  .strict();

export const WorkflowNodeSourceSchema = z.lazy(() =>
  z.union([
    SequenceNodeSourceSchema,
    StepNodeSourceSchema,
    BranchNodeSourceSchema,
    BoundedLoopNodeSourceSchema,
    WaitNodeSourceSchema,
    GateNodeSourceSchema,
    FinalizeNodeSourceSchema,
  ]),
) as z.ZodType<WorkflowNodeSource>;

export const WorkflowSourceSchema = z
  .object({
    id: WorkflowIdSchema,
    version: WorkflowVersionSchema,
    root: WorkflowNodeSourceSchema,
  })
  .strict() as z.ZodType<WorkflowSource>;

export const ValidationIssueCodeSchema = z.enum([
  'duplicate_node_id',
  'effectful_step_without_reconciliation_metadata',
  'invalid_predicate_input',
  'invalid_step_input',
  'invalid_loop_bounds',
  'invalid_source',
  'invalid_terminal_structure',
  'missing_terminal_path',
  'required_planning_boundary_missing',
  'unsatisfied_workflow_obligation',
  'unknown_resume_target',
  'unknown_reference',
  'wait_without_resolution_contract',
]);

export const ValidationIssueSchema = z.object({
  code: ValidationIssueCodeSchema,
  message: z.string().min(1),
  path: z.array(z.union([z.string(), z.number()])),
  details: JsonValueSchema.optional(),
}) as z.ZodType<ValidationIssue>;

export const ValidationReportSchema = z.object({
  workflowId: WorkflowIdSchema.optional(),
  issues: z.array(ValidationIssueSchema),
}) as z.ZodType<ValidationReport>;

const CompiledSequenceNodeSchema = z.object({
  kind: z.literal('sequence'),
  id: NodeIdSchema,
  children: z.array(z.lazy(() => CompiledWorkflowNodeSchema)),
});

const CompiledStepNodeSchema = z.object({
  kind: z.literal('step'),
  id: NodeIdSchema,
  uses: StepTypeReferenceSchema,
  activityDelivery: StepActivityDeliverySchema,
  with: JsonValueSchema,
});

const CompiledBranchNodeSchema = z.object({
  kind: z.literal('branch'),
  id: NodeIdSchema,
  when: PredicateReferenceSchema,
  then: z.lazy(() => CompiledWorkflowNodeSchema),
  otherwise: z.lazy(() => CompiledWorkflowNodeSchema),
});

const CompiledBoundedLoopNodeSchema = z.object({
  kind: z.literal('bounded_loop'),
  id: NodeIdSchema,
  maxAttempts: z.number(),
  until: PredicateReferenceSchema,
  checkBefore: z.boolean(),
  exhaustedWait: WaitReferenceSchema.optional(),
  body: z.lazy(() => CompiledWorkflowNodeSchema),
});

export const WaitResolutionMappingSchema = z
  .object({
    discriminator: z.string().min(1),
    cases: z.record(
      z.string().min(1),
      z
        .record(PredicateReferenceSchema, z.boolean())
        .refine(
          (facts) => Object.keys(facts).length > 0,
          'A wait resolution case must set at least one predicate fact',
        ),
    ),
  })
  .strict();

export const OutputPredicateMappingSchema = z
  .object({
    discriminator: z.string().min(1),
    cases: z
      .record(
        z.string(),
        z
          .record(PredicateReferenceSchema, z.boolean())
          .refine(
            (facts) => Object.keys(facts).length > 0,
            'An output predicate case must set at least one predicate fact',
          ),
      )
      .refine(
        (cases) => Object.keys(cases).length > 0,
        'An output predicate mapping must declare at least one case',
      ),
    defaultFacts: z
      .record(PredicateReferenceSchema, z.boolean())
      .refine(
        (facts) => Object.keys(facts).length > 0,
        'Default output predicate facts must not be empty',
      )
      .optional(),
  })
  .strict();

export const resolveOutputPredicateFacts = (
  mapping: OutputPredicateMapping | undefined,
  output: JsonValue,
): Readonly<Record<string, boolean>> => {
  if (
    mapping === undefined ||
    output === null ||
    Array.isArray(output) ||
    typeof output !== 'object'
  ) {
    return {};
  }
  const discriminator = output[mapping.discriminator];
  if (
    typeof discriminator === 'boolean' ||
    typeof discriminator === 'number' ||
    typeof discriminator === 'string'
  ) {
    return mapping.cases[String(discriminator)] ?? mapping.defaultFacts ?? {};
  }
  return mapping.defaultFacts ?? {};
};

const CompiledWaitNodeSchema = z.object({
  kind: z.literal('wait'),
  id: NodeIdSchema,
  for: WaitReferenceSchema,
  resolutionMapping: WaitResolutionMappingSchema.optional(),
  resumeAt: z.string().min(1).optional(),
});

const CompiledGateNodeSchema = z.object({
  kind: z.literal('gate'),
  id: NodeIdSchema,
  reason: z.string().min(1),
  resumeWhen: PredicateReferenceSchema,
  with: JsonValueSchema.optional(),
});

const CompiledFinalizeNodeSchema = z.object({
  kind: z.literal('finalize'),
  id: NodeIdSchema,
  outcome: z.string().min(1),
});

export const CompiledWorkflowNodeSchema = z.lazy(() =>
  z.union([
    CompiledSequenceNodeSchema,
    CompiledStepNodeSchema,
    CompiledBranchNodeSchema,
    CompiledBoundedLoopNodeSchema,
    CompiledWaitNodeSchema,
    CompiledGateNodeSchema,
    CompiledFinalizeNodeSchema,
  ]),
) as z.ZodType<CompiledWorkflowNode>;

export const CompiledWorkflowSchema = z.object({
  metadata: z.object({
    compilerVersion: z.literal(WORKFLOW_COMPILER_VERSION),
    irVersion: z.literal(WORKFLOW_IR_VERSION),
    references: z.object({
      predicates: z.array(PredicateReferenceSchema),
      stepTypes: z.array(StepTypeReferenceSchema),
      waits: z.array(WaitReferenceSchema),
    }),
    workflowId: WorkflowIdSchema,
    workflowVersion: WorkflowVersionSchema,
  }),
  root: CompiledWorkflowNodeSchema,
}) as z.ZodType<CompiledWorkflow>;

export const CompiledWorkflowArtifactSchema = z.object({
  canonicalJson: z.string(),
  graph: CompiledWorkflowSchema,
  hash: z.string().length(64),
  validatorReport: ValidationReportSchema,
}) as z.ZodType<CompiledWorkflowArtifact>;
