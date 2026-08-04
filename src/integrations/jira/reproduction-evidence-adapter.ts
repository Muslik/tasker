import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { reproductionOutputSchema } from '../../harness/step-definitions.js';
import { JsonValueSchema, type JsonValue } from '../../workflow/schema.js';
import type { ExternalEffectStore, ExternalEffectStoreError } from '../effects.js';
import type {
  IntegrationStepAdapter,
  IntegrationStepExecutionRequest,
  IntegrationStepExecutionResult,
} from '../execution.js';
import { JiraIssueKeySchema, type JiraIssueKey } from './contracts.js';
import type {
  JiraAttachmentMetadata,
  JiraAttachmentPort,
  JiraLifecycleProblem,
} from './lifecycle.js';

const JiraReproductionEvidencePolicySchema = z
  .object({
    provider: z.literal('jira'),
    phase: z.literal('before'),
    mediaKinds: z.array(z.enum(['video', 'image'])).min(1),
    maxAttachments: z.number().int().positive(),
    maxBytesPerAttachment: z.number().int().positive(),
  })
  .strict();

type BlockedIntegrationResult = Extract<
  IntegrationStepExecutionResult,
  { readonly status: 'blocked' }
>;

type LoadedEvidence = {
  readonly sourcePath: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly content: Uint8Array;
  readonly size: number;
  readonly sha256: string;
};

const blocked = (
  kind: BlockedIntegrationResult['kind'],
  summary: string,
  details: JsonValue,
  artifactIds: readonly string[] = [],
): BlockedIntegrationResult => ({ status: 'blocked', kind, summary, details, artifactIds });

const journalFailure = (
  error: ExternalEffectStoreError,
  artifactIds: readonly string[],
): BlockedIntegrationResult =>
  blocked(
    'unknown_outcome',
    `Jira reproduction-evidence journal is unavailable: ${error.kind}`,
    JsonValueSchema.parse(error),
    artifactIds,
  );

const problemResult = (
  problem: JiraLifecycleProblem,
  artifactIds: readonly string[],
  unknownOutcome = false,
): BlockedIntegrationResult =>
  blocked(
    unknownOutcome
      ? 'unknown_outcome'
      : problem.kind === 'access_blocked' || problem.kind === 'unavailable'
        ? 'infrastructure'
        : problem.kind === 'auth_failed'
          ? 'configuration'
          : 'invalid_request',
    problem.message,
    JsonValueSchema.parse(problem),
    artifactIds,
  );

const policyConfiguration = (request: IntegrationStepExecutionRequest) => {
  const policy = request.policies.find(({ id }) => id === 'jira-reproduction-evidence');
  return JiraReproductionEvidencePolicySchema.safeParse(policy?.configuration);
};

const beforeReproductionFrom = (request: IntegrationStepExecutionRequest) => {
  for (let index = request.evidence.completedSteps.length - 1; index >= 0; index -= 1) {
    const completed = request.evidence.completedSteps[index];
    if (completed?.stepReference !== 'bug.reproduce@1' || completed.status !== 'completed') {
      continue;
    }
    const parsed = z.object({ output: reproductionOutputSchema }).safeParse(completed.details);
    if (parsed.success && parsed.data.output.phase === 'before') return parsed.data.output;
  }
  return null;
};

const inside = (root: string, candidate: string): boolean => {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..');
};

const attachmentFilename = (sourcePath: string, sha256: string): string => {
  const sourceName = basename(sourcePath);
  const extension = extname(sourceName).toLowerCase();
  const rawStem = sourceName.slice(0, Math.max(0, sourceName.length - extension.length));
  const stem = rawStem.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return `${stem || 'reproduction'}-before-${sha256.slice(0, 12)}${extension}`;
};

const loadEvidence = async (
  workspacePath: string,
  sourcePath: string,
  mimeType: string,
  maxBytes: number,
): Promise<
  { readonly status: 'loaded'; readonly evidence: LoadedEvidence } | BlockedIntegrationResult
