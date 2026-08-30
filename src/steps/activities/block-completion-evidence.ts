import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import type {
  BlockDefinition,
  CompletionEvidence,
  CompletionEvaluator,
} from '../../steps/index.js';
import { checksumString } from '../../store/checksum.js';
import type { WorkspaceLocator } from '../../workspace/contracts.js';
import type { TaskStepOutputArtifact } from '../task-step-output.js';
import type { WorkspaceMutationRecoveryStore } from './workspace-mutation-recovery.js';

export interface CompletionEvidenceCollection {
  readonly evidence: readonly CompletionEvidence[];
  readonly issues: readonly string[];
}

const outputFrom = (artifact: TaskStepOutputArtifact): unknown => {
  const details = artifact.details;
  return details !== null && !Array.isArray(details) && typeof details === 'object'
    ? details.output
    : undefined;
};

const externalIdFrom = (output: unknown): string | null =>
  output !== null &&
  !Array.isArray(output) &&
  typeof output === 'object' &&
  'externalId' in output &&
  typeof output.externalId === 'string' &&
  output.externalId.length > 0
    ? output.externalId
    : null;

const workspacePathsFrom = (output: unknown): readonly string[] => {
  if (output === null || typeof output !== 'object') return [];
  if (Array.isArray(output)) return output.flatMap(workspacePathsFrom);
  const record = output as Readonly<Record<string, unknown>>;
  return [
    ...(typeof record.path === 'string' ? [record.path] : []),
    ...(Array.isArray(record.artifacts)
      ? record.artifacts.filter((value): value is string => typeof value === 'string')
      : []),
    ...Object.values(record).flatMap(workspacePathsFrom),
  ];
};

const inside = (root: string, candidate: string): boolean => {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..');
};

const workspaceEvidenceHash = async (
  workspacePath: string,
  paths: readonly string[],
): Promise<{ readonly hash: string; readonly paths: readonly string[] } | null> => {
  const root = await realpath(workspacePath);
  const uniquePaths = [...new Set(paths)].sort();
  if (uniquePaths.length === 0) return null;
  const hash = createHash('sha256');
  for (const path of uniquePaths) {
    const candidate = resolve(root, path);
    if (!inside(root, candidate)) return null;
    const resolved = await realpath(candidate);
    if (!inside(root, resolved) || !(await stat(resolved)).isFile()) return null;
    hash
      .update(path)
      .update('\0')
      .update(await readFile(resolved))
      .update('\0');
  }
  return { hash: hash.digest('hex'), paths: uniquePaths };
};

const evaluators = (root: CompletionEvaluator): readonly CompletionEvaluator[] =>
  root.kind === 'all' ? root.evaluators.flatMap(evaluators) : [root];

export const collectBlockCompletionEvidence = async (
  input: {
    readonly operationId: string;
    readonly block: BlockDefinition;
    readonly workspace: WorkspaceLocator;
    readonly outputArtifact: TaskStepOutputArtifact;
  },
  dependencies: {
    readonly mutationRecovery: Pick<WorkspaceMutationRecoveryStore, 'inspectCompletion'>;
  },
): Promise<CompletionEvidenceCollection> => {
  const evidence: CompletionEvidence[] = [];
  const issues: string[] = [];
  const output = outputFrom(input.outputArtifact);

  for (const evaluator of evaluators(input.block.completion)) {
    switch (evaluator.kind) {
      case 'process_receipt':
        if (input.outputArtifact.runner === 'process' && input.outputArtifact.exitCode !== null) {
          evidence.push({
            kind: 'process',
            reference: `task-step-output:${input.operationId}:artifact`,
            exitCode: input.outputArtifact.exitCode,
            outputHash: checksumString(
              `${input.outputArtifact.stdout}\0${input.outputArtifact.stderr}`,
            ),
          });
        } else {
          issues.push('The process runner did not persist an exit-code receipt');
        }
        break;
      case 'workspace_mutation': {
        const inspected = await dependencies.mutationRecovery.inspectCompletion({
          operationId: input.operationId,
          workspaceId: input.workspace.workspaceId,
          workspacePath: input.workspace.path,
          stepReference: input.block.reference,
        });
        if (inspected.ok) {
          evidence.push({
            kind: 'workspace_mutation',
            reference: inspected.value.intentArtifactId,
            changed: inspected.value.changed,
            fingerprint: inspected.value.current.fingerprint,
            trackedDiffSha256: inspected.value.current.trackedDiffSha256,
            changedPaths: inspected.value.current.changedPaths,
            changedPathsTruncated: inspected.value.current.changedPathsTruncated,
          });
        } else {
          issues.push(`Workspace completion inspection failed: ${inspected.error.kind}`);
        }
        break;
      }
      case 'reconciled_effect': {
        const externalId = externalIdFrom(output);
        if (input.outputArtifact.runner === 'integration' && externalId !== null) {
          evidence.push({
            kind: 'effect',
            reference: `task-step-output:${input.operationId}:artifact`,
            reconciled: true,
            remoteIdentity: externalId,
          });
        } else {
          issues.push('The integration adapter did not persist a reconciled external identity');
        }
        break;
      }
      case 'structured_evidence':
        if (evaluator.source === 'task_output') {
          if (output === undefined) {
            issues.push('The block produced no validated structured output');
            break;
          }
          const contentHash = checksumString(JSON.stringify(output));
          for (const artifactKind of evaluator.requiredArtifactKinds) {
            evidence.push({
              kind: 'artifact',
              reference: `task-step-output:${input.operationId}:artifact#output`,
              artifactKind,
              contentHash,
            });
          }
          break;
        }
        try {
          const files = await workspaceEvidenceHash(
            input.workspace.path,
            workspacePathsFrom(output),
          );
          if (files === null) {
            issues.push('The block did not preserve readable evidence files inside the worktree');
            break;
          }
          for (const artifactKind of evaluator.requiredArtifactKinds) {
            evidence.push({
              kind: 'artifact',
              reference: `workspace-evidence:${input.operationId}:${files.paths.join(',')}`,
              artifactKind,
              contentHash: files.hash,
            });
          }
        } catch (error) {
          issues.push(
            `Workspace evidence cannot be read: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        }
        break;
      case 'all':
        break;
    }
  }

  return { evidence, issues };
};
