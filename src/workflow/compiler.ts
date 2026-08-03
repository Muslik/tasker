import { createHash } from 'node:crypto';

import { err, ok, type Outcome } from '../shared/outcome.js';
import type { PredicateRegistry, StepTypeRegistry, WaitRegistry } from './contracts.js';
import type {
  CompiledWorkflow,
  CompiledWorkflowArtifact,
  CompiledWorkflowNode,
  JsonValue,
  ValidationIssue,
  ValidationReport,
  WorkflowNodeSource,
  WorkflowSource,
} from './schema.js';
import {
  CompiledWorkflowArtifactSchema,
  WORKFLOW_COMPILER_VERSION,
  WORKFLOW_IR_VERSION,
  WorkflowSourceSchema,
} from './schema.js';
import type { ZodError } from 'zod';

export interface WorkflowCompilerContracts {
  readonly predicates: PredicateRegistry;
  readonly stepTypes: StepTypeRegistry;
  readonly waits: WaitRegistry;
}

export interface CompileWorkflowOptions {
  readonly contracts: WorkflowCompilerContracts;
  readonly source: unknown;
}

type IssuePath = readonly (number | string)[];

interface ValidationContext {
  readonly contracts: WorkflowCompilerContracts;
  readonly duplicateIds: Map<string, IssuePath>;
  readonly issues: ValidationIssue[];
  readonly resumeTargets: {
    readonly nodeId: string;
    readonly path: IssuePath;
    readonly target: string;
  }[];
  readonly references: {
    readonly predicates: Set<string>;
    readonly stepTypes: Set<string>;
    readonly waits: Set<string>;
  };
}

interface TerminalAnalysis {
  readonly allPathsFinalize: boolean;
  readonly containsFinalize: boolean;
  readonly mayContinue: boolean;
}

const compareIssuePath = (left: IssuePath, right: IssuePath): number =>
  left.map(String).join('.').localeCompare(right.map(String).join('.'));

const sortIssues = (issues: readonly ValidationIssue[]): ValidationIssue[] =>
  [...issues].sort((left, right) => {
    const pathOrder = compareIssuePath(left.path, right.path);

    if (pathOrder !== 0) {
      return pathOrder;
    }

    const codeOrder = left.code.localeCompare(right.code);

    if (codeOrder !== 0) {
      return codeOrder;
    }

    return left.message.localeCompare(right.message);
  });

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);

    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }

  return value;
};

const canonicalizeJson = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, JsonValue>;
    // Null-prototype objects preserve literal "__proto__" keys during normalization.
    const canonical = Object.create(null) as Record<string, JsonValue>;

    for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
      const child = record[key];

      if (child === undefined) {
        continue;
      }

      canonical[key] = canonicalizeJson(child);
    }

    return canonical;
  }

  return value;
};

const addIssue = (
  context: ValidationContext,
  issue: Omit<ValidationIssue, 'path'> & { readonly path: IssuePath },
): void => {
  context.issues.push({
    ...issue,
    path: [...issue.path],
  });
};

const createValidationContext = (contracts: WorkflowCompilerContracts): ValidationContext => ({
  contracts,
  duplicateIds: new Map<string, IssuePath>(),
  issues: [],
  resumeTargets: [],
  references: {
    predicates: new Set<string>(),
    stepTypes: new Set<string>(),
    waits: new Set<string>(),
  },
});

const toIssuePath = (path: readonly PropertyKey[]): (number | string)[] =>
  path.filter(
    (segment): segment is number | string =>
      typeof segment === 'number' || typeof segment === 'string',
  );

const toSchemaIssueDetails = (error: ZodError): JsonValue => ({
  issues: error.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: toIssuePath(issue.path),
  })),
});

const validateSource = (source: unknown): WorkflowSource | ValidationReport => {
  const parsed = WorkflowSourceSchema.safeParse(source);

  if (parsed.success) {
    return source as WorkflowSource;
  }

  const workflowId =
    source !== null &&
    typeof source === 'object' &&
    'id' in source &&
    typeof source.id === 'string' &&
    source.id.length > 0
      ? source.id
      : undefined;

  return {
    ...(workflowId === undefined ? {} : { workflowId }),
    issues: sortIssues(
      parsed.error.issues.map((issue) => ({
        code: 'invalid_source',
        message: issue.message,
        path: toIssuePath(issue.path),
      })),
    ),
  };
};

