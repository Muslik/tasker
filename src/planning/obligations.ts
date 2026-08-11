import type { TaskFixture } from './fixtures.js';
import { M1_WORKFLOW_CONTRACTS } from './contracts.js';
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

export const WORKFLOW_OBLIGATIONS = [
  {
    id: 'write-requires-verification',
    trigger: 'a path contains a workspace.write step',
    requires: ['a validate.* step later on the same path'],
    reason: 'A write-capable path cannot become reviewable without task-selected verification.',
  },
  {
    id: 'write-requires-agent-review',
    trigger: 'a path contains a workspace.write step',
    requires: ['review.agent@1 later on the same path'],
    reason: 'A locally changed worktree must pass an independent agent review before publication.',
  },
  {
    id: 'write-requires-pr',
    trigger: 'a path contains a workspace.write step',
    requires: ['pr.prepare@1 later on the same path'],
    reason: 'Repository changes must reach the normal reviewable delivery boundary.',
  },
  {
    id: 'pr-requires-ci-and-review',
    trigger: 'a path prepares a pull request',
    requires: ['ci.observe@1 later on the same path', 'code_review@1 wait later on the same path'],
    reason: 'Every PR task must expose CI classification and the human review boundary.',
  },
  {
    id: 'pr-requires-passed-ci',
    trigger: 'a path prepares a pull request',
    requires: ['ci.passed@1 proven after exact-revision CI observation and before code review'],
    reason: 'A red or unclassified CI result must not fall through into human code review.',
  },
  {
    id: 'bug-requires-after-evidence',
    trigger: 'the admitted task is a bug',
    requires: ['bug.validate_fix@1 phase=after'],
    reason:
      'The frozen execution workflow must prove the bug no longer exists; before evidence belongs to pre-plan investigation.',
  },
] as const;

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

const phaseOf = (marker: ExecutionMarker): string | undefined => {
  if (
    marker.input === undefined ||
    marker.input === null ||
    Array.isArray(marker.input) ||
    typeof marker.input !== 'object'
  ) {
    return undefined;
  }
  const phase = marker.input.phase;
  return typeof phase === 'string' ? phase : undefined;
};

