import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import type { LedgerRepository } from '../../ledger/repository.js';
import type { Clock } from '../../shared/clock.js';
import { err, ok, type Outcome } from '../../shared/outcome.js';

const MAX_EVIDENCE_FILES = 100;
const MAX_EVIDENCE_FILE_BYTES = 50 * 1024 * 1024;

export const TaskStepEvidenceArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.string().min(1),
    relativePath: z.string().min(1),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    byteLength: z.number().int().nonnegative(),
    mimeType: z.string().min(1),
    recordedAt: z.iso.datetime(),
  })
  .strict();

export type TaskStepEvidenceArtifact = z.infer<typeof TaskStepEvidenceArtifactSchema>;

export type TaskStepEvidenceError =
  | { readonly kind: 'artifact_conflict'; readonly artifactId: string }
  | { readonly kind: 'file_limit_exceeded'; readonly maximum: number }
  | {
      readonly kind: 'file_too_large';
      readonly relativePath: string;
      readonly maximumBytes: number;
    }
  | { readonly kind: 'invalid_entry'; readonly relativePath: string }
  | { readonly kind: 'root_unavailable'; readonly message: string };

const inside = (root: string, candidate: string): boolean => {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..');
};

const normalizePaths = (value: unknown, root: string): unknown => {
  if (Array.isArray(value)) return value.map((item) => normalizePaths(item, root));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === 'path' && typeof child === 'string' && isAbsolute(child)) {
        const candidate = resolve(child);
        if (inside(root, candidate)) return [key, relative(root, candidate).split(sep).join('/')];
      }
      return [key, normalizePaths(child, root)];
    }),
  );
};

export const normalizeTaskStepEvidencePaths = (value: unknown, artifactsPath: string): unknown => {
  if (value === null || typeof value !== 'object' || !('outputJson' in value)) return value;
  const outputJson = value.outputJson;
  if (typeof outputJson !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(outputJson);
    return {
      ...value,
      outputJson: JSON.stringify(normalizePaths(parsed, resolve(artifactsPath))),
    };
  } catch {
    return value;
  }
};

const mimeTypeFor = (path: string): string => {
  switch (extname(path).toLowerCase()) {
    case '.json':
      return 'application/json';
    case '.log':
    case '.md':
    case '.txt':
      return 'text/plain';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    default:
      return 'application/octet-stream';
  }
};

const listFiles = async (
  root: string,
): Promise<Outcome<readonly string[], TaskStepEvidenceError>> => {
  const files: string[] = [];
  const visit = async (current: string): Promise<TaskStepEvidenceError | null> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const relativePath = relative(root, path).split(sep).join('/');
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) return { kind: 'invalid_entry', relativePath };
      if (metadata.isDirectory()) {
        const nested = await visit(path);
        if (nested !== null) return nested;
        continue;
      }
      if (!metadata.isFile()) return { kind: 'invalid_entry', relativePath };
      files.push(path);
      if (files.length > MAX_EVIDENCE_FILES) {
        return { kind: 'file_limit_exceeded', maximum: MAX_EVIDENCE_FILES };
      }
    }
    return null;
  };
  const failure = await visit(root);
  return failure === null ? ok(files.sort()) : err(failure);
};

export class TaskStepEvidenceStore {
  public constructor(
    private readonly ledger: LedgerRepository,
    private readonly clock: Clock,
  ) {}

  public async register(
    operationId: string,
    artifactsPath: string,
  ): Promise<Outcome<readonly string[], TaskStepEvidenceError>> {
    let root: string;
    try {
      root = await realpath(resolve(artifactsPath));
    } catch (error) {
      return err({
        kind: 'root_unavailable',
        message: error instanceof Error ? error.message : 'unknown filesystem error',
      });
    }
    const listed = await listFiles(root);
    if (!listed.ok) return listed;

    const artifactIds: string[] = [];
    for (const path of listed.value) {
      const resolved = await realpath(path);
      const relativePath = relative(root, resolved).split(sep).join('/');
      if (!inside(root, resolved)) return err({ kind: 'invalid_entry', relativePath });
      const file = await stat(resolved);
      if (file.size > MAX_EVIDENCE_FILE_BYTES) {
        return err({
          kind: 'file_too_large',
          relativePath,
          maximumBytes: MAX_EVIDENCE_FILE_BYTES,
        });
      }
      const bytes = await readFile(resolved);
      const contentSha256 = createHash('sha256').update(bytes).digest('hex');
      const identity = createHash('sha256')
        .update(operationId)
        .update('\0')
        .update(relativePath)
        .update('\0')
        .update(contentSha256)
        .digest('hex');
      const artifactId = `task-step-evidence:${identity}`;
      const recordedAt = this.clock.now();
      const payload = TaskStepEvidenceArtifactSchema.parse({
        schemaVersion: 1,
        operationId,
        relativePath,
        contentSha256,
        byteLength: bytes.byteLength,
        mimeType: mimeTypeFor(relativePath),
        recordedAt,
      });
      const existing = this.ledger.readArtifact(artifactId);
      if (existing === null) {
        const persisted = this.ledger.transact({
          artifacts: [
            {
              artifactId,
              artifactKind: 'task_step_evidence',
              storageUri: pathToFileURL(resolved).href,
              payload,
              metadata: { operationId, relativePath, contentSha256 },
              createdAt: recordedAt,
            },
          ],
          timestamp: recordedAt,
        });
        if (!persisted.ok) return err({ kind: 'artifact_conflict', artifactId });
      } else {
        const parsed = TaskStepEvidenceArtifactSchema.safeParse(existing.payload);
        if (!parsed.success || parsed.data.contentSha256 !== contentSha256) {
          return err({ kind: 'artifact_conflict', artifactId });
        }
      }
      artifactIds.push(artifactId);
    }
    return ok(artifactIds);
  }
}