> => {
  try {
    const workspaceRoot = await realpath(workspacePath);
    const candidate = resolve(workspaceRoot, sourcePath);
    if (!inside(workspaceRoot, candidate)) {
      return blocked('verification', 'Reproduction evidence escapes the managed worktree', {
        sourcePath,
      });
    }
    const entry = await lstat(candidate);
    const resolved = await realpath(candidate);
    if (!inside(workspaceRoot, resolved)) {
      return blocked('verification', 'Reproduction evidence resolves outside the worktree', {
        sourcePath,
      });
    }
    const metadata = entry.isSymbolicLink() ? await stat(resolved) : entry;
    if (!metadata.isFile()) {
      return blocked('verification', 'Reproduction evidence is not a regular file', {
        sourcePath,
      });
    }
    if (metadata.size === 0 || metadata.size > maxBytes) {
      return blocked('verification', 'Reproduction evidence size is outside policy limits', {
        sourcePath,
        size: metadata.size,
        maxBytes,
      });
    }
    const content = await readFile(resolved);
    if (content.byteLength === 0 || content.byteLength > maxBytes) {
      return blocked('verification', 'Reproduction evidence size changed outside policy limits', {
        sourcePath,
        size: content.byteLength,
        maxBytes,
      });
    }
    const sha256 = createHash('sha256').update(content).digest('hex');
    return {
      status: 'loaded',
      evidence: {
        sourcePath,
        filename: attachmentFilename(sourcePath, sha256),
        mimeType,
        content,
        size: content.byteLength,
        sha256,
      },
    };
  } catch (error) {
    return blocked('verification', 'Reproduction evidence cannot be read from the worktree', {
      sourcePath,
      message: error instanceof Error ? error.message : 'unknown filesystem error',
    });
  }
};

const attachmentReceipt = (
  issueKey: JiraIssueKey,
  attachment: JiraAttachmentMetadata,
  evidence: LoadedEvidence,
): JsonValue => ({
  issueKey,
  attachmentId: attachment.id,
  filename: attachment.filename,
  size: attachment.size,
  sha256: evidence.sha256,
});

export class JiraReproductionEvidenceAdapter implements IntegrationStepAdapter {
  public readonly id = 'jira.attach-reproduction@1';

  public constructor(
    private readonly jira: JiraAttachmentPort,
    private readonly effects: ExternalEffectStore,
  ) {}

  public async execute(
    request: IntegrationStepExecutionRequest,
  ): Promise<IntegrationStepExecutionResult> {
    const configured = policyConfiguration(request);
    if (!configured.success) {
      return blocked('configuration', 'Jira reproduction-evidence policy is missing or invalid', {
        issues: configured.error.issues.map((issue) => issue.message),
      });
    }
    if (request.task.origin !== 'jira') {
      return blocked('invalid_request', 'Jira evidence cannot run for a non-Jira task', {
        taskOrigin: request.task.origin,
      });
    }
    const issueKey = JiraIssueKeySchema.safeParse(request.task.taskId);
    if (!issueKey.success) {
      return blocked('invalid_request', 'Task does not carry a valid Jira issue key', {
        taskId: request.task.taskId,
      });
    }
    const reproduction = beforeReproductionFrom(request);
    if (reproduction === null) {
      return blocked('verification', 'Successful before-reproduction evidence is missing', {
        taskId: request.task.taskId,
      });
    }

    const selected = reproduction.evidence
      .filter(
        (evidence): evidence is typeof evidence & { readonly kind: 'video' | 'image' } =>
          evidence.kind !== 'log' && configured.data.mediaKinds.includes(evidence.kind),
      )
      .slice(0, configured.data.maxAttachments);
    if (selected.length === 0) {
      return {
        status: 'completed',
        summary: `Jira ${issueKey.data} has no policy-selected before media to attach`,
        output: { externalId: issueKey.data, status: 'no_media' },
        artifactIds: [],
      };
    }

    const artifactIds: string[] = [];
    let attached = 0;
    const seenFilenames = new Set<string>();
    for (const evidence of selected) {
      const loaded = await loadEvidence(
        request.workspace.path,
        evidence.path,
        evidence.mimeType,
        configured.data.maxBytesPerAttachment,
      );
      if (loaded.status === 'blocked') return { ...loaded, artifactIds };
      if (seenFilenames.has(loaded.evidence.filename)) continue;
      seenFilenames.add(loaded.evidence.filename);
      const result = await this.ensureAttachment(
        request,
        issueKey.data,
        loaded.evidence,
        artifactIds,
      );
      if (result.status === 'blocked') return result;
      attached += 1;
    }

    return {
      status: 'completed',
      summary: `Jira ${issueKey.data} contains ${String(attached)} before-reproduction attachment${attached === 1 ? '' : 's'}`,
      output: { externalId: issueKey.data, status: `attached:${String(attached)}` },
      artifactIds,
    };
  }