const markerMatches = (marker: ExecutionMarker, required: HarnessPolicyMarker): boolean => {
  if (required.kind === 'effect') {
    return (
      marker.kind === 'step' &&
      M1_WORKFLOW_CONTRACTS.stepTypes
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

export const validateWorkflowObligations = (
  graph: CompiledWorkflow,
  fixture: TaskFixture,
  policies: readonly HarnessPolicyManifest[] = getHarnessPack().policies,
): ValidationReport => {
  const issues: ValidationIssue[] = [];
  const paths = executionPaths(graph.root);

  paths.forEach((path, pathIndex) => {
    path.forEach((marker, markerIndex) => {
      if (marker.kind !== 'step') return;
      const later = path.slice(markerIndex + 1);
      const earlier = path.slice(0, markerIndex);
      const contract = M1_WORKFLOW_CONTRACTS.stepTypes.get(marker.reference);
      const nextReviewIndex = later.findIndex(
        (candidate) => candidate.kind === 'wait' && candidate.reference === 'code_review@1',
      );
      const beforeNextReview = nextReviewIndex < 0 ? later : later.slice(0, nextReviewIndex + 1);

      for (const requiredArtifact of contract?.requiredArtifactContracts ?? []) {
        const hasProducer = earlier.some((candidate) => {
          if (candidate.kind === 'step') {
            return (
              M1_WORKFLOW_CONTRACTS.stepTypes
                .get(candidate.reference)
                ?.artifactContracts.includes(requiredArtifact) === true
            );
          }
          if (candidate.kind === 'wait') {
            return (
              M1_WORKFLOW_CONTRACTS.waits
                .get(candidate.reference)
                ?.artifactContracts?.includes(requiredArtifact) === true
            );
          }
          return false;
        });
        if (!hasProducer) {
          issues.push(
            issue(
              'artifact-producer-before-consumer',
              `Step ${marker.id} requires artifact ${requiredArtifact} from an earlier step on this execution path`,
              ['root', 'executionPaths', pathIndex, marker.id],
            ),
          );
        }
      }

      if (
        contract?.allowedEffects.includes('workspace.write') === true &&
        !beforeNextReview.some(
          (candidate) => candidate.kind === 'step' && candidate.reference.startsWith('validate.'),
        )
      ) {
        issues.push(
          issue(
            'write-requires-verification',
            `Write-capable step ${marker.id} has no later verification step on this execution path`,
            ['root', 'executionPaths', pathIndex, marker.id],
          ),
        );
      }

      if (
        contract?.allowedEffects.includes('workspace.write') === true &&
        !beforeNextReview.some(
          (candidate) => candidate.kind === 'step' && candidate.reference === 'review.agent@1',
        )
      ) {
        issues.push(
          issue(
            'write-requires-agent-review',
            `Write-capable step ${marker.id} has no later independent review.agent@1 step on this execution path`,
            ['root', 'executionPaths', pathIndex, marker.id],
          ),
        );
      }

      if (
        contract?.allowedEffects.includes('workspace.write') === true &&
        !beforeNextReview.some(
          (candidate) => candidate.kind === 'step' && candidate.reference === 'pr.prepare@1',
        )
      ) {
        issues.push(
          issue(
            'write-requires-pr',
            `Write-capable step ${marker.id} has no later pr.prepare@1 step on this execution path`,
            ['root', 'executionPaths', pathIndex, marker.id],
          ),
        );
      }

      if (marker.reference === 'pr.prepare@1') {
        const nextReview = later.findIndex(
          (candidate) => candidate.kind === 'wait' && candidate.reference === 'code_review@1',
        );
        const beforeReview = nextReview < 0 ? later : later.slice(0, nextReview + 1);
        if (
          !beforeReview.some(
            (candidate) => candidate.kind === 'step' && candidate.reference === 'ci.observe@1',
          )
        ) {
          issues.push(
            issue(
              'pr-requires-ci-and-review',
              `Pull request step ${marker.id} has no later ci.observe@1 step`,
              ['root', 'executionPaths', pathIndex, marker.id],
            ),
          );
        }
        if (nextReview < 0) {
          issues.push(
            issue(
              'pr-requires-ci-and-review',
              `Pull request step ${marker.id} has no later code_review@1 wait`,
              ['root', 'executionPaths', pathIndex, marker.id],
            ),
          );
        }
        const observationIndex = beforeReview.findIndex(
          (candidate) => candidate.kind === 'step' && candidate.reference === 'ci.observe@1',
        );
        const passedAfterObservation = beforeReview.some(
          (candidate, candidateIndex) =>
            candidateIndex > observationIndex &&
            candidate.kind === 'predicate' &&
            candidate.reference === 'ci.passed@1',
        );
        if (observationIndex >= 0 && !passedAfterObservation) {
          issues.push(
            issue(
              'pr-requires-passed-ci',
              `Pull request step ${marker.id} can reach code review without proving ci.passed@1 after observation`,
              ['root', 'executionPaths', pathIndex, marker.id],
            ),
          );
        }
      }
    });
  });

  if (fixture.family === 'short_bugfix') {
    const reproductionPhases = paths
      .flat()
      .filter((marker) => marker.kind === 'step' && marker.reference === 'bug.validate_fix@1')
      .map(phaseOf);
    if (!reproductionPhases.includes('after')) {
      issues.push(
        issue(
          'bug-requires-after-evidence',
          'Bug workflow is missing bug.validate_fix@1 with phase=after',
          ['root'],
        ),
      );
    }
  }

  const applicablePolicies = policies.filter((policy) =>
    harnessPolicyAppliesToTask(policy, fixture),
  );
  const applicablePolicyIds = new Set(applicablePolicies.map(({ id }) => id));

  paths.flat().forEach((marker) => {
    if (marker.kind !== 'step') return;
    const owner = getHarnessPack().steps.find(
      ({ reference }) => reference === marker.reference,
    )?.policy;
    if (owner !== undefined && !applicablePolicyIds.has(owner)) {
      issues.push(
        issue(
          'policy-owned-step-not-applicable',
          `Step ${marker.reference} belongs to policy ${owner}, which does not apply to task origin ${fixture.origin}`,
          ['root', marker.id],
        ),
      );
    }
  });

  for (const policy of applicablePolicies) {
    for (const obligation of policy.obligations) {
      paths.forEach((path, pathIndex) => {
        const triggerPositions = path.flatMap((marker, markerIndex) =>
          markerMatches(marker, obligation.trigger) ? [markerIndex] : [],
        );
        for (const triggerPosition of triggerPositions) {
          let missing: (typeof obligation.ordered)[number] | undefined;
          if (obligation.direction === 'after') {
            let after = triggerPosition + 1;
            for (const required of obligation.ordered) {
              const match = path.findIndex(
                (marker, candidate) => candidate >= after && markerMatches(marker, required),
              );
              if (match < 0) {
                missing = required;
                break;
              }
              after = match + 1;
            }
          } else {
            let before = triggerPosition + 1;
            for (let index = obligation.ordered.length - 1; index >= 0; index -= 1) {
              const required = obligation.ordered[index];
              if (required === undefined) continue;
              let match = -1;
              for (let candidate = before - 1; candidate >= 0; candidate -= 1) {
                const marker = path[candidate];
                if (marker !== undefined && markerMatches(marker, required)) {
                  match = candidate;
                  break;
                }
              }
              if (match < 0) {
                missing = required;
                break;
              }
              before = match;
            }
          }
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
  }

  return { workflowId: graph.metadata.workflowId, issues };
};
