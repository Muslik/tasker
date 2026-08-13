import {
  getHarnessPack,
  harnessPolicyAppliesToTask,
  harnessPolicyStepMarkerMatches,
  type HarnessPolicyManifest,
  type HarnessPolicyMarker,
} from '../harness/index.js';
import type {
  CompiledWorkflow,
  CompiledWorkflowNode,
  JsonValue,
  ValidationIssue,
  ValidationReport,
} from '../workflow/index.js';
import { HARNESS_WORKFLOW_CONTRACTS } from './contracts.js';

interface PolicyTask {
  readonly origin: string;
}

interface ExecutionMarker {
  readonly id: string;
  readonly kind: 'gate' | 'predicate' | 'step' | 'wait';
  readonly reference: string;
  readonly input?: JsonValue;
}

const concatenatePaths = (
  left: readonly (readonly ExecutionMarker[])[],
  right: readonly (readonly ExecutionMarker[])[],
): readonly (readonly ExecutionMarker[])[] =>
  left.flatMap((prefix) => right.map((suffix) => [...prefix, ...suffix]));

const executionPaths = (node: CompiledWorkflowNode): readonly (readonly ExecutionMarker[])[] => {
  switch (node.kind) {
    case 'step':
      return [[{ id: node.id, kind: 'step', reference: node.uses, input: node.with }]];
    case 'wait':
      return [[{ id: node.id, kind: 'wait', reference: node.for }]];
    case 'gate':
      return [[{ id: node.id, kind: 'gate', reference: node.resumeWhen }]];
    case 'sequence':
      return node.children.reduce<readonly (readonly ExecutionMarker[])[]>(
        (paths, child) => concatenatePaths(paths, executionPaths(child)),
        [[]],
      );
    case 'branch':
      return [
        ...executionPaths(node.then).map((path) => [
          { id: `${node.id}:then`, kind: 'predicate' as const, reference: node.when },
          ...path,
        ]),
        ...executionPaths(node.otherwise),
      ];
    case 'bounded_loop': {
      const completion = {
        id: `${node.id}:until`,
        kind: 'predicate' as const,
        reference: node.until,
      };
      const afterIteration = executionPaths(node.body).map((path) => [...path, completion]);
      return node.checkBefore ? [[completion], ...afterIteration] : afterIteration;
    }
    case 'finalize':
      return [[]];
  }
};

const issue = (
  obligationId: string,
  message: string,
  path: readonly (string | number)[],
): ValidationIssue => ({
  code: 'unsatisfied_workflow_obligation',
  message,
  path,
  details: { obligationId },
});

const markerMatches = (marker: ExecutionMarker, required: HarnessPolicyMarker): boolean => {
  if (required.kind === 'effect') {
    return (
      marker.kind === 'step' &&
      HARNESS_WORKFLOW_CONTRACTS.stepTypes
        .get(marker.reference)
        ?.allowedEffects.includes(required.reference) === true
    );
  }
  if (required.kind === 'step') {
    return (
      marker.kind === 'step' &&
      harnessPolicyStepMarkerMatches(required, marker.reference, marker.input)
    );
  }
  return marker.kind === required.kind && marker.reference === required.reference;
};

const validateRequiredArtifacts = (
  paths: readonly (readonly ExecutionMarker[])[],
): readonly ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  paths.forEach((path, pathIndex) => {
    path.forEach((marker, markerIndex) => {
      if (marker.kind !== 'step') return;
      const contract = HARNESS_WORKFLOW_CONTRACTS.stepTypes.get(marker.reference);
      const earlier = path.slice(0, markerIndex);
      for (const requiredArtifact of contract?.requiredArtifactContracts ?? []) {
        const hasProducer = earlier.some((candidate) => {
          const artifacts =
            candidate.kind === 'step'
              ? HARNESS_WORKFLOW_CONTRACTS.stepTypes.get(candidate.reference)?.artifactContracts
              : candidate.kind === 'wait'
                ? HARNESS_WORKFLOW_CONTRACTS.waits.get(candidate.reference)?.artifactContracts
                : undefined;
          return artifacts?.includes(requiredArtifact) === true;
        });
        if (!hasProducer) {
          issues.push(
            issue(
              'artifact-producer-before-consumer',
              `Step ${marker.id} requires artifact ${requiredArtifact} from an earlier node on this execution path`,
              ['root', 'executionPaths', pathIndex, marker.id],
            ),
          );
        }
      }
    });
  });
  return issues;
};

const validatePolicySequence = (
  paths: readonly (readonly ExecutionMarker[])[],
  policy: HarnessPolicyManifest,
): readonly ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  for (const obligation of policy.obligations) {
    paths.forEach((path, pathIndex) => {
      const triggerPositions = path.flatMap((marker, index) =>
        markerMatches(marker, obligation.trigger) ? [index] : [],
      );
      for (const triggerPosition of triggerPositions) {
        const candidates =
          obligation.direction === 'after'
            ? path.slice(triggerPosition + 1)
            : path.slice(0, triggerPosition).reverse();
        const required =
          obligation.direction === 'after' ? obligation.ordered : [...obligation.ordered].reverse();
        let cursor = 0;
        const missing = required.find((marker) => {
          const match = candidates.findIndex(
            (candidate, index) => index >= cursor && markerMatches(candidate, marker),
          );
          if (match < 0) return true;
          cursor = match + 1;
          return false;
        });
        if (missing !== undefined) {
          issues.push(
            issue(
              obligation.id,
              `Policy ${policy.id}@${policy.version} requires ${missing.kind} ${missing.reference} ${obligation.direction} ${obligation.trigger.reference}`,
              ['root', 'executionPaths', pathIndex, triggerPosition],
            ),
          );
        }
      }
    });
  }
  return issues;
};

export const validateWorkflowObligations = (
  graph: CompiledWorkflow,
  task: PolicyTask,
  policies: readonly HarnessPolicyManifest[] = getHarnessPack().policies,
): ValidationReport => {
  const paths = executionPaths(graph.root);
  const applicablePolicies = policies.filter((policy) => harnessPolicyAppliesToTask(policy, task));
  const applicablePolicyIds = new Set(applicablePolicies.map(({ id }) => id));
  const issues = [...validateRequiredArtifacts(paths)];

  for (const marker of paths.flat()) {
    if (marker.kind !== 'step') continue;
    const owner = getHarnessPack().steps.find(
      ({ reference }) => reference === marker.reference,
    )?.policy;
    if (owner !== undefined && !applicablePolicyIds.has(owner)) {
      issues.push(
        issue(
          'policy-owned-step-not-applicable',
          `Step ${marker.reference} belongs to policy ${owner}, which does not apply to task origin ${task.origin}`,
          ['root', marker.id],
        ),
      );
    }
  }

  for (const policy of applicablePolicies) {
    issues.push(...validatePolicySequence(paths, policy));
  }

  return { workflowId: graph.metadata.workflowId, issues };
};
