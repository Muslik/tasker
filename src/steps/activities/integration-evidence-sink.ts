import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import type {
  IntegrationEvidenceFile,
  IntegrationEvidenceSink,
} from '../../integrations/execution.js';
import type { TaskStepEvidenceStore } from './task-step-evidence.js';
import type { TaskStepFilesystemStore } from './task-step-filesystem.js';

const validRelativePath = (value: string): boolean =>
  value.length > 0 && !isAbsolute(value) && !value.split('/').includes('..');

export class TaskStepIntegrationEvidenceSink implements IntegrationEvidenceSink {
  public constructor(
    private readonly filesystem: TaskStepFilesystemStore,
    private readonly evidence: TaskStepEvidenceStore,
  ) {}

  public async persist(
    operationId: string,
    files: readonly IntegrationEvidenceFile[],
  ): Promise<
    | { readonly ok: true; readonly artifactIds: readonly string[] }
    | { readonly ok: false; readonly message: string }
  > {
    const invalid = files.find(({ relativePath }) => !validRelativePath(relativePath));
    if (invalid !== undefined) {
      return { ok: false, message: `Invalid integration evidence path ${invalid.relativePath}` };
    }
    const paths = await this.filesystem.prepare(operationId);
    for (const file of files) {
      const target = join(paths.artifactsPath, file.relativePath);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.bytes, { mode: 0o600 });
    }
    const registered = await this.evidence.register(operationId, paths.artifactsPath);
    return registered.ok
      ? { ok: true, artifactIds: registered.value }
      : { ok: false, message: `Evidence registration failed: ${registered.error.kind}` };
  }
}