const validateNodeId = (context: ValidationContext, nodeId: string, path: IssuePath): void => {
  const firstPath = context.duplicateIds.get(nodeId);

  if (firstPath !== undefined) {
    addIssue(context, {
      code: 'duplicate_node_id',
      message: `Duplicate workflow node ID "${nodeId}"`,
      path,
      details: {
        firstPath: firstPath.map(String),
        nodeId,
      },
    });

    return;
  }

  context.duplicateIds.set(nodeId, path);
};

const validateStepReference = (
  context: ValidationContext,
  reference: string,
  path: IssuePath,
): ReturnType<StepTypeRegistry['get']> => {
  context.references.stepTypes.add(reference);

  const contract = context.contracts.stepTypes.get(reference);

  if (contract === undefined) {
    const separatorIndex = reference.lastIndexOf('@');
    const requestedId = separatorIndex < 0 ? reference : reference.slice(0, separatorIndex);
    const hasOtherVersion = context.contracts.stepTypes.entries.some(
      (entry) => entry.id === requestedId,
    );

    addIssue(context, {
      code: 'unknown_reference',
      message: `Unknown step type "${reference}"`,
      path,
      details: {
        reference,
        referenceKind: 'step_type',
        recovery: hasOtherVersion ? 'quarantine' : 'reject',
      },
    });

    return;
  }

  if (
    contract.allowedEffects.length > 0 &&
    (contract.idempotency === 'none' || contract.reconciliation === undefined)
  ) {
    addIssue(context, {
      code: 'effectful_step_without_reconciliation_metadata',
      message: `Effectful step "${reference}" requires idempotency and reconciliation metadata`,
      path,
      details: {
        idempotency: contract.idempotency,
        reference,
      },
    });
  }

  return contract;
};

const validatePredicateReference = (
  context: ValidationContext,
  reference: string,
  path: IssuePath,
): ReturnType<PredicateRegistry['get']> => {
  context.references.predicates.add(reference);

  const contract = context.contracts.predicates.get(reference);

  if (contract === undefined) {
    addIssue(context, {
      code: 'unknown_reference',
      message: `Unknown predicate "${reference}"`,
      path,
      details: {
        reference,
        referenceKind: 'predicate',
      },
    });
  }

  return contract;
};

const validateWaitReference = (
  context: ValidationContext,
  reference: string,
  path: IssuePath,
): ReturnType<WaitRegistry['get']> => {
  context.references.waits.add(reference);

  const contract = context.contracts.waits.get(reference);

  if (contract === undefined) {
    addIssue(context, {
      code: 'unknown_reference',
      message: `Unknown wait kind "${reference}"`,
      path,
      details: {
        reference,
        referenceKind: 'wait',
      },
    });

    return;
  }

  if (contract.resolutionSchema === undefined) {
    addIssue(context, {
      code: 'wait_without_resolution_contract',
      message: `Wait "${reference}" is missing a resolution contract`,
      path,
      details: {
        reference,
      },
    });
  }

  return contract;
};