  private async ensureAttachment(
    request: IntegrationStepExecutionRequest,
    issueKey: JiraIssueKey,
    evidence: LoadedEvidence,
    artifactIds: string[],
  ): Promise<{ readonly status: 'attached' } | BlockedIntegrationResult> {
    const effectId = `attachment-${createHash('sha256')
      .update(`${evidence.filename}:${evidence.sha256}`)
      .digest('hex')
      .slice(0, 16)}`;
    const prepared = this.effects.prepare({
      operationId: request.operationId,
      effectId,
      effectKind: 'jira.issue.attachment',
      identity: {
        issueKey,
        filename: evidence.filename,
        mimeType: evidence.mimeType,
        size: evidence.size,
        sha256: evidence.sha256,
      },
    });
    if (!prepared.ok) return journalFailure(prepared.error, artifactIds);
    artifactIds.push(this.effects.intentArtifactId(request.operationId, effectId));
    const receipt = this.effects.readReceipt(request.operationId, effectId);
    if (!receipt.ok) return journalFailure(receipt.error, artifactIds);

    const before = await this.jira.listAttachments(issueKey);
    if (before.status === 'failed') {
      return problemResult(before.problem, artifactIds, receipt.value !== null);
    }
    const sameName = before.attachments.filter(
      (attachment) => attachment.filename === evidence.filename,
    );
    let confirmed = sameName.find((attachment) => attachment.size === evidence.size);
    if (sameName.length > 0 && confirmed === undefined) {
      return blocked(
        'remote_conflict',
        'Jira contains a different attachment under the deterministic evidence name',
        { issueKey, filename: evidence.filename, expectedSize: evidence.size },
        artifactIds,
      );
    }
    if (receipt.value !== null) {
      if (confirmed === undefined) {
        return blocked(
          'remote_conflict',
          'The Jira attachment no longer matches its recorded receipt',
          { issueKey, filename: evidence.filename },
          artifactIds,
        );
      }
      artifactIds.push(this.effects.receiptArtifactId(request.operationId, effectId));
      return { status: 'attached' };
    }

    if (confirmed === undefined) {
      const mutation = await this.jira.uploadAttachment(issueKey, {
        filename: evidence.filename,
        mimeType: evidence.mimeType,
        content: evidence.content,
      });
      if (
        mutation.status === 'failed' &&
        mutation.problem.kind !== 'unavailable' &&
        mutation.problem.kind !== 'invalid_response'
      ) {
        return problemResult(mutation.problem, artifactIds);
      }
      const after = await this.jira.listAttachments(issueKey);
      if (after.status === 'failed') return problemResult(after.problem, artifactIds, true);
      confirmed = after.attachments.find(
        (attachment) =>
          attachment.filename === evidence.filename && attachment.size === evidence.size,
      );
      if (confirmed === undefined) {
        return mutation.status === 'failed'
          ? problemResult(mutation.problem, artifactIds, true)
          : blocked(
              'unknown_outcome',
              'Jira accepted the reproduction attachment but it could not be confirmed',
              { issueKey, filename: evidence.filename },
              artifactIds,
            );
      }
    }

    const applied = this.effects.recordApplied({
      operationId: request.operationId,
      effectId,
      effectKind: 'jira.issue.attachment',
      result: attachmentReceipt(issueKey, confirmed, evidence),
    });
    if (!applied.ok) return journalFailure(applied.error, artifactIds);
    artifactIds.push(this.effects.receiptArtifactId(request.operationId, effectId));
    return { status: 'attached' };
  }
}
