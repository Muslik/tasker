import type { TaskFixture } from './fixtures.js';
import { M1_WORKFLOW_CONTRACTS } from './contracts.js';
import { getHarnessPack, type HarnessPolicyManifest } from '../harness/index.js';
import type {
  CompiledWorkflow,
  CompiledWorkflowNode,
  JsonValue,
  ValidationIssue,
  ValidationReport,
} from '../workflow/index.js';

export const WORKFLOW_OBLIGATIONS = [
  {
    id: 'planning-boundary',
    trigger: 'every task',
    requires: ['task.analyze@1 immediately followed by the plan.approved@1 gate'],
    reason: 'Planning is mandatory even when human approval is disabled for the run.',
  },
  {
    id: 'write-requires-verification',
    trigger: 'a path contains a workspace.write step',
    requires: ['a verify.* step later on the same path'],
    reason: 'A write-capable path cannot become reviewable without task-selected verification.',
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
    id: 'bug-requires-before-and-after-evidence',
    trigger: 'the admitted task is a bug',
    requires: ['bug.reproduce@1 phase=before', 'bug.reproduce@1 phase=after'],
    reason: 'A bug fix needs evidence that the reported behavior existed and no longer exists.',
  },
] as const;

interface ExecutionMarker {
  readonly id: string;
  readonly kind: 'gate' | 'step' | 'wait';
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
      return [...executionPaths(node.then), ...executionPaths(node.otherwise)];
    case 'bounded_loop':
      return executionPaths(node.body);
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
          (candidate) => candidate.kind === 'step' && candidate.reference.startsWith('verify.'),
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
      }
    });
  });

  if (fixture.family === 'short_bugfix') {
    const reproductionPhases = paths
      .flat()
      .filter((marker) => marker.kind === 'step' && marker.reference === 'bug.reproduce@1')
      .map(phaseOf);
    for (const phase of ['before', 'after'] as const) {
      if (!reproductionPhases.includes(phase)) {
        issues.push(
          issue(
            'bug-requires-before-and-after-evidence',
            `Bug workflow is missing bug.reproduce@1 with phase=${phase}`,
            ['root'],
          ),
        );
      }
    }
  }

  for (const policy of policies) {
    for (const obligation of policy.obligations) {
      paths.forEach((path, pathIndex) => {
        const triggerPositions = path.flatMap((marker, markerIndex) =>
          marker.kind === obligation.trigger.kind &&
          marker.reference === obligation.trigger.reference
            ? [markerIndex]
            : [],
        );
        for (const triggerPosition of triggerPositions) {
          let missing: (typeof obligation.ordered)[number] | undefined;
          if (obligation.direction === 'after') {
            let after = triggerPosition + 1;
            for (const required of obligation.ordered) {
              const match = path.findIndex(
                (marker, candidate) =>
                  candidate >= after &&
                  marker.kind === required.kind &&
                  marker.reference === required.reference,
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
                if (
                  marker !== undefined &&
                  marker.kind === required.kind &&
                  marker.reference === required.reference
                ) {
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