const normalizeNode = (
  context: ValidationContext,
  node: WorkflowNodeSource,
  path: IssuePath,
): CompiledWorkflowNode => {
  validateNodeId(context, node.id, [...path, 'id']);

  switch (node.kind) {
    case 'sequence':
      return {
        kind: 'sequence',
        id: node.id,
        children: node.children.map((child: WorkflowNodeSource, index: number) =>
          normalizeNode(context, child, [...path, 'children', index]),
        ),
      };

    case 'step': {
      const stepContract = validateStepReference(context, node.uses, [...path, 'uses']);

      if (stepContract !== undefined) {
        const parsedInput = stepContract.inputSchema.safeParse(node.with);

        if (!parsedInput.success) {
          addIssue(context, {
            code: 'invalid_step_input',
            message: `Step "${node.id}" payload does not match "${node.uses}" input schema`,
            path: [...path, 'with'],
            details: {
              reference: node.uses,
              issues: (toSchemaIssueDetails(parsedInput.error) as { readonly issues: JsonValue })
                .issues,
            },
          });
        }
      }

      return {
        kind: 'step',
        id: node.id,
        uses: node.uses,
        with: canonicalizeJson(node.with),
      };
    }

    case 'branch':
      validatePredicateReference(context, node.when, [...path, 'when']);

      return {
        kind: 'branch',
        id: node.id,
        when: node.when,
        then: normalizeNode(context, node.then, [...path, 'then']),
        otherwise: normalizeNode(context, node.otherwise, [...path, 'otherwise']),
      };

    case 'bounded_loop':
      validatePredicateReference(context, node.until, [...path, 'until']);

      if (!Number.isSafeInteger(node.maxAttempts) || node.maxAttempts <= 0) {
        addIssue(context, {
          code: 'invalid_loop_bounds',
          message: `Loop "${node.id}" must declare a positive safe integer maxAttempts`,
          path: [...path, 'maxAttempts'],
          details: {
            maxAttempts: node.maxAttempts,
          },
        });
      }

      return {
        kind: 'bounded_loop',
        id: node.id,
        maxAttempts: node.maxAttempts,
        until: node.until,
        body: normalizeNode(context, node.body, [...path, 'body']),
      };

    case 'wait': {
      validateWaitReference(context, node.for, [...path, 'for']);

      if (node.resumeAt !== undefined) {
        context.resumeTargets.push({
          nodeId: node.id,
          path: [...path, 'resumeAt'],
          target: node.resumeAt,
        });
      }

      return {
        kind: 'wait',
        id: node.id,
        for: node.for,
        ...(node.resumeAt === undefined ? {} : { resumeAt: node.resumeAt }),
      };
    }

    case 'gate': {
      const predicateContract = validatePredicateReference(context, node.resumeWhen, [
        ...path,
        'resumeWhen',
      ]);
      const predicateInput = node.with ?? {};

      if (predicateContract !== undefined) {
        const parsedInput = predicateContract.inputSchema.safeParse(predicateInput);

        if (!parsedInput.success) {
          addIssue(context, {
            code: 'invalid_predicate_input',
            message: `Gate "${node.id}" payload does not match "${node.resumeWhen}" predicate schema`,
            path: [...path, 'with'],
            details: {
              reference: node.resumeWhen,
              issues: (toSchemaIssueDetails(parsedInput.error) as { readonly issues: JsonValue })
                .issues,
            },
          });
        }
      }

      return {
        kind: 'gate',
        id: node.id,
        reason: node.reason,
        resumeWhen: node.resumeWhen,
        with: canonicalizeJson(predicateInput),
      };
    }

    case 'finalize':
      return {
        kind: 'finalize',
        id: node.id,
        outcome: node.outcome,
      };
  }

  throw new Error(`Unexpected workflow node kind: ${(node as { kind: string }).kind}`);
};

const analyzeTerminalStructure = (
  context: ValidationContext,
  node: CompiledWorkflowNode,
  path: IssuePath,
  insideLoopBody = false,
): TerminalAnalysis => {
  switch (node.kind) {
    case 'finalize':
      if (insideLoopBody) {
        addIssue(context, {
          code: 'invalid_terminal_structure',
          message: `Loop body "${node.id}" must not finalize the workflow`,
          path,
        });
      }

      return {
        allPathsFinalize: true,
        containsFinalize: true,
        mayContinue: false,
      };

    case 'step':
    case 'wait':
    case 'gate':
      return {
        allPathsFinalize: false,
        containsFinalize: false,
        mayContinue: true,
      };

    case 'branch': {
      const thenAnalysis = analyzeTerminalStructure(
        context,
        node.then,
        [...path, 'then'],
        insideLoopBody,
      );
      const otherwiseAnalysis = analyzeTerminalStructure(
        context,
        node.otherwise,
        [...path, 'otherwise'],
        insideLoopBody,
      );

      return {
        allPathsFinalize: thenAnalysis.allPathsFinalize && otherwiseAnalysis.allPathsFinalize,
        containsFinalize: thenAnalysis.containsFinalize || otherwiseAnalysis.containsFinalize,
        mayContinue: thenAnalysis.mayContinue || otherwiseAnalysis.mayContinue,
      };
    }

    case 'bounded_loop': {
      const bodyAnalysis = analyzeTerminalStructure(context, node.body, [...path, 'body'], true);

      if (bodyAnalysis.containsFinalize) {
        addIssue(context, {
          code: 'invalid_terminal_structure',
          message: `Loop "${node.id}" body must not contain finalize nodes`,
          path: [...path, 'body'],
        });
      }

      return {
        allPathsFinalize: false,
        containsFinalize: bodyAnalysis.containsFinalize,
        mayContinue: true,
      };
    }

    case 'sequence': {
      let activePathsRemain = true;
      let containsFinalize = false;

      for (let index = 0; index < node.children.length; index += 1) {
        const child = node.children[index];
        const childPath = [...path, 'children', index];

        if (child === undefined) {
          continue;
        }

        if (!activePathsRemain) {
          addIssue(context, {
            code: 'invalid_terminal_structure',
            message: `Node "${child.id}" cannot run after a guaranteed finalize path`,
            path: childPath,
          });

          continue;
        }

        const analysis = analyzeTerminalStructure(context, child, childPath, insideLoopBody);
        containsFinalize ||= analysis.containsFinalize;
        activePathsRemain = analysis.mayContinue;
      }

      return {
        allPathsFinalize: !activePathsRemain,
        containsFinalize,
        mayContinue: activePathsRemain,
      };
    }
  }

  throw new Error(`Unexpected compiled workflow node kind: ${(node as { kind: string }).kind}`);
};

const buildValidationReport = (
  workflowId: string | undefined,
  issues: readonly ValidationIssue[],
): ValidationReport =>
  deepFreeze({
    ...(workflowId === undefined ? {} : { workflowId }),
    issues: sortIssues(issues),
  });

const isValidationReport = (value: WorkflowSource | ValidationReport): value is ValidationReport =>
  'issues' in value;

const compileValidWorkflow = (
  source: WorkflowSource,
  context: ValidationContext,
): Outcome<CompiledWorkflowArtifact, ValidationReport> => {
  const root = normalizeNode(context, source.root, ['root']);

  for (const resumeTarget of context.resumeTargets) {
    if (!context.duplicateIds.has(resumeTarget.target)) {
      addIssue(context, {
        code: 'unknown_resume_target',
        message: `Wait "${resumeTarget.nodeId}" resumes at unknown node "${resumeTarget.target}"`,
        path: resumeTarget.path,
        details: {
          nodeId: resumeTarget.nodeId,
          resumeAt: resumeTarget.target,
        },
      });
    }
  }

  const terminalAnalysis = analyzeTerminalStructure(context, root, ['root']);

  if (terminalAnalysis.mayContinue) {
    addIssue(context, {
      code: 'missing_terminal_path',
      message: 'Workflow has an execution path without a finalize node',
      path: ['root'],
    });
  }

  if (context.issues.length > 0) {
    return err(buildValidationReport(source.id, context.issues));
  }

  const graph: CompiledWorkflow = {
    metadata: {
      compilerVersion: WORKFLOW_COMPILER_VERSION,
      irVersion: WORKFLOW_IR_VERSION,
      references: {
        predicates: [...context.references.predicates].sort((left, right) =>
          left.localeCompare(right),
        ),
        stepTypes: [...context.references.stepTypes].sort((left, right) =>
          left.localeCompare(right),
        ),
        waits: [...context.references.waits].sort((left, right) => left.localeCompare(right)),
      },
      workflowId: source.id,
      workflowVersion: source.version,
    },
    root,
  };

  const canonicalGraph = canonicalizeJson(
    graph as unknown as JsonValue,
  ) as unknown as CompiledWorkflow;
  const canonicalJson = JSON.stringify(canonicalGraph);
  const hash = createHash('sha256').update(canonicalJson).digest('hex');
  const artifact = deepFreeze({
    canonicalJson,
    graph: deepFreeze(canonicalGraph),
    hash,
    validatorReport: buildValidationReport(source.id, []),
  });

  CompiledWorkflowArtifactSchema.parse(artifact);

  return ok(deepFreeze(artifact));
};

export const validateWorkflow = (options: CompileWorkflowOptions): ValidationReport => {
  const sourceOrReport = validateSource(options.source);

  if (isValidationReport(sourceOrReport)) {
    return sourceOrReport;
  }

  const context = createValidationContext(options.contracts);
  const result = compileValidWorkflow(sourceOrReport, context);

  return result.ok ? result.value.validatorReport : result.error;
};

export const compileWorkflow = (
  options: CompileWorkflowOptions,
): Outcome<CompiledWorkflowArtifact, ValidationReport> => {
  const sourceOrReport = validateSource(options.source);

  if (isValidationReport(sourceOrReport)) {
    return err(sourceOrReport);
  }

  return compileValidWorkflow(sourceOrReport, createValidationContext(options.contracts));
};
